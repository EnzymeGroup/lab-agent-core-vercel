import { tool } from 'ai';
import { z } from 'zod';
import type { Workspace } from '../workspace/workspace.js';

/**
 * findFiles (by name) and searchFiles (by content): recursive walks through the
 * Workspace, so every directory and file passes the same policy as listFiles and
 * readFile. Secrets, metadata and paths outside readRoots never appear. Pure JS: no
 * ripgrep binary is required and nothing reads a file the policy would refuse.
 */

const SKIP_DIRECTORIES = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.next', '.cache', '.tox']);
const MAX_ENTRIES = 20_000;
const MAX_SEARCH_FILE_BYTES = 1_048_576;
const MAX_LINE_CHARS = 2_000;
const MAX_SHOWN_CHARS = 300;

/** Glob → RegExp: ** any depth, * and ? within one segment, {a,b} alternatives. */
export function globPattern(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { source += '\\{'; continue; }
      source += `(?:${glob.slice(i + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|')})`;
      i = end;
    } else source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

/** A glob without "/" matches file names; with "/" it matches the path below the search directory. */
function globMatcher(glob: string | undefined, base: string): (file: string) => boolean {
  if (!glob) return () => true;
  const pattern = globPattern(glob);
  const prefix = base === '.' || base === '' ? '' : `${base.replace(/\/+$/u, '')}/`;
  return glob.includes('/')
    ? file => pattern.test(file.startsWith(prefix) ? file.slice(prefix.length) : file)
    : file => pattern.test(file.slice(file.lastIndexOf('/') + 1));
}

/** Breadth-first, sorted, symlinks not followed. Unreadable directories are skipped. */
async function* walk(workspace: Workspace, directory: string, state: { visited: number; truncated: boolean }, signal?: AbortSignal): AsyncGenerator<string> {
  const queue = [directory];
  while (queue.length) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    let entries;
    try {
      entries = await workspace.list(current);
    } catch (error) {
      if (current === directory) throw error;
      continue;
    }
    for (const entry of entries) {
      if (++state.visited > MAX_ENTRIES) { state.truncated = true; return; }
      if (entry.type === 'directory') {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(entry.path);
      } else if (entry.type === 'file') yield entry.path;
    }
  }
}

const shown = (line: string) => line.length > MAX_SHOWN_CHARS ? `${line.slice(0, MAX_SHOWN_CHARS)}…` : line;

export function searchTools(workspace: Workspace) {
  return {
    findFiles: tool({
      description: `Find allowed project files by glob, recursively ("*.csv", "**/test_*.py", "data/**/*.{tsv,csv}"). A pattern without "/" matches file names. Skips ${[...SKIP_DIRECTORIES].join(', ')}; secrets and metadata never appear.`,
      inputSchema: z.object({
        pattern: z.string().min(1).max(300),
        path: z.string().default('.'),
        limit: z.number().int().min(1).max(1_000).default(200),
      }),
      execute: async ({ pattern, path, limit }, { abortSignal }) => {
        const matches = globMatcher(pattern, path);
        const state = { visited: 0, truncated: false };
        const files: string[] = [];
        for await (const file of walk(workspace, path, state, abortSignal)) {
          if (!matches(file)) continue;
          if (files.length >= limit) { state.truncated = true; break; }
          files.push(file);
        }
        return { files, truncated: state.truncated };
      },
    }),
    searchFiles: tool({
      description: 'Search allowed project text files for a regular expression (JavaScript syntax), recursively. Returns path, line number and the matching line. Narrow with path and glob. Binary files and files over 1 MiB are skipped and counted.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(500),
        path: z.string().default('.'),
        glob: z.string().max(300).optional(),
        ignoreCase: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ pattern, path, glob, ignoreCase, limit }, { abortSignal }) => {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, ignoreCase ? 'i' : '');
        } catch (error) {
          throw new Error(`Invalid regular expression: ${(error as Error).message}`);
        }
        const matches = globMatcher(glob, path);
        const state = { visited: 0, truncated: false };
        const results: { path: string; line: number; text: string }[] = [];
        const skipped = { binary: 0, tooLarge: 0, unreadable: 0 };
        let filesSearched = 0;
        search: for await (const file of walk(workspace, path, state, abortSignal)) {
          if (!matches(file)) continue;
          let text: string;
          try {
            text = await workspace.read(file, MAX_SEARCH_FILE_BYTES);
          } catch (error) {
            if (/exceeds/u.test((error as Error).message)) skipped.tooLarge++;
            else skipped.unreadable++;
            continue;
          }
          if (text.includes('\0')) { skipped.binary++; continue; }
          filesSearched++;
          const lines = text.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index++) {
            // Lines are clipped before matching, which bounds the cost of each test.
            const line = lines[index].slice(0, MAX_LINE_CHARS);
            if (!regex.test(line)) continue;
            if (results.length >= limit) { state.truncated = true; break search; }
            results.push({ path: file, line: index + 1, text: shown(line.trim()) });
          }
        }
        return { matches: results, filesSearched, skipped, truncated: state.truncated };
      },
    }),
  };
}

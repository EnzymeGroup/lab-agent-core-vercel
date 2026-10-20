import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { getExecutionContext, isSensitiveName, runCommand, sha256, type FileAccessPolicy, type Workspace } from 'lab-agent-core-vercel';
import { lazyWorkspace, serialQueue } from './shared.js';

/**
 * Coding tools. Not part of Core's "trusted code only" model: shell runs commands the model
 * writes. Every tool that changes something declares needsApproval, so each call waits for a
 * person (unless they choose "Always allow"), and helpers never receive these tools.
 *
 *   editFile / undoEdit   exact-text replacement through Core's write policy, with an undo log
 *   gitStatus / gitDiff   read-only; no external diff, textconv or fsmonitor programs run
 *   shell                 bash inside a bubblewrap sandbox: no network, read-only system,
 *                         the project writable, home, secrets, .lab-agent/ and runs/ protected
 */

export interface ShellOptions {
  /** 'bwrap' (default) isolates the command; 'none' runs it directly with your account. */
  sandbox?: 'bwrap' | 'none';
  /** Allow network access inside the sandbox. Default false. */
  network?: boolean;
  /** Directories hidden inside the sandbox (an empty tmpfs). Default your home directory. */
  hide?: string[];
  /** Absolute paths shown read-only even inside a hidden directory, e.g. a conda install. */
  readOnly?: string[];
  /** PATH inside the command. Default the current PATH. */
  path?: string;
  /** Extra environment variables. The rest of the environment is not passed in. */
  env?: Record<string, string>;
  /** Longest allowed command. Default 600 s. */
  maxTimeoutSeconds?: number;
  /** Characters of stdout and stderr returned (the end is kept). Default 16000 each. */
  maxChars?: number;
}

export interface CodingToolOptions {
  /** Project root (config.root). */
  root: string;
  /** The same policy as config.fileAccess. Edits need mode 'development' with writeRoots. */
  fileAccess?: FileAccessPolicy;
  /** Shell settings, or false for no shell tool. */
  shell?: ShellOptions | false;
  /** gitStatus and gitDiff. Default true. */
  git?: boolean;
}

interface EditRecord { id: string; path: string; before: string | null; afterSha256: string; at: string; runId?: string }

// Edit ids sort in the order the edits were made, also within one millisecond.
let sequence = 0;
const editId = () => `${Date.now().toString(36).padStart(9, '0')}${(sequence++ % 1_679_616).toString(36).padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
// Not walked: dependencies, caches, and paths the sandbox already handles (.lab-agent hidden, runs read-only).
// .git itself stays visible so the shell can run git; its credentials files are still matched by name.
const SKIP_DIR = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.lab-agent', 'runs']);

const occurrences = (text: string, search: string) => {
  let count = 0;
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) count++;
  return count;
};

/** One hunk: the lines between the common prefix and suffix, clipped. */
export function lineDiff(before: string, after: string, context = 3, maxLines = 80): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const from = Math.max(0, start - context);
  const lines = [`@@ -${from + 1} +${from + 1} @@`];
  for (let index = from; index < start; index++) lines.push(` ${a[index]}`);
  for (let index = start; index < a.length - end; index++) lines.push(`-${a[index]}`);
  for (let index = start; index < b.length - end; index++) lines.push(`+${b[index]}`);
  for (let index = a.length - end; index < Math.min(a.length, a.length - end + context); index++) lines.push(` ${a[index]}`);
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more diff lines`].join('\n') : lines.join('\n');
}

const tail = (text: string, max: number) => text.length > max ? `[… ${text.length - max} earlier characters]\n${text.slice(-max)}` : text;

/** Sensitive files and directories under root, for masking inside the sandbox. */
async function sensitivePaths(root: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let seen = 0;
  const visit = async (directory: string, depth: number) => {
    if (depth > 6 || seen > 20_000) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      seen++;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) continue;
        if (isSensitiveName(entry.name)) dirs.push(path);
        else await visit(path, depth + 1);
      } else if (entry.isFile() && isSensitiveName(entry.name)) {
        files.push(path);
      }
    }
  };
  await visit(root, 0);
  return { files, dirs };
}

export function codingTools(options: CodingToolOptions): ToolSet {
  const files = lazyWorkspace(options.root, options.fileAccess);
  const tools: ToolSet = {};
  // Tool calls of one step run concurrently; edits and undos run one at a time so none is lost.
  const queue = serialQueue();
  const serial = <T>(work: () => Promise<T>) => queue('edits', work);

  // ─── Edits and undo ───────────────────────────────────────────────────────

  const editsDir = async () => {
    const root = await realpath(resolve(options.root));
    const directory = join(root, '.lab-agent', 'extras', 'edits');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  };
  const listEdits = async (): Promise<EditRecord[]> => {
    const directory = await editsDir();
    const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort().reverse();
    return Promise.all(names.slice(0, 200).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as EditRecord));
  };
  const readCurrent = async (workspace: Workspace, path: string): Promise<string | null> => {
    try {
      return await workspace.read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  tools.editFile = tool({
    description: 'Edit a project file by exact text replacement. oldText must appear exactly once (or set replaceAll); copy it verbatim, including indentation. An empty oldText creates a new file. Returns a diff and an editId for undoEdit. Writes follow the project file policy (task output, or development writeRoots).',
    inputSchema: z.object({
      path: z.string().min(1).max(1024),
      oldText: z.string().max(200_000),
      newText: z.string().max(400_000),
      replaceAll: z.boolean().default(false),
    }),
    needsApproval: true,
    execute: ({ path, oldText, newText, replaceAll }) => serial(async () => {
      const workspace = await files();
      const before = await readCurrent(workspace, path);
      let after: string;
      let replacements: number;
      if (oldText === '') {
        if (before !== null) throw new Error(`${path} exists. Give the exact oldText to replace; an empty oldText only creates new files.`);
        after = newText;
        replacements = 0;
      } else {
        if (before === null) throw new Error(`${path} does not exist.`);
        const count = occurrences(before, oldText);
        if (!count) throw new Error(`oldText was not found in ${path}. Read the file again and copy the text exactly, including whitespace.`);
        if (count > 1 && !replaceAll) throw new Error(`oldText appears ${count} times in ${path}. Include more surrounding lines to make it unique, or set replaceAll.`);
        after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
        replacements = replaceAll ? count : 1;
      }
      if (after === before) throw new Error('The edit changes nothing.');
      const directory = await editsDir();
      const runId = getExecutionContext()?.runId;
      const record: EditRecord = { id: editId(), path, before, afterSha256: sha256(after), at: new Date().toISOString(), ...(runId ? { runId } : {}) };
      const file = join(directory, `${record.id}.json`);
      await writeFile(file, JSON.stringify(record), { mode: 0o600 });
      try {
        await workspace.write(path, after);
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
      return { path, editId: record.id, created: before === null, replacements, bytes: Buffer.byteLength(after), diff: lineDiff(before ?? '', after) };
    }),
  });

  tools.undoEdit = tool({
    description: 'Undo editFile changes, newest first: the last `count` edits, or one editId. An edit is undone only if the file is unchanged since; otherwise inspect it with gitDiff. Files created by editFile are deleted again. Shell changes are not covered.',
    inputSchema: z.object({
      editId: z.string().regex(/^[a-z0-9]{13}-[a-f0-9]{8}$/u).optional(),
      count: z.number().int().min(1).max(20).default(1),
    }),
    needsApproval: true,
    execute: ({ editId: id, count }) => serial(async () => {
      const workspace = await files();
      const directory = await editsDir();
      const all = await listEdits();
      const chosen = id ? all.filter(edit => edit.id === id) : all.slice(0, count);
      if (!chosen.length) throw new Error(id ? `No edit ${id}.` : 'There is nothing to undo.');
      const undone = [];
      for (const edit of chosen) {
        const current = await readCurrent(workspace, edit.path);
        if (current === null || sha256(current) !== edit.afterSha256) {
          throw new Error(`${edit.path} changed after edit ${edit.id}; nothing more was undone. Undone so far: ${undone.map(item => item.editId).join(', ') || 'none'}.`);
        }
        if (edit.before === null) await rm(await workspace.resolve(edit.path, { write: true }));
        else await workspace.write(edit.path, edit.before);
        await rm(join(directory, `${edit.id}.json`), { force: true });
        undone.push({ editId: edit.id, path: edit.path, ...(edit.before === null ? { deleted: true } : {}) });
      }
      return { undone };
    }),
  });

  // ─── Git (read-only) ──────────────────────────────────────────────────────

  if (options.git !== false) {
    // Configuration a repository can set to run programs during status or diff is switched off.
    const git = (args: string[], signal?: AbortSignal) => runCommand('git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.quotepath=off', ...args,
    ], { cwd: options.root, signal, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, env: { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    const hidden = [':(exclude,glob)**/.env*', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key', ':(exclude,glob)**/id_rsa*', ':(exclude,glob)**/id_ed25519*', ':(exclude,glob).lab-agent/**'];
    const checked = async (result: Awaited<ReturnType<typeof git>>) => {
      if (result.code !== 0) throw new Error(`git failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`);
      return result.stdout;
    };

    tools.gitStatus = tool({
      description: 'git status of the project: branch and changed, staged and untracked files.',
      inputSchema: z.object({}),
      async execute(_input, { abortSignal }) {
        const text = await checked(await git(['status', '--porcelain=v1', '--branch', '--untracked-files=normal', '--', '.', ...hidden], abortSignal));
        const [branch, ...changes] = text.split('\n').filter(Boolean);
        return { branch: branch?.replace(/^## /u, ''), changes: changes.slice(0, 500), ...(changes.length > 500 ? { truncated: true } : {}) };
      },
    });

    tools.gitDiff = tool({
      description: 'git diff of the project (or one path): unstaged changes, or staged ones. Secret files and .lab-agent/ are left out.',
      inputSchema: z.object({
        path: z.string().min(1).max(1024).optional(),
        staged: z.boolean().default(false),
      }),
      async execute({ path, staged }, { abortSignal }) {
        if (path) await (await files()).resolve(path);
        // A literal pathspec, so a path such as ":(exclude)…" is not read as git pathspec magic.
        const text = await checked(await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', path ? `:(literal)${path}` : '.', ...hidden], abortSignal));
        const max = 40_000;
        return { diff: text.slice(0, max), ...(text.length > max ? { truncated: true, totalChars: text.length } : {}), ...(text ? {} : { note: 'No changes.' }) };
      },
    });
  }

  // ─── Shell ────────────────────────────────────────────────────────────────

  if (options.shell !== false) {
    const shell = options.shell ?? {};
    const sandbox = shell.sandbox ?? 'bwrap';
    const maxTimeout = shell.maxTimeoutSeconds ?? 600;
    const maxChars = shell.maxChars ?? 16_000;
    for (const path of [...(shell.hide ?? []), ...(shell.readOnly ?? [])]) if (!isAbsolute(path)) throw new Error(`shell paths must be absolute: ${path}`);
    let bwrapChecked: Promise<void> | undefined;

    const sandboxArgs = async (root: string, env: Record<string, string>) => {
      bwrapChecked ??= runCommand('bwrap', ['--version'], { cwd: root, timeoutMs: 10_000 }).then(
        result => { if (result.code !== 0) throw new Error('bwrap --version failed.'); },
        () => { throw new Error('bubblewrap (bwrap) is not installed. Install it, or pass shell: { sandbox: "none" } to run commands without isolation.'); },
      );
      await bwrapChecked;
      const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', ...(shell.network ? [] : ['--unshare-net']),
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
      for (const hidden of shell.hide ?? [homedir()]) args.push('--tmpfs', hidden);
      for (const path of shell.readOnly ?? []) args.push('--ro-bind-try', path, path);
      args.push('--bind', root, root);
      // Inside the project: Core's metadata is hidden, run records are read-only, secrets are blank.
      args.push('--tmpfs', join(root, '.lab-agent'));
      if (await lstat(join(root, 'runs')).then(info => info.isDirectory(), () => false)) args.push('--ro-bind', join(root, 'runs'), join(root, 'runs'));
      const secret = await sensitivePaths(root);
      for (const dir of secret.dirs) args.push('--tmpfs', dir);
      for (const file of secret.files) args.push('--ro-bind', '/dev/null', file);
      args.push('--chdir', root, '--clearenv');
      for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
      return args;
    };

    tools.shell = tool({
      description: `Run a bash command in the project directory${sandbox === 'bwrap' ? ` inside a sandbox: ${shell.network ? 'network allowed' : 'no network'}, system files read-only, the project writable, the home directory, secrets, .lab-agent/ and runs/ unavailable or read-only` : ' WITHOUT a sandbox, with the user\'s account'}. Use it to run tests, builds, linters and git. Returns the exit code and the end of stdout and stderr. Prefer editFile for changing files.`,
      inputSchema: z.object({
        command: z.string().min(1).max(20_000),
        timeoutSeconds: z.number().int().min(1).max(maxTimeout).default(Math.min(120, maxTimeout)),
      }),
      needsApproval: true,
      async execute({ command, timeoutSeconds }, { abortSignal }) {
        const root = await realpath(resolve(options.root));
        // HOME stays the usual path; by default it is an empty tmpfs inside the sandbox.
        const env: Record<string, string> = { PATH: shell.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8', TERM: 'dumb', CI: '1', ...shell.env };
        // Without a sandbox, only these variables reach the command (spawn drops undefined values).
        const only: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...env };
        const argv = ['--noprofile', '--norc', '-c', command];
        const started = Date.now();
        try {
          const result = sandbox === 'bwrap'
            ? await runCommand('bwrap', [...await sandboxArgs(root, env), 'bash', ...argv], { cwd: root, env: { PATH: env.PATH }, signal: abortSignal, timeoutMs: timeoutSeconds * 1000, maxOutputBytes: 2 * 1024 * 1024 })
            : await runCommand('bash', argv, { cwd: root, env: only, signal: abortSignal, timeoutMs: timeoutSeconds * 1000, maxOutputBytes: 2 * 1024 * 1024 });
          return { exitCode: result.code, stdout: tail(result.stdout, maxChars), stderr: tail(result.stderr, maxChars), durationMs: Date.now() - started, sandbox };
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          if (failure.name !== 'CommandTimeoutError' && failure.name !== 'OutputLimitError') throw error;
          return {
            exitCode: null, ...(failure.name === 'CommandTimeoutError' ? { timedOut: true } : { outputLimit: true }),
            stdout: tail(failure.stdout ?? '', maxChars), stderr: tail(failure.stderr ?? '', maxChars), durationMs: Date.now() - started, sandbox,
            note: failure.name === 'CommandTimeoutError' ? `Stopped after ${timeoutSeconds} s.` : 'Stopped: output exceeded 2 MiB.',
          };
        }
      },
    });
  }

  return tools;
}

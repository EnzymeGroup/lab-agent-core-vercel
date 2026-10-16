import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface ExecutionContext {
  outputDirectory?: string;
  runId?: string;
  signal?: AbortSignal;
}
const execution = new AsyncLocalStorage<ExecutionContext>();
export function getExecutionContext(): ExecutionContext | undefined { return execution.getStore(); }
export function runWithExecutionContext<T>(context: ExecutionContext, callback: () => T): T { return execution.run(context, callback); }

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}
export interface Workspace {
  root: string;
  resolve(file: string, options?: { write?: boolean; internal?: boolean }): Promise<string>;
  read(file: string, maxBytes?: number): Promise<string>;
  write(file: string, content: string): Promise<void>;
  list(directory?: string): Promise<WorkspaceEntry[]>;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function protectWrite(root: string, candidate: string): void {
  const parts = path.relative(root, candidate).split(path.sep);
  if (parts[0] === '.lab-agent') throw new Error('Agent metadata is read-only to file tools.');
  if (parts[0] === 'runs' && (parts.length < 4 || parts[2] !== 'output')) {
    throw new Error('File tools may write inside runs/<id>/output only.');
  }
}
async function canonicalCandidate(candidate: string): Promise<string> {
  const missing: string[] = [];
  let existing = candidate;
  for (;;) {
    try { return path.resolve(await realpath(existing), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Canonical path confinement is a file-tool boundary, not a code sandbox. */
export async function createWorkspace(root: string): Promise<Workspace> {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new TypeError('Workspace root is required.');
  await mkdir(path.resolve(root), { recursive: true });
  const canonicalRoot = await realpath(root);
  const resolve: Workspace['resolve'] = async (file, options = {}) => {
    if (typeof file !== 'string' || file.includes('\0')) throw new TypeError('Workspace path must be a string without NUL bytes.');
    const lexical = path.resolve(canonicalRoot, file);
    if (!contained(canonicalRoot, lexical)) throw new Error('Path escapes the workspace.');
    const canonical = await canonicalCandidate(lexical);
    if (!contained(canonicalRoot, canonical)) throw new Error('Symlink path escapes the workspace.');
    if (options.write && !options.internal) {
      protectWrite(canonicalRoot, lexical);
      protectWrite(canonicalRoot, canonical);
    }
    return canonical;
  };
  return {
    root: canonicalRoot,
    resolve,
    async read(file, maxBytes = 1_048_576) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Read limit must be a positive safe integer.');
      const candidate = await resolve(file);
      // Do not follow a replacement final-component symlink after resolution.
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Only regular files can be read.');
        if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
        const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
        let length = 0;
        for (;;) {
          const read = await handle.read(buffer, length, buffer.length - length);
          length += read.bytesRead;
          if (length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
          if (!read.bytesRead) return buffer.subarray(0, length).toString('utf8');
          if (length === buffer.length) {
            // A file may have grown after stat; bounded read never returns a
            // silently truncated document or allocates from an untrusted size.
            const extra = Buffer.alloc(1);
            if ((await handle.read(extra, 0, 1)).bytesRead) throw new Error('File changed while reading; retry.');
            return buffer.subarray(0, length).toString('utf8');
          }
        }
      } finally { await handle.close(); }
    },
    async write(file, content) {
      if (typeof content !== 'string') throw new TypeError('File content must be a string.');
      const candidate = await resolve(file, { write: true });
      await mkdir(path.dirname(candidate), { recursive: true });
      const checked = await resolve(file, { write: true });
      const handle = await open(checked, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Only regular files can be written.');
        // A hard link has no canonical pathname. Refusing shared inodes keeps
        // aliases from changing metadata or files outside the project.
        if (info.nlink > 1) throw new Error('File tools cannot overwrite hard-linked files.');
        await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
      } finally { await handle.close(); }
    },
    async list(directory = '.') {
      const candidate = await resolve(directory);
      if (!(await stat(candidate)).isDirectory()) throw new Error('Path is not a directory.');
      const entries = await readdir(candidate, { withFileTypes: true });
      return entries.sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
        name: entry.name,
        path: path.relative(canonicalRoot, path.join(candidate, entry.name)).split(path.sep).join('/'),
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
    },
  };
}

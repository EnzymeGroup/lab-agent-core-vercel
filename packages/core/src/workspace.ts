import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileAccessPolicy, SkillFingerprint } from './types.js';

export interface ExecutionContext {
  mode?: 'chat' | 'task';
  outputDirectory?: string;
  runId?: string;
  signal?: AbortSignal;
  skillBaselines?: SkillFingerprint[];
  onSkillLoad?: (fingerprint: SkillFingerprint) => Promise<void>;
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
  resolve(file: string, options?: WorkspaceAccessOptions): Promise<string>;
  read(file: string, maxBytes?: number, options?: WorkspaceAccessOptions): Promise<string>;
  write(file: string, content: string): Promise<void>;
  list(directory?: string, options?: WorkspaceAccessOptions): Promise<WorkspaceEntry[]>;
}
export interface WorkspaceAccessOptions {
  write?: boolean;
  internal?: boolean;
  /** Host-only registration lookup; model tool schemas never expose this flag. */
  readRoots?: boolean;
}
class FileAccessError extends Error {
  constructor(message = 'File access denied by the project policy.') {
    super(message); this.name = 'FileAccessError';
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function protectPath(root: string, candidate: string): void {
  const parts = path.relative(root, candidate).split(path.sep);
  for (const original of parts) {
    const name = original.toLowerCase();
    if (name.startsWith('.env') || /\.env(?:$|[._-])/u.test(name) ||
      ['.lab-agent', '.git', '.gitconfig', '.git-credentials', '.ssh', '.aws', '.gnupg', '.direnv', '.netrc', '.npmrc', '.pypirc', 'keys', 'secrets', 'credentials'].includes(name) ||
      /\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(name) ||
      /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|(?:private[-_]?keys?|api[-_]?keys?|secrets?|credentials))(?:$|[._-])/u.test(name) ||
      /(?:^|[-_.])service[-_]?account(?:$|[-_.])/u.test(name)) {
      throw new FileAccessError('Sensitive files and internal metadata are unavailable to file tools.');
    }
  }
  // Run directories are navigable, but only output is model-visible. Reports,
  // provenance, logs and durable evidence are owned by Core.
  if (parts[0] === 'runs' && parts.length >= 3 && parts[2] !== 'output') {
    throw new FileAccessError('Run metadata is unavailable to file tools; only output is visible.');
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

/** This policy limits model file tools. Trusted host code is not sandboxed. */
export async function createWorkspace(root: string, policy: FileAccessPolicy = {}): Promise<Workspace> {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new TypeError('Workspace root is required.');
  const mode = policy.mode ?? 'analysis';
  if (mode !== 'analysis' && mode !== 'development') throw new TypeError('fileAccess.mode must be analysis or development.');
  await mkdir(path.resolve(root), { recursive: true });
  const canonicalRoot = await realpath(root);
  const paths = async (file: string) => {
    if (typeof file !== 'string' || file.includes('\0')) throw new TypeError('Workspace path must be a string without NUL bytes.');
    const lexical = path.resolve(canonicalRoot, file);
    if (!contained(canonicalRoot, lexical)) throw new FileAccessError('Path escapes the workspace.');
    const canonical = await canonicalCandidate(lexical);
    if (!contained(canonicalRoot, canonical)) throw new FileAccessError('Symlink path escapes the workspace.');
    return { lexical, canonical };
  };
  const roots = async (configured: string[] | undefined) => {
    if (configured === undefined) return undefined;
    if (!Array.isArray(configured) || configured.some(value => typeof value !== 'string' || !value.trim())) throw new TypeError('File access roots must be nonempty path strings.');
    return Promise.all(configured.map(value => paths(value)));
  };
  const readRoots = await roots(policy.readRoots);
  const writeRoots = await roots(policy.writeRoots);
  type Paths = Awaited<ReturnType<typeof paths>>;
  const matches = (candidate: Paths, allowed: Paths, navigate = false) =>
    (contained(allowed.lexical, candidate.lexical) && contained(allowed.canonical, candidate.canonical)) ||
    (navigate && contained(candidate.lexical, allowed.lexical) && contained(candidate.canonical, allowed.canonical));
  const currentOutput = async () => {
    const context = getExecutionContext();
    if (!context?.outputDirectory || !context.runId || !/^[A-Za-z0-9_-]{1,120}$/u.test(context.runId)) {
      throw new FileAccessError('File writes require an active task; chat and direct native calls do not grant write access.');
    }
    context.signal?.throwIfAborted();
    const expected = path.join(canonicalRoot, 'runs', context.runId, 'output');
    const output = await paths(context.outputDirectory);
    if (output.lexical !== expected || output.canonical !== expected) throw new FileAccessError('Active task output must be its exact run output directory without symlink redirection.');
    return { directory: expected, id: context.runId };
  };
  const authorize = async (candidate: Paths, options: WorkspaceAccessOptions = {}, navigate = false) => {
    if (options.internal) return;
    protectPath(canonicalRoot, candidate.lexical);
    protectPath(canonicalRoot, candidate.canonical);
    const info = await stat(candidate.canonical).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isFile() && info.nlink > 1) throw new FileAccessError('Hard-linked files are unavailable to file tools.');
    if (options.write) {
      const output = await currentOutput();
      for (const file of [candidate.lexical, candidate.canonical]) {
        const parts = path.relative(canonicalRoot, file).split(path.sep);
        if (parts[0] === 'runs' && (parts[1] !== output.id || parts[2] !== 'output' || parts.length < 4)) {
          throw new FileAccessError('File tools may write inside the current runs/<id>/output only.');
        }
      }
      const inOutput = candidate.canonical !== output.directory && contained(output.directory, candidate.canonical);
      const inDevelopmentRoot = mode === 'development' && writeRoots?.some(allowed => matches(candidate, allowed));
      if (!inOutput && !inDevelopmentRoot) throw new FileAccessError('Write denied: use the current task output or an explicitly allowed development writeRoot.');
    } else if (options.readRoots !== false && readRoots &&
      !(navigate && candidate.lexical === canonicalRoot && candidate.canonical === canonicalRoot) &&
      !readRoots.some(allowed => matches(candidate, allowed, navigate))) {
      throw new FileAccessError('Read denied: path is outside configured readRoots.');
    }
  };
  const resolve: Workspace['resolve'] = async (file, options = {}) => {
    const candidate = await paths(file);
    await authorize(candidate, options);
    return candidate.canonical;
  };
  return {
    root: canonicalRoot,
    resolve,
    async read(file, maxBytes = 1_048_576, options = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Read limit must be a positive safe integer.');
      const candidate = await resolve(file, options);
      // Do not follow a replacement final-component symlink after resolution.
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Only regular files can be read.');
        if (!options.internal && info.nlink > 1) throw new FileAccessError('Hard-linked files are unavailable to file tools.');
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
        if (info.nlink > 1) throw new FileAccessError('File tools cannot overwrite hard-linked files.');
        await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
      } finally { await handle.close(); }
    },
    async list(directory = '.', options = {}) {
      const candidate = await paths(directory);
      await authorize(candidate, options, true);
      if (!(await stat(candidate.canonical)).isDirectory()) throw new Error('Path is not a directory.');
      const entries = await readdir(candidate.canonical, { withFileTypes: true });
      const visible: WorkspaceEntry[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        try {
          const child = await paths(path.join(candidate.lexical, entry.name));
          await authorize(child, options, entry.isDirectory() || entry.isSymbolicLink());
          visible.push({ name: entry.name,
            path: path.relative(canonicalRoot, path.join(candidate.lexical, entry.name)).split(path.sep).join('/'),
            type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
        } catch (error) {
          if (error instanceof FileAccessError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      return visible;
    },
  };
}

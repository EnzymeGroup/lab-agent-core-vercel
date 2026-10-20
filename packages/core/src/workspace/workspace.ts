import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ifExists, isOpaqueId, projectPath, within } from '../store/files.js';
import { getExecutionContext } from './context.js';
import type { FileAccessPolicy } from '../types.js';

/**
 * The model's view of the project. Every file tool goes through here.
 *
 * - Paths are resolved lexically *and* canonically; both must stay inside the root.
 * - Secrets, .git and Core metadata are invisible, including through aliases.
 * - Writes need an active task and land only in its runs/<id>/output
 *   (plus explicit writeRoots in development mode).
 *
 * This limits model file tools. Registered Python, MCP and native tools are trusted host code.
 */

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}

export interface WorkspaceAccessOptions {
  write?: boolean;
  /** Host-only lookups (registered scripts, run directories) skip the model policy. */
  internal?: boolean;
  /** Host-only registration lookup; model tool schemas never expose this flag. */
  readRoots?: boolean;
}

export interface Workspace {
  root: string;
  resolve(file: string, options?: WorkspaceAccessOptions): Promise<string>;
  read(file: string, maxBytes?: number, options?: WorkspaceAccessOptions): Promise<string>;
  write(file: string, content: string): Promise<void>;
  list(directory?: string, options?: WorkspaceAccessOptions): Promise<WorkspaceEntry[]>;
}

class FileAccessError extends Error {
  constructor(message = 'File access denied by the project policy.') {
    super(message);
    this.name = 'FileAccessError';
  }
}

const DEFAULT_MAX_BYTES = 1_048_576;

// ─── Sensitive path rules ───────────────────────────────────────────────────

const SENSITIVE_NAMES = new Set([
  '.lab-agent', '.git', '.gitconfig', '.git-credentials', '.ssh', '.aws', '.gnupg', '.direnv',
  '.netrc', '.npmrc', '.pypirc', 'keys', 'secrets', 'credentials',
]);
const SENSITIVE_PATTERNS = [
  /\.env(?:$|[._-])/u,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/u,
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|(?:private[-_]?keys?|api[-_]?keys?|secrets?|credentials))(?:$|[._-])/u,
  /(?:^|[-_.])service[-_]?account(?:$|[-_.])/u,
];

function isSensitiveName(original: string): boolean {
  const name = original.toLowerCase();
  return name.startsWith('.env') || SENSITIVE_NAMES.has(name) || SENSITIVE_PATTERNS.some(pattern => pattern.test(name));
}

function protectPath(root: string, candidate: string): void {
  const parts = path.relative(root, candidate).split(path.sep);
  if (parts.some(isSensitiveName)) throw new FileAccessError('Sensitive files and internal metadata are unavailable to file tools.');
  // Run directories are navigable, but only output is model-visible. Reports,
  // provenance, logs and durable evidence are owned by Core.
  if (parts[0] === 'runs' && parts.length >= 3 && parts[2] !== 'output') {
    throw new FileAccessError('Run metadata is unavailable to file tools; only output is visible.');
  }
}

/** realpath for paths that may not exist yet: resolve the deepest existing ancestor. */
async function canonicalCandidate(candidate: string): Promise<string> {
  const missing: string[] = [];
  let existing = candidate;
  for (;;) {
    try {
      return path.resolve(await realpath(existing), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

// ─── Workspace factory ──────────────────────────────────────────────────────

interface Paths { lexical: string; canonical: string }

export async function createWorkspace(root: string, policy: FileAccessPolicy = {}): Promise<Workspace> {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new TypeError('Workspace root is required.');
  const mode = policy.mode ?? 'analysis';
  if (mode !== 'analysis' && mode !== 'development') throw new TypeError('fileAccess.mode must be analysis or development.');
  await mkdir(path.resolve(root), { recursive: true });
  const canonicalRoot = await realpath(root);

  const paths = async (file: string): Promise<Paths> => {
    if (typeof file !== 'string' || file.includes('\0')) throw new TypeError('Workspace path must be a string without NUL bytes.');
    const lexical = path.resolve(canonicalRoot, file);
    if (!within(canonicalRoot, lexical)) throw new FileAccessError('Path escapes the workspace.');
    const canonical = await canonicalCandidate(lexical);
    if (!within(canonicalRoot, canonical)) throw new FileAccessError('Symlink path escapes the workspace.');
    return { lexical, canonical };
  };

  const configuredRoots = async (configured: string[] | undefined) => {
    if (configured === undefined) return undefined;
    if (!Array.isArray(configured) || configured.some(value => typeof value !== 'string' || !value.trim())) {
      throw new TypeError('File access roots must be nonempty path strings.');
    }
    return Promise.all(configured.map(paths));
  };
  const readRoots = await configuredRoots(policy.readRoots);
  const writeRoots = await configuredRoots(policy.writeRoots);

  /** Inside an allowed root; `navigate` also admits ancestors so listings can reach it. */
  const matches = (candidate: Paths, allowed: Paths, navigate = false) =>
    (within(allowed.lexical, candidate.lexical) && within(allowed.canonical, candidate.canonical)) ||
    (navigate && within(candidate.lexical, allowed.lexical) && within(candidate.canonical, allowed.canonical));

  const currentOutput = async () => {
    const context = getExecutionContext();
    if (!context?.outputDirectory || !context.runId || !isOpaqueId(context.runId)) {
      throw new FileAccessError('File writes require an active task; chat and direct native calls do not grant write access.');
    }
    context.signal?.throwIfAborted();
    const expected = path.join(canonicalRoot, 'runs', context.runId, 'output');
    const output = await paths(context.outputDirectory);
    if (output.lexical !== expected || output.canonical !== expected) {
      throw new FileAccessError('Active task output must be its exact run output directory without symlink redirection.');
    }
    return { directory: expected, id: context.runId };
  };

  const authorizeWrite = async (candidate: Paths) => {
    const output = await currentOutput();
    for (const file of [candidate.lexical, candidate.canonical]) {
      const parts = path.relative(canonicalRoot, file).split(path.sep);
      if (parts[0] === 'runs' && (parts[1] !== output.id || parts[2] !== 'output' || parts.length < 4)) {
        throw new FileAccessError('File tools may write inside the current runs/<id>/output only.');
      }
    }
    const inOutput = candidate.canonical !== output.directory && within(output.directory, candidate.canonical);
    const inDevelopmentRoot = mode === 'development' && writeRoots?.some(allowed => matches(candidate, allowed));
    if (!inOutput && !inDevelopmentRoot) {
      throw new FileAccessError('Write denied: use the current task output or an explicitly allowed development writeRoot.');
    }
  };

  const authorizeRead = (candidate: Paths, navigate: boolean) => {
    const isRoot = candidate.lexical === canonicalRoot && candidate.canonical === canonicalRoot;
    if (navigate && isRoot) return;
    if (!readRoots!.some(allowed => matches(candidate, allowed, navigate))) {
      throw new FileAccessError('Read denied: path is outside configured readRoots.');
    }
  };

  const authorize = async (candidate: Paths, options: WorkspaceAccessOptions = {}, navigate = false) => {
    if (options.internal) return;
    protectPath(canonicalRoot, candidate.lexical);
    protectPath(canonicalRoot, candidate.canonical);
    const info = await ifExists(stat(candidate.canonical));
    // A hard link has no canonical pathname, so it could alias a protected file.
    if (info?.isFile() && info.nlink > 1) throw new FileAccessError('Hard-linked files are unavailable to file tools.');
    if (options.write) await authorizeWrite(candidate);
    else if (options.readRoots !== false && readRoots) authorizeRead(candidate, navigate);
  };

  const resolve: Workspace['resolve'] = async (file, options = {}) => {
    const candidate = await paths(file);
    await authorize(candidate, options);
    return candidate.canonical;
  };

  async function read(file: string, maxBytes = DEFAULT_MAX_BYTES, options: WorkspaceAccessOptions = {}): Promise<string> {
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
        const chunk = await handle.read(buffer, length, buffer.length - length);
        length += chunk.bytesRead;
        if (length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
        if (!chunk.bytesRead) return buffer.subarray(0, length).toString('utf8');
        if (length === buffer.length) {
          // The file grew after stat. Never return a silently truncated document.
          if ((await handle.read(Buffer.alloc(1), 0, 1)).bytesRead) throw new Error('File changed while reading; retry.');
          return buffer.subarray(0, length).toString('utf8');
        }
      }
    } finally {
      await handle.close();
    }
  }

  async function write(file: string, content: string): Promise<void> {
    if (typeof content !== 'string') throw new TypeError('File content must be a string.');
    const candidate = await resolve(file, { write: true });
    await mkdir(path.dirname(candidate), { recursive: true });
    const checked = await resolve(file, { write: true });
    const handle = await open(checked, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Only regular files can be written.');
      if (info.nlink > 1) throw new FileAccessError('File tools cannot overwrite hard-linked files.');
      await handle.truncate(0);
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async function list(directory = '.', options: WorkspaceAccessOptions = {}): Promise<WorkspaceEntry[]> {
    const candidate = await paths(directory);
    await authorize(candidate, options, true);
    if (!(await stat(candidate.canonical)).isDirectory()) throw new Error('Path is not a directory.');
    const entries = await readdir(candidate.canonical, { withFileTypes: true });
    const visible: WorkspaceEntry[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const lexical = path.join(candidate.lexical, entry.name);
      try {
        await authorize(await paths(lexical), options, entry.isDirectory() || entry.isSymbolicLink());
      } catch (error) {
        // Hidden entries are omitted rather than reported.
        if (error instanceof FileAccessError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const type = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      visible.push({ name: entry.name, path: projectPath(canonicalRoot, lexical), type });
    }
    return visible;
  }

  return { root: canonicalRoot, resolve, read, write, list };
}

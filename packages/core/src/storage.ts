import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { link, mkdir, lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';

export class BusyError extends Error {
  constructor(message = 'Another operation is using this project. Wait or cancel the active operation.') {
    super(message); this.name = 'BusyError';
  }
}
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}
export class InputError extends Error {
  constructor(message: string) { super(message); this.name = 'InputError'; }
}
export function opaqueId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new InputError('Invalid ID. Expected an opaque alphanumeric token.');
  return value;
}
export function within(root: string, file: string): boolean {
  const part = relative(root, file);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Host-owned metadata paths never traverse symlinks, even inside the project. */
export async function storagePath(root: string, path: string, createParent = false): Promise<string> {
  const file = resolve(root, path);
  if (!within(root, file)) throw new InputError('Path escapes the project.');
  const parts = relative(root, file).split(sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = resolve(cursor, parts[i]);
    const info = await lstat(cursor).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Metadata path must not contain symlinks: ${relative(root, cursor)}`);
    if (i < parts.length - 1) {
      if (info && !info.isDirectory()) throw new Error('Metadata parent must be a directory.');
      if (!info && createParent) await mkdir(cursor, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
  }
  return file;
}
export async function atomicText(root: string, path: string, content: string): Promise<void> {
  const file = await storagePath(root, path, true);
  const temporary = resolve(dirname(file), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await storagePath(root, path);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export async function atomicJSON(root: string, path: string, value: unknown): Promise<void> {
  await atomicText(root, path, `${JSON.stringify(value, null, 2)}\n`);
}
export async function readJSON(root: string, path: string): Promise<unknown> {
  const file = await storagePath(root, path);
  const info = await stat(file).catch(error => {
    if (error.code === 'ENOENT') throw new NotFoundError(`Record does not exist: ${path}`);
    throw error;
  });
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Record must be a regular file smaller than 32 MiB.');
  return JSON.parse(await readFile(file, 'utf8'));
}

interface LockOwner { id: string; pid: number; host: string; startedAt: string }
function ownerIsAlive(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function lockOwner(root: string): Promise<LockOwner | undefined> {
  try {
    const data = await readJSON(root, '.lab-agent/operation.lock') as LockOwner;
    if (!data || !Number.isInteger(data.pid) || data.pid <= 0 || typeof data.host !== 'string' || typeof data.id !== 'string') {
      throw new Error('Invalid operation lock. Inspect it before removing it manually.');
    }
    return data;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}
async function publishOwner(root: string, path: string, owner: LockOwner): Promise<void> {
  const target = await storagePath(root, path, true);
  const candidate = await storagePath(root, `.lab-agent/.lock-${randomUUID()}`, true);
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner)); await handle.sync();
  } finally { await handle.close(); }
  try { await link(candidate, target); } finally { await rm(candidate, { force: true }); }
}
/** Immutable claims serialize dead-owner recovery without reclaiming a live guard. */
async function claimRecovery(root: string, stale: LockOwner, owner: LockOwner, depth = 0): Promise<void> {
  if (depth > 32) throw new BusyError('Too many interrupted recovery attempts. Inspect .lab-agent/recovery/.');
  const path = `.lab-agent/recovery/${opaqueId(stale.id)}.json`;
  try { await publishOwner(root, path, owner); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const claim = await readJSON(root, path) as LockOwner;
    if (!claim || typeof claim.id !== 'string' || typeof claim.host !== 'string' || !Number.isInteger(claim.pid) || claim.pid <= 0) throw new BusyError('Invalid recovery claim. Inspect project metadata.');
    if (claim.id === owner.id) return;
    if (ownerIsAlive(claim)) throw new BusyError('Another process is recovering the interrupted project.');
    await claimRecovery(root, claim, owner, depth + 1);
  }
}
export async function acquireOperation(root: string): Promise<() => Promise<void>> {
  const file = await storagePath(root, '.lab-agent/operation.lock', true);
  const owner: LockOwner = { id: randomUUID(), pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await publishOwner(root, '.lab-agent/operation.lock', owner);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if ((await lockOwner(root))?.id === owner.id) await rm(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lockOwner(root);
      if (!existing) continue;
      if (ownerIsAlive(existing)) throw new BusyError(`Project is in use by PID ${existing.pid} on ${existing.host}.`);
      await claimRecovery(root, existing, owner);
      // The immutable claim prevents two reclaimers from unlinking each other's live locks.
      if ((await lockOwner(root))?.id === existing.id) await rm(file, { force: true });
    }
  }
  throw new BusyError();
}
export function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /(?:API_KEY|TOKEN|PASSWORD|SECRET)$/.test(key)) message = message.split(value).join('[redacted]');
  }
  return message;
}

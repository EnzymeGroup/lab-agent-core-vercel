import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { link, open, rm } from 'node:fs/promises';
import { BusyError, NotFoundError } from '../errors.js';
import { opaqueId, readJSON, storagePath } from './files.js';

/**
 * One project admits one operation at a time, across sessions, CLI and HTTP.
 * The lock is a hard-linked JSON file so publication is atomic. A lock is only
 * reclaimed when its owner is a provably dead process on this host.
 */

const LOCK = '.lab-agent/operation.lock';
const MAX_ATTEMPTS = 3;
const MAX_RECOVERY_DEPTH = 32;

export interface LockOwner { id: string; pid: number; host: string; startedAt: string }
export type ReleaseLock = () => Promise<void>;

function validOwner(value: unknown): value is LockOwner {
  const owner = value as LockOwner;
  return !!owner && typeof owner.id === 'string' && typeof owner.host === 'string' && Number.isInteger(owner.pid) && owner.pid > 0;
}

/** Foreign-host owners are always treated as alive; we cannot inspect them. */
function ownerIsAlive(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function lockOwner(root: string): Promise<LockOwner | undefined> {
  try {
    const data = await readJSON(root, LOCK);
    if (!validOwner(data)) throw new Error('Invalid operation lock. Inspect it before removing it manually.');
    return data;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/** Write a private candidate file, then hard-link it into place; EEXIST means someone else won. */
async function publishOwner(root: string, path: string, owner: LockOwner): Promise<void> {
  const target = await storagePath(root, path, true);
  const candidate = await storagePath(root, `.lab-agent/.lock-${randomUUID()}`, true);
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, target);
  } finally {
    await rm(candidate, { force: true });
  }
}

/** Immutable claims serialize dead-owner recovery without reclaiming a live guard. */
async function claimRecovery(root: string, stale: LockOwner, owner: LockOwner, depth = 0): Promise<void> {
  if (depth > MAX_RECOVERY_DEPTH) throw new BusyError('Too many interrupted recovery attempts. Inspect .lab-agent/recovery/.');
  const path = `.lab-agent/recovery/${opaqueId(stale.id)}.json`;
  try {
    await publishOwner(root, path, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const claim = await readJSON(root, path);
    if (!validOwner(claim)) throw new BusyError('Invalid recovery claim. Inspect project metadata.');
    if (claim.id === owner.id) return;
    if (ownerIsAlive(claim)) throw new BusyError('Another process is recovering the interrupted project.');
    await claimRecovery(root, claim, owner, depth + 1);
  }
}

/** Acquire the project operation lock. Throws BusyError while a live owner holds it. */
export async function acquireOperation(root: string): Promise<ReleaseLock> {
  const file = await storagePath(root, LOCK, true);
  const owner: LockOwner = { id: randomUUID(), pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await publishOwner(root, LOCK, owner);
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

import { BusyError } from '../errors.js';
import { acquireOperation, type ReleaseLock } from '../store/lock.js';
import type { TurnMode } from '../types.js';

/**
 * In-process guard in front of the cross-process project lock.
 *
 * Lifecycle of one operation:
 *   acquire()  → starting: lock held, records being prepared
 *   activate() → running: cancel() now reaches its controller
 *   track()    → close() may now wait on its completion
 *   release()  → idle: lock released
 *
 * close() waits for a starting operation, aborts the running one and waits for it.
 */

export interface ActiveOperation {
  sessionId: string;
  runId?: string;
  mode: TurnMode;
  startedAt: string;
}

export interface OperationLease {
  activate(info: ActiveOperation, controller: AbortController): void;
  track(done: Promise<unknown>): void;
  release(): Promise<void>;
}

export function createOperationGate(root: string) {
  let closed = false;
  let starting: Promise<void> | undefined;
  let current: { info: ActiveOperation; controller: AbortController; done?: Promise<unknown> } | undefined;

  const assertOpen = () => { if (closed) throw new Error('Agent is closed.'); };
  const assertIdle = () => {
    assertOpen();
    if (starting || current) throw new BusyError();
  };

  async function acquire(): Promise<OperationLease> {
    assertIdle();
    let finishStarting!: () => void;
    const startup = new Promise<void>(accept => { finishStarting = accept; });
    starting = startup;
    const endStartup = () => {
      if (starting === startup) starting = undefined;
      finishStarting();
    };
    let releaseLock: ReleaseLock | undefined;
    try {
      releaseLock = await acquireOperation(root);
      assertOpen();
    } catch (error) {
      await releaseLock?.();
      endStartup();
      throw error;
    }
    const unlock = releaseLock;
    let entry: typeof current;
    let released = false;
    return {
      activate(info, controller) {
        entry = { info, controller };
        current = entry;
      },
      track(done) {
        if (entry) entry.done = done;
        endStartup();
      },
      async release() {
        if (released) return;
        released = true;
        if (current === entry) current = undefined;
        endStartup();
        await unlock();
      },
    };
  }

  return {
    acquire,
    assertIdle,
    get busy() { return !!starting || !!current; },
    get active(): ActiveOperation | undefined { return current?.info; },
    cancel(): boolean {
      if (!current) return false;
      current.controller.abort(new DOMException('Canceled by user.', 'AbortError'));
      return true;
    },
    async close(): Promise<void> {
      closed = true;
      await starting;
      current?.controller.abort(new DOMException('Agent closed.', 'AbortError'));
      await current?.done;
    },
  };
}

export type OperationGate = ReturnType<typeof createOperationGate>;

import type { Tool } from 'ai';
import { getExecutionContext, runWithExecutionContext } from '../workspace/context.js';

/**
 * Every registered tool is wrapped so Core can:
 *   - merge the turn's cancel signal with the SDK's per-call signal,
 *   - bound serialized output size,
 *   - track in-flight executions, so a canceled turn keeps project ownership
 *     until tool cleanup has actually settled.
 */

const executing = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

function trackExecution<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const pending = executing.get(signal) ?? new Set<Promise<unknown>>();
  executing.set(signal, pending);
  pending.add(promise);
  const settled = () => {
    pending.delete(promise);
    if (!pending.size) executing.delete(signal);
  };
  void promise.then(settled, settled);
  return promise;
}

/** The SDK can stop its stream before an aborted tool finishes cleanup. */
export async function waitForToolExecutions(signal: AbortSignal): Promise<void> {
  for (;;) {
    const pending = executing.get(signal);
    if (!pending?.size) return;
    await Promise.allSettled([...pending]);
  }
}

function assertOutputSize(value: unknown, maxBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    throw new Error('Tool output must be serializable.');
  }
  if (serialized !== undefined && Buffer.byteLength(serialized) > maxBytes) throw new Error(`Tool output exceeded ${maxBytes} bytes.`);
}

/** Wrap a streaming (async-iterable) tool result, tracking it until the iterator closes. */
async function* guardedIterator(result: AsyncIterable<unknown>, run: <T>(callback: () => T) => T, signal: AbortSignal | undefined, owner: AbortSignal | undefined, maxBytes: number) {
  const iterator = result[Symbol.asyncIterator]();
  let finish!: () => void;
  trackExecution(new Promise<void>(resolve => { finish = resolve; }), owner);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await run(() => iterator.next());
      if (next.done) return;
      signal?.throwIfAborted();
      assertOutputSize(next.value, maxBytes);
      yield next.value;
    }
  } finally {
    try {
      if (iterator.return) await run(() => iterator.return!());
    } finally {
      finish();
    }
  }
}

export function guardTool(native: Tool, maxBytes: number): Tool {
  if (!native.execute) return native;
  const execute = native.execute;
  return {
    ...native,
    execute(input, options) {
      const context = getExecutionContext();
      const signals = [context?.signal, options.abortSignal].filter((signal): signal is AbortSignal => Boolean(signal));
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      // Track against the turn's own signal so Core can wait for it on cancel.
      const owner = context?.signal ?? signal;
      const run = <T>(callback: () => T) => runWithExecutionContext({ ...context, signal }, callback);
      signal?.throwIfAborted();
      const result = run(() => execute(input, { ...options, abortSignal: signal }));
      if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
        return guardedIterator(result as AsyncIterable<unknown>, run, signal, owner, maxBytes);
      }
      return trackExecution(Promise.resolve(result).then(value => {
        signal?.throwIfAborted();
        assertOutputSize(value, maxBytes);
        return value;
      }), owner);
    },
  } as Tool;
}

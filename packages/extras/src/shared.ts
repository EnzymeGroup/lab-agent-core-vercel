import { createWorkspace, type FileAccessPolicy, type Workspace } from 'lab-agent-core-vercel';

/** Helpers several extras modules need. */

/** Create the project Workspace on first use, so building a tool set touches no files. */
export function lazyWorkspace(root: string, policy?: FileAccessPolicy): () => Promise<Workspace> {
  let workspace: Promise<Workspace> | undefined;
  return () => workspace ??= createWorkspace(root, policy);
}

/**
 * Run work for one key one at a time, in call order. The SDK runs the tool calls of a step
 * concurrently; read-modify-write of one file must not interleave. A failure does not block later work.
 */
export function serialQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>();
  return (key, work) => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  };
}

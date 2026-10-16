import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJSON, opaqueId, readJSON, storagePath } from './storage.js';
import type { SessionRecord } from './types.js';

const sessionSchema = z.object({
  id: z.string(), title: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  state: z.enum(['idle', 'running', 'interrupted']), activeRunId: z.string().optional(), error: z.string().optional(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(['system', 'user', 'assistant']), parts: z.array(z.unknown()) }).passthrough()),
});
export function createSessionStore(root: string) {
  const file = (id: string) => `.lab-agent/sessions/${opaqueId(id)}.json`;
  const save = async (record: SessionRecord) => {
    sessionSchema.parse(record);
    record.updatedAt = new Date().toISOString();
    await atomicJSON(root, file(record.id), record);
  };
  const load = async (id: string): Promise<SessionRecord> => {
    const record = sessionSchema.parse(await readJSON(root, file(id))) as SessionRecord;
    if (record.id !== id) throw new Error('Session ID does not match its record.');
    return record;
  };
  const list = async () => {
    const directory = await storagePath(root, '.lab-agent/sessions');
    const entries = await readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const sessions: SessionRecord[] = [];
    const issues: string[] = [];
    for (const entry of entries.filter(item => item.endsWith('.json'))) {
      try { sessions.push(await load(entry.slice(0, -5))); }
      catch (error) { issues.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions, issues };
  };
  return {
    root, file, save, load, list,
    async create(title = 'New session'): Promise<SessionRecord> {
      const now = new Date().toISOString();
      const record: SessionRecord = { id: randomUUID(), title: title.trim().slice(0, 160) || 'New session', createdAt: now, updatedAt: now, state: 'idle', messages: [] };
      await save(record); return record;
    },
  };
}

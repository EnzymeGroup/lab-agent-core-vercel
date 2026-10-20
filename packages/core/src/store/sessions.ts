import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../errors.js';
import { atomicJSON, opaqueId, readDirectory, readJSON } from './files.js';
import type { SessionRecord } from '../types.js';

/** Sessions live at .lab-agent/sessions/<id>.json and hold the complete UIMessage history. */

const DEFAULT_TITLE = 'New session';

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  state: z.enum(['idle', 'running', 'interrupted', 'awaiting_approval']),
  activeRunId: z.string().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
  summary: z.object({ text: z.string(), throughMessageId: z.string(), messageCount: z.number().int(), createdAt: z.iso.datetime() }).optional(),
  usage: z.object({
    inputTokens: z.number().optional(), outputTokens: z.number().optional(), totalTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(), costUsd: z.number().optional(), turns: z.number().int(),
  }).optional(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(['system', 'user', 'assistant']), parts: z.array(z.unknown()) }).passthrough()),
});

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(root: string) {
  const file = (id: string) => `.lab-agent/sessions/${opaqueId(id)}.json`;

  async function save(record: SessionRecord): Promise<void> {
    sessionSchema.parse(record);
    record.updatedAt = new Date().toISOString();
    await atomicJSON(root, file(record.id), record);
  }

  async function load(id: string): Promise<SessionRecord> {
    const record = sessionSchema.parse(await readJSON(root, file(id))) as SessionRecord;
    if (record.id !== id) throw new Error('Session ID does not match its record.');
    return record;
  }

  /** Unreadable records are reported as issues instead of hiding the rest. */
  async function list(): Promise<{ sessions: SessionRecord[]; issues: string[] }> {
    const sessions: SessionRecord[] = [];
    const issues: string[] = [];
    for (const entry of await readDirectory(root, '.lab-agent/sessions')) {
      if (!entry.name.endsWith('.json')) continue;
      try {
        sessions.push(await load(entry.name.slice(0, -5)));
      } catch (error) {
        issues.push(`${entry.name}: ${errorMessage(error)}`);
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions, issues };
  }

  async function create(title = DEFAULT_TITLE): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID(), title: title.trim().slice(0, 160) || DEFAULT_TITLE,
      createdAt: now, updatedAt: now, state: 'idle', messages: [],
    };
    await save(record);
    return record;
  }

  return { root, file, save, load, list, create, defaultTitle: DEFAULT_TITLE };
}

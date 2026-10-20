import { tool } from 'ai';
import { z } from 'zod';
import { forgetMemory, listMemory, memoryDraftSchema, readMemory, saveMemory, MEMORY_NAME, type MemorySummary } from '../store/memory.js';

/** saveMemory, readMemory and forgetMemory: the model's access to project memory (store/memory.ts). */

export function memoryTools(root: string) {
  const name = z.string().regex(MEMORY_NAME);
  return {
    saveMemory: tool({
      description: 'Save one durable fact to project memory so later sessions know it. Saving an existing name replaces it. Use for user preferences, corrections, decisions and pointers that are not already in project files; never for secrets or one-off details of this conversation.',
      inputSchema: memoryDraftSchema,
      execute: async (draft, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const { content: _content, ...saved } = await saveMemory(root, draft);
        return saved;
      },
    }),
    readMemory: tool({
      description: 'Read a project memory entry listed in the memory index. Check it is still accurate before relying on it.',
      inputSchema: z.object({ name }),
      execute: ({ name: entry }) => readMemory(root, entry),
    }),
    forgetMemory: tool({
      description: 'Delete a project memory entry that is wrong or no longer useful.',
      inputSchema: z.object({ name }),
      execute: async ({ name: entry }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        await forgetMemory(root, entry);
        return { forgotten: entry };
      },
    }),
  };
}

export const MEMORY_RULES = 'Project memory persists across sessions. Its index is attached to the latest user message; read an entry with readMemory before relying on it, and verify that files or functions it names still exist. Save with saveMemory only what is durable and not already in project files: preferences, corrections and the reason for them, decisions, pointers to external resources, and lessons from failed checks. One fact per entry; update an existing entry rather than adding a duplicate, and forget entries that turn out wrong. Never store secrets.';

/** The index appended to the latest user message each turn; never stored in history. */
export function memoryIndexNote(entries: readonly MemorySummary[]): string {
  if (!entries.length) return '\n\nProject memory index: (empty)';
  return `\n\nProject memory index (read entries with readMemory):\n${entries.map(entry => `- ${entry.name} [${entry.type}]: ${entry.description}`).join('\n')}`;
}

export async function memorySummaries(root: string): Promise<MemorySummary[]> {
  return (await listMemory(root)).entries.map(({ content: _content, ...summary }) => summary);
}

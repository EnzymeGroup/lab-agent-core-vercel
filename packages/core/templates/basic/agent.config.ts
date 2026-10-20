import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { tool } from 'ai';
import { z } from 'zod';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['data/notes.txt'] },
  tools: {
    countText: tool({
      description: 'Count characters in supplied text without changing source files.',
      inputSchema: z.object({ text: z.string().max(64000) }),
      execute: async ({ text }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        return { characters: [...text].length };
      },
    }),
  },
  // No checker is configured: completed execution has delivery not_checked.
  // Workbench branding. Presentation only; never part of run provenance.
  ui: {
    title: 'My Agent',
    tagline: 'A native-tool agent with persistent sessions and tracked task runs.',
    starters: [
      { title: 'Count the notes', prompt: 'Read data/notes.txt and count its characters with countText.' },
      { title: 'What can you do?', prompt: 'List your tools and Skills and when you would use each.', mode: 'chat' },
    ],
  },
}));

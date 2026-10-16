import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { tool } from 'ai';
import { z } from 'zod';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  tools: {
    sourceInfo: tool({
      description: 'Describe the fixed source data contract for this project.',
      inputSchema: z.object({}),
      execute: async () => ({ input: 'data/input.fasta', format: 'FASTA', preserveDuplicateIdentifiers: true }),
    }),
  },
  provenance: { inputs: ['data/input.fasta'] },
  python: { scripts: { summarize: { path: 'tools/summarize.py', description: 'Summarize data/input.fasta without changing identifiers or sequences.' } } },
  // Optional independent checker. Remove validation to leave delivery not_checked.
  validation: { command: ['python3', 'tools/validate.py'] },
  limits: { maxSteps: 8, timeoutMs: 120000 },
}));

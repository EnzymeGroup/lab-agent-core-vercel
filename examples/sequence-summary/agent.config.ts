import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  root: fileURLToPath(new URL('.', import.meta.url)),
  model: modelFromEnv(),
  python: { scripts: { summarize: { path: 'tools/summarize.py', description: 'Summarize data/input.fasta without changing identifiers or sequences.' } } },
  validation: { command: ['python3', 'tools/validate.py'] },
  limits: { maxSteps: 8, timeoutMs: 120000 },
});

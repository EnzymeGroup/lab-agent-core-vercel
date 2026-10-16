import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  root: fileURLToPath(new URL('.', import.meta.url)),
  model: modelFromEnv(),
  python: { scripts: { analyze: { path: 'tools/analyze.py', description: 'Profile data/input.csv while preserving raw cells and absent/empty values.' } } },
  validation: { command: ['python3', 'tools/validate.py'] },
  limits: { maxSteps: 8, timeoutMs: 120000 },
});

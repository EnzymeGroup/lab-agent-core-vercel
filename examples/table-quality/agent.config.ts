import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['data/input.csv'] },
  python: { scripts: { analyze: { path: 'tools/analyze.py', description: 'Profile data/input.csv while preserving raw cells and absent/empty values.' } } },
  validation: { command: ['python3', 'tools/validate.py'] },
  limits: { maxSteps: 8, timeoutMs: 120000 },
}));

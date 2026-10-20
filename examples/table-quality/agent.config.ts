import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['data/input.csv'], code: ['.agents/skills/table-quality/references/output.md'] },
  python: { scripts: { analyze: { modes: ['task'], path: 'tools/analyze.py', description: 'Profile data/input.csv while preserving raw cells and absent/empty values.' } } },
  validation: { command: ['python3', 'tools/validate.py'] },
  limits: { maxSteps: 8, timeoutMs: 120000 },
  ui: {
    title: 'Table Quality',
    tagline: 'Profile CSV tables while preserving raw cells, identifiers and missing values.',
    accent: '#0f766e',
    starters: [
      { title: 'Profile the table', prompt: 'Profile the CSV table and validate the artifacts.' },
      { title: 'Describe missing values', prompt: 'How does this project treat empty and absent cells?', mode: 'chat' },
    ],
  },
}));

import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['data/input.fasta'], code: ['.agents/skills/sequence-summary/references/output.md'] },
  python: { scripts: { summarize: { modes: ['task'], path: 'tools/summarize.py', description: 'Summarize data/input.fasta without changing identifiers or sequences.' } } },
  validation: { command: ['python3', 'tools/validate.py'] },
  limits: { maxSteps: 8, timeoutMs: 120000 },
  ui: {
    title: 'Sequence Agent',
    tagline: 'Summarize FASTA sources with a registered Python tool and an independent checker.',
    starters: [
      { title: 'Summarize the FASTA', prompt: 'Summarize the supplied FASTA and validate the artifacts.' },
      { title: 'Explain the checks', prompt: 'Explain what the checker verifies and what it cannot establish.', mode: 'chat' },
    ],
  },
}));

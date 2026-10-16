import type { LanguageModel } from 'ai';
import { defineAgent } from 'lab-agent-core-vercel';
import { createScientificContextPolicy, type SavedArtifact } from './context-policy.ts';
import { createCsvHeadTool } from './python-arguments.ts';

/** Copy this advanced example directory as the project root before using it. */
export function createContextExampleConfig(root: string, model: LanguageModel) {
  const saved: SavedArtifact[] = [];
  return defineAgent({
    root, model,
    instructions: { text: 'Use csvHead for bounded raw CSV samples. State limitations and never impute missing cells.' },
    tools: { csvHead: createCsvHeadTool(root, artifact => saved.push({ path: artifact, note: 'Saved bounded raw CSV sample; read before relying on it.' })) },
    provenance: { inputs: ['data/input.csv'], code: ['context-agent.ts', 'context-policy.ts', 'python-arguments.ts', 'tools/csv-arguments.py'] },
    prepareStep: createScientificContextPolicy({
      stableRules: 'Preserve source identifiers and missingness. Saved samples are partial evidence, never whole-dataset statistics.',
      savedArtifacts: () => saved,
      maxContextChars: 24_000,
      onNearBudget: notice => process.stderr.write(`Context notice: ${JSON.stringify(notice)}\n`),
    }),
    limits: { maxContextChars: 24_000, maxSteps: 8 },
  });
}

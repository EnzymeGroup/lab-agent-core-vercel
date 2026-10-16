import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { getExecutionContext, runCommand } from 'lab-agent-core-vercel';

/** A domain-specific native Tool + Zod, alongside ordinary registered runPython. */
export function createCsvHeadTool(root: string, onArtifactSaved?: (path: string) => void) {
  return tool({
    description: 'Save a bounded sample of the registered CSV while preserving raw cells.',
    inputSchema: z.object({ input: z.enum(['data/input.csv']), maxRows: z.number().int().min(1).max(1000).default(20) }),
    execute: async ({ input, maxRows }, { abortSignal }) => {
      const context = getExecutionContext();
      if (!context?.outputDirectory || !context.runId) throw new Error('csvHead requires an active Core task output directory; it is unavailable in chat.');
      abortSignal?.throwIfAborted();
      const result = await runCommand('python3', [path.join(root, 'tools/csv-arguments.py'), '--input', input, '--max-rows', String(maxRows), '--output', path.join(context.outputDirectory, 'sample.json')], {
        cwd: root, signal: abortSignal, timeoutMs: 30_000, maxOutputBytes: 65_536,
        env: { AGENT_ROOT: root, AGENT_RUN_ID: context.runId, AGENT_OUTPUT_DIR: context.outputDirectory },
      });
      if (result.code !== 0) throw new Error(`CSV sampling failed (${result.code}): ${result.stderr}`);
      const artifact = path.relative(root, path.join(context.outputDirectory, 'sample.json'));
      onArtifactSaved?.(artifact);
      return { artifact, stdout: result.stdout };
    },
  });
}

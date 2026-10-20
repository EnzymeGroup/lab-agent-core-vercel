import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { InputError, RunError, errorMessage } from '../errors.js';
import { atomicJSON, within } from '../store/files.js';
import type { LabAgent } from './create.js';
import type { Usage } from '../types.js';

/**
 * Evals: run a list of tasks against the real agent and grade each with the
 * configured checker. A case passes only when execution completed and delivery
 * passed. Nobody is there to approve tool calls, so pending approvals are denied.
 */

const caseSchema = z.object({
  name: z.string().min(1).max(80),
  task: z.string().min(1).max(64_000),
  inputs: z.array(z.string().min(1)).max(256).optional(),
  model: z.string().max(40).optional(),
  repeat: z.number().int().min(1).max(20).optional(),
});
const fileSchema = z.object({ cases: z.array(caseSchema).min(1).max(200) });

export type EvalCase = z.infer<typeof caseSchema>;

export interface EvalAttempt {
  case: string;
  attempt: number;
  runId?: string;
  sessionId?: string;
  execution?: string;
  delivery?: string;
  passed: boolean;
  usage?: Usage;
  costUsd?: number;
  ms: number;
  deniedApprovals: number;
  error?: string;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  attempts: EvalAttempt[];
  summary: {
    passed: number; total: number; passRate: number; totalTokens: number; costUsd?: number;
    cases: Array<{ name: string; passed: number; total: number }>;
  };
}

const MAX_DENIALS = 10;

/** Read and validate an evals file inside the project. */
export async function loadEvalFile(root: string, file = 'evals.json'): Promise<EvalCase[]> {
  const path = resolve(root, file);
  if (!within(root, path)) throw new InputError('The evals file must be inside the project.');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new InputError(`Could not read ${file}: ${errorMessage(error)}`);
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new InputError(`${file}: ${parsed.error.message}`);
  return parsed.data.cases;
}

async function attempt(agent: LabAgent, item: EvalCase, index: number): Promise<EvalAttempt> {
  const started = Date.now();
  let denied = 0;
  try {
    let run = await agent.runTask(item.task, { inputs: item.inputs, model: item.model });
    while (run.execution === 'awaiting_approval' && denied < MAX_DENIALS) {
      denied++;
      const result = await agent.approve(run.session.id, false, 'Unattended eval: tool calls that need approval are denied.');
      if (!result.run) break;
      run = result.run;
    }
    return {
      case: item.name, attempt: index, runId: run.id, sessionId: run.session.id,
      execution: run.execution, delivery: run.delivery,
      passed: run.execution === 'completed' && run.delivery === 'passed',
      usage: run.usage, costUsd: run.costUsd, ms: Date.now() - started, deniedApprovals: denied,
      ...(run.error ? { error: run.error } : {}),
    };
  } catch (error) {
    const run = error instanceof RunError ? error.run : undefined;
    return {
      case: item.name, attempt: index, runId: run?.id, sessionId: run?.session.id,
      execution: run?.execution, delivery: run?.delivery, passed: false,
      usage: run?.usage, costUsd: run?.costUsd, ms: Date.now() - started, deniedApprovals: denied,
      error: errorMessage(error, agent.config.env),
    };
  }
}

/** Run every case (sequentially; one project runs one operation at a time) and save the report. */
export async function runEvals(agent: LabAgent, cases: EvalCase[], options: { repeat?: number } = {}): Promise<EvalReport & { file: string }> {
  if (!agent.config.validation) throw new InputError('Evals are graded by the checker. Configure validation.command first.');
  const startedAt = new Date().toISOString();
  const attempts: EvalAttempt[] = [];
  for (const item of cases) {
    const repeat = options.repeat ?? item.repeat ?? 1;
    for (let index = 1; index <= repeat; index++) attempts.push(await attempt(agent, item, index));
  }
  const report: EvalReport = { startedAt, finishedAt: new Date().toISOString(), attempts, summary: summarize(attempts) };
  const file = `.lab-agent/evals/${startedAt.replace(/[:.]/g, '-')}.json`;
  await atomicJSON(agent.config.root, file, report);
  return { ...report, file };
}

function summarize(attempts: EvalAttempt[]): EvalReport['summary'] {
  const passed = attempts.filter(item => item.passed).length;
  const costs = attempts.map(item => item.costUsd).filter((cost): cost is number => cost !== undefined);
  const names = [...new Set(attempts.map(item => item.case))];
  return {
    passed, total: attempts.length, passRate: attempts.length ? passed / attempts.length : 0,
    totalTokens: attempts.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0),
    ...(costs.length ? { costUsd: costs.reduce((sum, cost) => sum + cost, 0) } : {}),
    cases: names.map(name => {
      const runs = attempts.filter(item => item.case === name);
      return { name, passed: runs.filter(item => item.passed).length, total: runs.length };
    }),
  };
}

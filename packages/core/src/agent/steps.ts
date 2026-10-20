import { addUsage, costOf, usageOf } from '../config/models.js';
import type { AgentConfig, SessionRecord, StepRecord, Usage } from '../types.js';

/** Per-call records and the usage/cost totals built from them. */

interface StepLike {
  finishReason: string;
  usage: Parameters<typeof usageOf>[0];
  performance?: { stepTimeMs?: number; toolExecutionMs?: Readonly<Record<string, number>> };
  content: ReadonlyArray<{ type: string; toolCallId?: string; toolName?: string }>;
}

/** One AI SDK step result as a compact, serializable StepRecord. */
export function stepRecord(agent: string, model: string, step: StepLike): StepRecord {
  const failed = new Set(step.content.filter(part => part.type === 'tool-error').map(part => part.toolCallId));
  const tools = step.content.filter(part => part.type === 'tool-call').map(part => {
    const ms = part.toolCallId ? step.performance?.toolExecutionMs?.[part.toolCallId] : undefined;
    return { name: part.toolName ?? 'unknown', ...(ms === undefined ? {} : { ms: Math.round(ms) }), ...(failed.has(part.toolCallId) ? { error: true } : {}) };
  });
  return { agent, model, finishReason: step.finishReason, usage: usageOf(step.usage), ms: Math.round(step.performance?.stepTimeMs ?? 0), tools };
}

export interface Totals { usage?: Usage; costUsd?: number }

/** Add one step. Cost is the sum over model calls whose model has a configured price. */
export function addStep(config: AgentConfig, totals: Totals, step: StepRecord): void {
  totals.usage = addUsage(totals.usage, step.usage);
  const cost = costOf(config, step.model, step.usage);
  if (cost !== undefined) totals.costUsd = (totals.costUsd ?? 0) + cost;
}

/** Fold a turn's (or a manual summary's) totals into the session's running usage. */
export function addSessionUsage(session: SessionRecord, totals: Totals, turn: boolean): void {
  if (!totals.usage && !turn) return;
  const previous = session.usage;
  const usage = totals.usage ? addUsage(previous, totals.usage) : { ...previous };
  const costUsd = previous?.costUsd === undefined && totals.costUsd === undefined ? undefined : (previous?.costUsd ?? 0) + (totals.costUsd ?? 0);
  session.usage = { ...usage, ...(costUsd === undefined ? {} : { costUsd }), turns: (previous?.turns ?? 0) + (turn ? 1 : 0) };
}

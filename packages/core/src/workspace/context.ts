import { AsyncLocalStorage } from 'node:async_hooks';
import type { LanguageModel } from 'ai';
import type { ContextStats, SkillFingerprint, StepRecord, TurnMode } from '../types.js';

/**
 * Per-turn state that tools read without it appearing in their schemas.
 * Core sets it around each model stream; tools inherit it through async calls.
 */
export interface ExecutionContext {
  mode?: TurnMode;
  /** Absolute runs/<id>/output for the active task. Undefined in chat. */
  outputDirectory?: string;
  runId?: string;
  signal?: AbortSignal;
  /** Task-start Skill fingerprints, updated in place when a Skill is loaded. */
  skillBaselines?: SkillFingerprint[];
  onSkillLoad?: (fingerprint: SkillFingerprint) => Promise<void>;
  /** The session's selected model; prepareStep uses it unless the app's prepareStep overrides it. */
  model?: LanguageModel;
  /** Receives the bounded context size for each step. */
  onContext?: (stats: ContextStats) => void;
  /** Key of the selected model ("default" or a config.models key), for cost and step records. */
  modelKey?: string;
  /** Model calls Core makes for this turn outside the main loop (subagents, summaries). */
  onStep?: (step: StepRecord) => void;
  /** Full text of tool results clipped in the model's view, by toolCallId, for readToolOutput. */
  clipped?: Map<string, string>;
  /** Messages a person sent while this turn was running, injected at the next step. */
  steering?: SteeringQueue;
  /** True once the turn's token budget is spent; the loop stops after the current step. */
  overBudget?: () => boolean;
  /** Input tokens the provider reported for the previous step. */
  lastInputTokens?: () => number | undefined;
}

export interface SteeringQueue {
  pending: string[];
  /** Texts injected into the model's view, waiting to be recorded in the UI stream. */
  announced: string[];
  /** False once the turn has decided to finish; steer() then fails instead of queueing. */
  accepting: boolean;
}

const execution = new AsyncLocalStorage<ExecutionContext>();

export function getExecutionContext(): ExecutionContext | undefined {
  return execution.getStore();
}

export function runWithExecutionContext<T>(context: ExecutionContext, callback: () => T): T {
  return execution.run(context, callback);
}

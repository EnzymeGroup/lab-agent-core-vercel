import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { addUsage } from '../config/models.js';
import { checkRunUnlocked } from '../runs/check.js';
import { hashArtifacts } from '../runs/provenance.js';
import { listArtifacts } from '../runs/store.js';
import { waitForToolExecutions } from '../tools/index.js';
import { pendingApprovals } from './approval.js';
import { splitSteering } from './steering.js';
import { addSessionUsage, type Totals } from './steps.js';
import type { OperationLease } from './gate.js';
import type { AgentResources } from './resources.js';
import type { ExecutionContext } from '../workspace/context.js';
import type { ContextStats, PendingApproval, RunRecord, SessionRecord, StepRecord, TurnMetadata, TurnMode, TurnResult } from '../types.js';

/**
 * The second half of a turn, run by Core regardless of whether a UI is reading.
 * A turn is one or more segments (native streams) under one lock:
 *
 *   persist stream → settle tools ─┬─ approval needed  → pause run, release
 *                                  ├─ steering left    → next segment
 *                                  └─ record run → check ─┬─ repair allowed → next segment
 *                                                         └─ release
 */

const SAVE_INTERVAL_MS = 100;

/** Mutable outcome collected while the model streams. */
export interface TurnOutcome extends Totals {
  error?: string;
  finishReason?: string;
  /** Latest step's bounded context size. */
  context?: ContextStats;
  model?: TurnMetadata['model'];
  /** Every model call of this turn: main loop, subagents and summaries. */
  steps: StepRecord[];
  /** The token budget stopped the loop. */
  budgetHit?: boolean;
  /** Non-fatal condition shown with the reply, such as a failed summary. */
  notice?: string;
}

export interface TurnState {
  res: AgentResources;
  session: SessionRecord;
  run?: RunRecord;
  mode: TurnMode;
  controller: AbortController;
  lease: OperationLease;
  outcome: TurnOutcome;
  context: ExecutionContext;
  /** Run totals before this turn; a run resumed after approval accumulates. */
  base: Totals & { steps: StepRecord[] };
  /** Continuation after approval: not counted as a new session turn. */
  resumed: boolean;
  /** Start another native stream on the current session history. */
  stream(): Promise<ReadableStream<UIMessageChunk>>;
  /** Timer, caller-signal and active-turn cleanup. */
  cleanup(): void;
}

/**
 * Apply the stream to session history, saving at most every 100 ms. Returns the final assistant text.
 * After an approval the stream continues the stored assistant message (same ID), so start from it.
 */
async function persistStream(state: TurnState, stream: ReadableStream<UIMessageChunk>): Promise<string> {
  const { res, session, outcome } = state;
  const last = session.messages.at(-1);
  let text = '';
  let lastSaved = 0;
  const messages = readUIMessageStream({
    stream, terminateOnError: false, message: last?.role === 'assistant' ? structuredClone(last) as UIMessage : undefined,
    onError: error => { outcome.error ??= res.errorMessage(error); },
  });
  for await (const message of messages) {
    const index = session.messages.findIndex(item => item.id === message.id);
    if (index < 0) session.messages.push(message);
    else session.messages[index] = message;
    text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('');
    if (Date.now() - lastSaved > SAVE_INTERVAL_MS) {
      await res.sessions.save(session);
      lastSaved = Date.now();
    }
  }
  return text;
}

/** A turn that ended without an explicit error still fails unless the model stopped normally. */
function terminalError(outcome: TurnOutcome, signal: AbortSignal, errorMessage: (error: unknown) => string): string | undefined {
  if (signal.aborted) return errorMessage(signal.reason ?? 'Canceled');
  if (outcome.error) return outcome.error;
  if (outcome.finishReason === 'stop') return undefined;
  if (outcome.finishReason === 'tool-calls') {
    return outcome.budgetHit
      ? 'Agent stopped at its token budget (limits.maxTurnTokens) before producing a final response.'
      : 'Agent stopped at its step budget before producing a final response.';
  }
  return `Agent stopped without a complete response (${outcome.finishReason ?? 'unknown'}).`;
}

/** Run totals = totals before this turn + this turn's steps. */
function applyTotals(state: TurnState, run: RunRecord): void {
  const { base, outcome } = state;
  run.usage = outcome.usage ? addUsage(base.usage, outcome.usage) : base.usage;
  run.steps = [...base.steps, ...outcome.steps];
  const cost = base.costUsd === undefined && outcome.costUsd === undefined ? undefined : (base.costUsd ?? 0) + (outcome.costUsd ?? 0);
  if (cost === undefined) delete run.costUsd;
  else run.costUsd = cost;
}

async function finalizeRun(state: TurnState, run: RunRecord, text: string): Promise<void> {
  const { res, controller, outcome } = state;
  const { signal } = controller;
  const timedOut = signal.aborted && signal.reason?.name === 'TimeoutError';
  const aborted = signal.aborted && !timedOut;
  run.execution = aborted ? 'aborted' : outcome.error ? 'failed' : 'completed';
  run.finishReason = signal.aborted ? (aborted ? 'aborted' : 'timeout') : outcome.finishReason ?? 'error';
  run.error = outcome.error;
  run.text = text;
  applyTotals(state, run);
  run.finishedAt = new Date().toISOString();
  try {
    run.artifacts = await listArtifacts(res.root, run.id);
    if (run.provenance) run.provenance.artifacts = await hashArtifacts(res.root, run.id, run.artifacts);
  } catch (error) {
    run.execution = 'failed';
    run.error = outcome.error = res.errorMessage(error);
  }
  await res.runs.save(run);
  if (run.execution === 'completed') {
    Object.assign(run, await checkRunUnlocked(res.config, run.id, signal, { kind: run.repairs ? 'repair' : 'initial' }));
  }
}

/** Not terminal: the run waits for respond(). Its outputs are recorded when it finishes. */
async function pauseRun(state: TurnState, run: RunRecord, text: string): Promise<void> {
  run.execution = 'awaiting_approval';
  run.finishReason = 'tool-approval';
  run.text = text;
  applyTotals(state, run);
  await state.res.runs.save(run);
}

/** The next automatic repair prompt, or undefined when no repair should be attempted. */
async function repairMessage(state: TurnState, run: RunRecord): Promise<string | undefined> {
  const limit = state.res.config.validation?.repairAttempts ?? 0;
  if (run.execution !== 'completed' || (run.delivery !== 'failed' && run.delivery !== 'partial')) return;
  if ((run.repairs ?? 0) >= limit || state.controller.signal.aborted) return;
  const report = await state.res.runs.report(run.id).catch(() => null);
  const issues = (report?.issues.length ? report.issues : ['The checker reported no issues; see validation.log.']).slice(0, 20);
  return `Automatic repair ${(run.repairs ?? 0) + 1} of ${limit}: the independent checker reported delivery "${run.delivery}".\n`
    + `Issues:\n${issues.map(issue => `- ${issue}`).join('\n')}\n`
    + 'Fix the outputs in the same output directory, then finish with a short note on what changed.'
    + (state.res.config.memory === false ? '' : ' If the cause is a lesson that later tasks should know, save it with saveMemory.');
}

/** Append a steering or repair message and stream again on the same lock. */
async function nextSegment(state: TurnState, text: string, source: 'steer' | 'repair'): Promise<ReadableStream<UIMessageChunk>> {
  const { session, outcome, context } = state;
  splitSteering(session);
  session.messages.push({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }], metadata: { source } });
  delete outcome.error;
  delete outcome.finishReason;
  context.steering!.accepting = true;
  await state.res.sessions.save(session);
  return state.stream();
}

export async function completeTurn(state: TurnState, first: ReadableStream<UIMessageChunk>): Promise<TurnResult> {
  const { res, session, run, controller, outcome, context } = state;
  const steering = context.steering!;
  let text = '';
  let stream = first;
  let pending: PendingApproval[] = [];
  try {
    for (;;) {
      try {
        text = await persistStream(state, stream);
        pending = pendingApprovals(session);
        if (!pending.length || controller.signal.aborted || outcome.error) {
          pending = [];
          outcome.error = terminalError(outcome, controller.signal, res.errorMessage);
        }
      } catch (error) {
        pending = [];
        outcome.error = res.errorMessage(error);
      }
      // SDK abort ends the model stream before in-flight tools necessarily settle.
      // Keep ownership until subprocess and custom-tool cleanup has finished.
      await waitForToolExecutions(controller.signal);
      if (pending.length) {
        if (run) await pauseRun(state, run, text);
        break;
      }
      if (!outcome.error && steering.pending.length) {
        stream = await nextSegment(state, steering.pending.splice(0).join('\n\n'), 'steer');
        continue;
      }
      steering.accepting = false;
      if (!run) break;
      await finalizeRun(state, run, text);
      const repair = await repairMessage(state, run);
      if (!repair) break;
      run.repairs = (run.repairs ?? 0) + 1;
      run.execution = 'running';
      delete run.finishedAt;
      await res.runs.save(run);
      stream = await nextSegment(state, repair, 'repair');
    }
  } catch (error) {
    pending = [];
    outcome.error = res.errorMessage(error);
    if (run) {
      run.execution = 'failed';
      run.error = outcome.error;
      run.finishedAt ??= new Date().toISOString();
      applyTotals(state, run);
      await res.runs.save(run);
    }
  } finally {
    state.cleanup();
    splitSteering(session);
    addSessionUsage(session, outcome, !state.resumed);
    session.state = pending.length ? 'awaiting_approval' : 'idle';
    session.error = outcome.error;
    if (!pending.length) delete session.activeRunId;
    try {
      await res.sessions.save(session);
    } finally {
      await state.lease.release();
    }
  }
  return { session, run, text, error: outcome.error, ...(pending.length ? { pendingApprovals: pending } : {}) };
}

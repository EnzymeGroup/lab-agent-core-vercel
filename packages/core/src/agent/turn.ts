import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { convertToModelMessages, toUIMessageStream, validateUIMessages, type LanguageModel, type UIMessageChunk } from 'ai';
import { BusyError, InputError, RunError, SessionCompatibilityError } from '../errors.js';
import { opaqueId } from '../store/files.js';
import { limitsOf } from '../config/load.js';
import { DEFAULT_MODEL, modelInfo, selectModel } from '../config/models.js';
import { validInputList } from '../runs/provenance.js';
import { snapshotSkills } from '../tools/skills.js';
import { memoryIndexNote } from '../tools/memory.js';
import { listMemory } from '../store/memory.js';
import { hashFile, sha256 } from '../store/hash.js';
import { attachedPaths, attachmentParts, inlineAttachments } from './attachments.js';
import { runWithExecutionContext, type ExecutionContext } from '../workspace/context.js';
import { appendToLastUserMessage, taskDeliveryNote } from './prompt.js';
import { compactSession, needsCompaction, summaryMessage, unsummarized } from './compact.js';
import { applyDecisions, parseDecisions } from './approval.js';
import { announceSteering, createSteeringQueue } from './steering.js';
import { addStep, stepRecord } from './steps.js';
import { completeTurn, type TurnOutcome, type TurnState } from './finish.js';
import type { OperationLease } from './gate.js';
import { repairedToolName, type AgentResources } from './resources.js';
import type { RunRecord, SessionRecord, SkillFingerprint, StepRecord, TurnInput, TurnMetadata, TurnMode, TurnStream } from '../types.js';

/**
 * The first half of a turn: validate → lock → open session (and run, for tasks)
 * → append the user message → compact if needed → start the native AI SDK stream.
 * respondTurn continues a turn paused for approval; steerTurn queues a message
 * for the turn that is running.
 *
 * The returned stream is for a UI. Core consumes its own copy (finish.ts), so a
 * disconnected reader never stops accepted work. Only cancel() does.
 */

const MAX_MESSAGE_CHARS = 64_000;

function validateRequest(request: TurnInput): { mode: TurnMode; inputs?: string[] } {
  if (!request.message.trim() || request.message.length > MAX_MESSAGE_CHARS) throw new InputError('Message must contain 1–64000 characters.');
  const mode = request.mode ?? 'chat';
  if (request.inputs !== undefined && mode !== 'task') throw new InputError('Input bindings are available in task mode only.');
  if (request.inputs !== undefined && !validInputList(request.inputs)) throw new InputError('Task inputs must be an array of at most 256 nonempty project paths.');
  if (request.model !== undefined && typeof request.model !== 'string') throw new InputError('model must be a model key string.');
  request.signal?.throwIfAborted();
  return { mode, inputs: request.inputs ? [...request.inputs] : undefined };
}

/** Stored tool calls must still validate against the current tools before we append anything. */
async function assertSessionCompatible(res: AgentResources, session: SessionRecord): Promise<void> {
  if (!session.messages.length) return;
  const used = [...new Set(session.messages.flatMap(message => message.parts
    .filter(part => part.type.startsWith('tool-') || part.type === 'dynamic-tool')
    .map(part => part.type === 'dynamic-tool' ? (part as { toolName: string }).toolName : part.type.slice(5))))];
  const removed = used.filter(name => !Object.hasOwn(res.tools, name));
  if (removed.length) throw new SessionCompatibilityError(session.id, removed);
  try {
    await validateUIMessages({ messages: session.messages, tools: res.tools });
  } catch (error) {
    throw new SessionCompatibilityError(session.id, used, error);
  }
}

async function openSession(res: AgentResources, request: TurnInput): Promise<SessionRecord> {
  const session = request.sessionId ? await res.sessions.load(request.sessionId) : await res.sessions.create(request.message.slice(0, 80));
  if (session.state === 'awaiting_approval') throw new InputError('This session is waiting for a tool approval. Approve or deny the pending call before sending a new message.');
  if (session.title === res.sessions.defaultTitle && !session.messages.length) session.title = request.message.trim().slice(0, 80);
  if (request.messageId && session.messages.some(message => message.id === opaqueId(request.messageId!))) {
    throw new BusyError('This message was already accepted. Reload the session instead of replaying it.');
  }
  await assertSessionCompatible(res, session);
  return session;
}

type SelectedModel = { key: string; model: LanguageModel };

/**
 * An explicit request model becomes the session's model. Otherwise the session keeps
 * its saved choice, falling back to the default if that key left the config.
 */
function chooseModel(res: AgentResources, session: SessionRecord, requested?: string): SelectedModel {
  const saved = session.model && Object.hasOwn(res.config.models ?? {}, session.model) ? session.model : undefined;
  const selected = selectModel(res.config, requested ?? saved);
  if (selected.key === DEFAULT_MODEL) delete session.model;
  else session.model = selected.key;
  return selected;
}

/** Create the run record and freeze its inputs and Skill fingerprints. */
async function openRun(res: AgentResources, request: TurnInput, sessionId: string, selected: SelectedModel, inputs?: string[]): Promise<RunRecord> {
  for (const file of inputs ?? []) {
    try {
      await res.workspace.resolve(file);
    } catch (error) {
      throw new InputError(`Invalid task input ${file}: ${res.errorMessage(error)}`);
    }
  }
  const run = await res.runs.create(request.message, sessionId, { workflowId: request.workflowId, parentRunId: request.parentRunId, inputs, model: { key: selected.key, ...modelInfo(selected.model) } });
  run.provenance!.skills = await snapshotSkills(res.workspace, res.skills);
  if (res.config.memory !== false) {
    run.provenance!.memory = (await listMemory(res.root)).entries.map(entry => ({ name: entry.name, sha256: sha256(entry.content), updatedAt: entry.updatedAt }));
  }
  const { disabled, alwaysAllow } = res.switches.settings;
  if (disabled.length || alwaysAllow.length) run.provenance!.toolSettings = { disabled: [...disabled], alwaysAllow: [...alwaysAllow] };
  await res.runs.save(run);
  return run;
}

/** Leave an honest terminal record when a turn fails before streaming starts. */
async function abandon(res: AgentResources, error: unknown, session?: SessionRecord, run?: RunRecord): Promise<void> {
  const message = res.errorMessage(error);
  if (run) {
    run.execution = 'failed';
    run.error = message;
    run.finishedAt = new Date().toISOString();
    await res.runs.save(run);
  }
  if (session?.state === 'running') {
    session.state = 'idle';
    session.error = message;
    delete session.activeRunId;
    await res.sessions.save(session);
  }
}

/** Input tokens of the newest recorded step, from assistant metadata. */
function previousInputTokens(session: SessionRecord): number | undefined {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const tokens = (session.messages[index].metadata as TurnMetadata | undefined)?.context?.tokens;
    if (session.messages[index].role === 'assistant' && tokens !== undefined) return tokens;
  }
}

/** Per-turn state shared by every tool and step: model, budget, steering, clipped results, Skill tracking. */
function executionContext(res: AgentResources, mode: TurnMode, signal: AbortSignal, outcome: TurnOutcome, selected: SelectedModel, run?: RunRecord): ExecutionContext {
  const { maxTurnTokens } = limitsOf(res.config);
  const base: ExecutionContext = {
    mode, signal, model: selected.model, modelKey: selected.key,
    clipped: new Map(), steering: createSteeringQueue(),
    onContext: stats => { outcome.context = stats; },
    onStep: step => recordStep(res, outcome, step),
    overBudget: () => {
      const spent = !!maxTurnTokens && (outcome.usage?.totalTokens ?? 0) >= maxTurnTokens;
      if (spent) outcome.budgetHit = true;
      return spent;
    },
  };
  if (!run) return base;
  let updates: Promise<void> = Promise.resolve();
  return {
    ...base, runId: run.id,
    outputDirectory: resolve(run.directory, 'output'),
    skillBaselines: run.provenance?.skills,
    onSkillLoad: (fingerprint: SkillFingerprint) => updates = updates.then(async () => {
      const baseline = run.provenance!.skills!.find(skill => skill.name === fingerprint.name);
      if (!baseline) throw new Error(`Skill ${fingerprint.name} was not registered for this task.`);
      Object.assign(baseline, fingerprint);
      await res.runs.save(run);
    }),
  };
}

function recordStep(res: AgentResources, outcome: TurnOutcome, step: StepRecord): void {
  outcome.steps.push(step);
  addStep(res.config, outcome, step);
}

/** Start the native stream and convert it to UI chunks. Startup failures become a single error chunk. */
async function startModelStream(res: AgentResources, session: SessionRecord, context: ExecutionContext, outcome: TurnOutcome, selected: SelectedModel, run?: RunRecord): Promise<ReadableStream<UIMessageChunk>> {
  let result;
  const summary = summaryMessage(session);
  try {
    const visible = await inlineAttachments(res.workspace, unsummarized(session));
    const messages = [...summary, ...await convertToModelMessages(visible, { tools: res.tools, ignoreIncompleteToolCalls: true })];
    if (run) {
      const output = relative(res.root, context.outputDirectory!).split('\\').join('/');
      appendToLastUserMessage(messages, taskDeliveryNote(output, run.provenance!.inputs));
    }
    // Read fresh for every segment, so an entry saved earlier in the turn is listed.
    if (res.config.memory !== false) {
      const { entries } = await listMemory(res.root);
      appendToLastUserMessage(messages, memoryIndexNote(entries));
    }
    const selectedId = modelInfo(selected.model).id;
    result = await runWithExecutionContext(context, () => res.native.stream({
      messages, abortSignal: context.signal,
      onStepEnd: event => {
        outcome.finishReason = event.finishReason;
        // An application prepareStep may switch models; record what actually ran.
        const key = event.model.modelId === selectedId ? selected.key : `${event.model.provider}:${event.model.modelId}`;
        recordStep(res, outcome, stepRecord('main', key, event));
      },
      onEnd: event => { outcome.finishReason = event.finishReason; },
    }));
  } catch (error) {
    outcome.error = res.errorMessage(error);
    const errorText = outcome.error ?? 'Model startup failed.';
    return new ReadableStream({ start(writer) { writer.enqueue({ type: 'error', errorText }); writer.close(); } });
  }
  const names = Object.keys(res.tools);
  const observed = result.stream.pipeThrough(new TransformStream({
    transform(part, writer) {
      if (part.type === 'error') outcome.error = res.errorMessage(part.error);
      // The UI part is announced before the SDK repairs a misspelled name; store the real tool.
      if ('toolName' in part && typeof part.toolName === 'string' && !Object.hasOwn(res.tools, part.toolName)) {
        const repaired = repairedToolName(names, part.toolName);
        if (repaired) part = { ...part, toolName: repaired } as typeof part;
      }
      writer.enqueue(part);
    },
  }));
  const summarizedMessages = summary.length ? session.summary!.messageCount : undefined;
  const maxTokens = limitsOf(res.config).maxContextTokens;
  return toUIMessageStream({
    stream: observed, tools: res.tools, originalMessages: session.messages, generateMessageId: randomUUID, onError: res.errorMessage,
    messageMetadata: ({ part }) => turnMetadata(outcome, part, { summarizedMessages, maxTokens }),
  }).pipeThrough(announceSteering(context.steering!));
}

/** Model on start; bounded context and that step's input tokens after each step; totals at the end. */
function turnMetadata(outcome: TurnOutcome, part: { type: string; usage?: TurnMetadata['usage']; totalUsage?: TurnMetadata['usage'] }, extra: { summarizedMessages?: number; maxTokens?: number }): TurnMetadata | undefined {
  if (part.type === 'start') return { model: outcome.model, ...(outcome.notice ? { notice: outcome.notice } : {}) };
  if (part.type === 'finish-step') {
    const tokens = part.usage?.inputTokens;
    const context = outcome.context && { ...outcome.context, ...extra, ...(tokens === undefined ? {} : { tokens }) };
    return { context, usage: { inputTokens: tokens } };
  }
  if (part.type === 'finish') {
    const { inputTokens, outputTokens, totalTokens } = part.totalUsage ?? {};
    return { usage: { inputTokens, outputTokens, totalTokens } };
  }
}

/** A UI reader owns only its subscription; canceling it never cancels accepted execution. */
function detachable(source: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  const reader = source.getReader();
  let canceled = false;
  return new ReadableStream({
    async pull(writer) {
      const part = await reader.read();
      if (canceled) return;
      if (part.done) {
        reader.releaseLock();
        writer.close();
      } else {
        writer.enqueue(part.value);
      }
    },
    cancel(reason) {
      canceled = true;
      void reader.cancel(reason).finally(() => reader.releaseLock()).catch(() => {});
    },
  });
}

/** Summarize older turns before the model sees them. A failed summary falls back to dropping old turns. */
async function maybeCompact(res: AgentResources, session: SessionRecord, context: ExecutionContext, outcome: TurnOutcome): Promise<void> {
  if (!await needsCompaction(res.config, session, res.tools, previousInputTokens(session))) return;
  try {
    if (await compactSession(res.config, session, res.tools, { modelKey: context.modelKey, signal: context.signal, onStep: context.onStep })) await res.sessions.save(session);
  } catch (error) {
    context.signal?.throwIfAborted();
    outcome.notice = `Older turns could not be summarized (${res.errorMessage(error)}); the oldest turns were left out instead.`;
  }
}

interface BeginOptions {
  signal?: AbortSignal;
  mode: TurnMode;
  session: SessionRecord;
  selected: SelectedModel;
  run?: RunRecord;
  /** A new user turn may compact; a continuation after approval never does. */
  resumed: boolean;
}

/** Wire cancellation and the timeout, start streaming, and hand completion to finish.ts. */
async function beginTurn(res: AgentResources, lease: OperationLease, options: BeginOptions): Promise<TurnStream> {
  const { session, selected, run, mode } = options;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason ?? new DOMException('Canceled', 'AbortError'));
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => controller.abort(new DOMException('Task exceeded its execution timeout.', 'TimeoutError')), limitsOf(res.config).timeoutMs);
  lease.activate({ sessionId: session.id, runId: run?.id, mode, startedAt: new Date().toISOString() }, controller);

  const outcome: TurnOutcome = { model: { key: selected.key, ...modelInfo(selected.model) }, steps: [] };
  const context = executionContext(res, mode, controller.signal, outcome, selected, run);
  res.activeTurn = { sessionId: session.id, context };
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
    if (res.activeTurn?.context === context) res.activeTurn = undefined;
  };
  const stream = () => runWithExecutionContext(context, () => startModelStream(res, session, context, outcome, selected, run));
  let source: ReadableStream<UIMessageChunk>;
  try {
    if (!options.resumed) await runWithExecutionContext(context, () => maybeCompact(res, session, context, outcome));
    source = await stream();
  } catch (error) {
    cleanup();
    throw error;
  }
  const [persisted, client] = source.tee();
  const state: TurnState = {
    res, session, run, mode, controller, lease, outcome, context, resumed: options.resumed, stream, cleanup,
    base: { usage: run?.usage, costUsd: run?.costUsd, steps: run?.steps ?? [] },
  };
  const completed = runWithExecutionContext(context, () => completeTurn(state, persisted));
  // Completion is observed even when an HTTP client disconnects.
  void completed.catch(() => {});
  lease.track(completed);
  return {
    sessionId: session.id, runId: run?.id,
    stream: detachable(client), completed,
    cancel: () => controller.abort(new DOMException('Canceled by user.', 'AbortError')),
  };
}

/** Accept one chat or task turn. Throws BusyError, InputError, or RunError (task failed before streaming). */
export async function streamTurn(res: AgentResources, request: TurnInput): Promise<TurnStream> {
  res.gate.assertIdle();
  const { mode, inputs } = validateRequest(request);
  const lease = await res.gate.acquire();
  let session: SessionRecord | undefined;
  let run: RunRecord | undefined;
  try {
    await res.recoverUnlocked();
    session = await openSession(res, request);
    const selected = chooseModel(res, session, request.model);
    const files = await attachmentParts(res.workspace, request.attachments);
    if (mode === 'task') run = await openRun(res, request, session.id, selected, inputs);
    if (run && files.length) {
      run.provenance!.attachments = await Promise.all(attachedPaths([{ id: '', role: 'user', parts: files }]).map(path => hashFile(res.root, path)));
      await res.runs.save(run);
    }
    session.messages.push({ id: request.messageId ? opaqueId(request.messageId) : randomUUID(), role: 'user', parts: [{ type: 'text', text: request.message }, ...files] });
    session.state = 'running';
    delete session.error;
    session.activeRunId = run?.id;
    await res.sessions.save(session);
    return await beginTurn(res, lease, { signal: request.signal, mode, session, selected, run, resumed: false });
  } catch (error) {
    try {
      await abandon(res, error, session, run);
    } finally {
      await lease.release();
    }
    if (run) throw new RunError(run, error);
    throw error;
  }
}

export interface RespondInput {
  sessionId: string;
  /** One decision per pending tool call. */
  approvals: unknown;
  signal?: AbortSignal;
}

/** Answer the tool calls a turn paused on, then continue the same assistant message (and run). */
export async function respondTurn(res: AgentResources, input: RespondInput): Promise<TurnStream> {
  res.gate.assertIdle();
  const decisions = parseDecisions(input.approvals);
  const lease = await res.gate.acquire();
  let session: SessionRecord | undefined;
  let run: RunRecord | undefined;
  try {
    await res.recoverUnlocked();
    session = await res.sessions.load(input.sessionId);
    if (session.state !== 'awaiting_approval') throw new InputError('This session has no tool call waiting for approval.');
    await assertSessionCompatible(res, session);
    applyDecisions(session, decisions);
    if (session.activeRunId) {
      run = await res.runs.load(session.activeRunId);
      if (run.execution !== 'awaiting_approval') throw new InputError(`Run ${run.id} is not waiting for approval.`);
      run.execution = 'running';
      delete run.finishReason;
      await res.runs.save(run);
    }
    const selected = chooseModel(res, session);
    session.state = 'running';
    delete session.error;
    await res.sessions.save(session);
    return await beginTurn(res, lease, { signal: input.signal, mode: run ? 'task' : 'chat', session, selected, run, resumed: true });
  } catch (error) {
    try {
      if (session?.state === 'running') await abandon(res, error, session, run?.execution === 'running' ? run : undefined);
    } finally {
      await lease.release();
    }
    if (run?.execution === 'failed') throw new RunError(run, error);
    throw error;
  }
}

/**
 * Queue a message for the turn running in this session. It reaches the model at the
 * next step, or as a follow-up once the current loop ends. Throws InputError when no
 * turn is running here and BusyError when the turn is already finishing.
 */
export function steerTurn(res: AgentResources, sessionId: string, text: unknown): { queued: number } {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new InputError('Message must contain 1–64000 characters.');
  const active = res.activeTurn;
  if (!active || active.sessionId !== sessionId) throw new InputError('No turn is running in this session in this process. Send it as a new message instead.');
  const queue = active.context.steering!;
  if (!queue.accepting) throw new BusyError('The turn is finishing. Send this as a new message when it is done.');
  queue.pending.push(text.trim());
  return { queued: queue.pending.length };
}

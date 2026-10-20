import { BusyError, InputError, NotFoundError, RunError } from '../errors.js';
import { modelChoices, modelInfo } from '../config/models.js';
import { lockOwner } from '../store/lock.js';
import { checkRunUnlocked } from '../runs/check.js';
import { loadSkill } from '../tools/skills.js';
import { runWithExecutionContext } from '../workspace/context.js';
import { assembleAgent, limitsOf } from './resources.js';
import { addMcp, listMcp, removeMcp, testMcp } from './mcp.js';
import { respondTurn, steerTurn, streamTurn, type RespondInput } from './turn.js';
import { pendingApprovals } from './approval.js';
import { compactionPolicy, compactSession } from './compact.js';
import { helperTools } from './subagent.js';
import { updateToolSwitch } from './switches.js';
import { forgetMemory, listMemory, readMemory } from '../store/memory.js';
import { addSessionUsage, addStep, type Totals } from './steps.js';
import type { AgentConfig, ApprovalDecision, RunRecord, SessionRecord, TurnInput, TurnResult, TurnStream } from '../types.js';

/**
 * createAgent(config) → a project agent.
 *
 *   streamTurn   one chat/task turn as a native AI SDK UI stream (what HTTP and the TUI use)
 *   respond      answer tool calls a turn paused on (approval); continues as a stream
 *   approve      respond and wait: approve or deny every pending call
 *   steer        queue a message for the turn running in a session
 *   compact      summarize a session's older turns now
 *   runTask      run a task to completion; returns its RunRecord (awaiting_approval if paused)
 *   chat         send a chat message to completion
 *   runs.check   recheck a run's outputs without calling the model
 *   skills.read  full SKILL.md text (viewing never marks a Skill as used)
 *   mcp.*        list, test, add and remove project HTTP MCP servers
 *   memory.*     list, read and forget project memory entries
 *   tools.*      per-project switches: disable a tool, or always allow one that needs approval
 *   cancel/close stop the active operation / shut down
 *   native       the underlying ToolLoopAgent (bypasses sessions, runs and checks)
 */
export async function createAgent(input: AgentConfig) {
  const res = await assembleAgent(input);
  const { config, root, gate, sessions, runs } = res;

  async function recover(): Promise<string[]> {
    const lease = await gate.acquire();
    try {
      return await res.recoverUnlocked();
    } finally {
      await lease.release();
    }
  }

  // Record leftovers from a previous crash. Another live process may own the project; that is fine.
  try {
    await recover();
  } catch (error) {
    if (!(error instanceof BusyError)) {
      await res.mcp.close();
      throw error;
    }
  }

  /** Recheck under the operation gate so it never overlaps a turn. */
  async function check(id: string): Promise<RunRecord> {
    const lease = await gate.acquire();
    try {
      await res.recoverUnlocked();
      const run = await runs.load(id);
      const controller = new AbortController();
      lease.activate({ sessionId: run.session.id, runId: run.id, mode: 'task', startedAt: new Date().toISOString() }, controller);
      const done = checkRunUnlocked(config, id, controller.signal).finally(() => lease.release());
      lease.track(done);
      return await done;
    } finally {
      await lease.release();
    }
  }

  /** Drain the UI stream ourselves; persistence happens either way. */
  async function consume(turn: TurnStream): Promise<TurnResult> {
    const reader = turn.stream.getReader();
    try {
      while (!(await reader.read()).done) { /* The SDK stream is the shared CLI/Web transport. */ }
    } finally {
      reader.releaseLock();
    }
    return turn.completed;
  }

  /** Read a Skill's full text without an execution context, so it is not recorded as loaded. */
  async function readSkill(name: string) {
    const skill = res.skills.find(candidate => candidate.name === name);
    if (!skill) throw new NotFoundError(`Unknown skill: ${name}`);
    const content = await runWithExecutionContext({}, () => loadSkill(res.workspace, res.skills, name, undefined, { includeLocation: false }));
    return { ...skill, content };
  }

  /** Approve or deny every pending call (or pass explicit decisions) and wait for the turn. */
  async function approve(sessionId: string, decision: boolean | ApprovalDecision[], reason?: string): Promise<TurnResult> {
    const session = await sessions.load(sessionId);
    const pending = pendingApprovals(session);
    if (session.state !== 'awaiting_approval' || !pending.length) throw new InputError('This session has no tool call waiting for approval.');
    const approvals = Array.isArray(decision) ? decision : pending.map(item => ({ approvalId: item.approvalId, approved: decision, ...(reason ? { reason } : {}) }));
    return consume(await respondTurn(res, { sessionId, approvals }));
  }

  /** Summarize older turns now, under the operation gate. */
  async function compact(sessionId: string): Promise<SessionRecord> {
    const lease = await gate.acquire();
    try {
      await res.recoverUnlocked();
      const session = await sessions.load(sessionId);
      if (session.state === 'running' || session.state === 'awaiting_approval') throw new InputError('Finish or answer the current turn before compacting.');
      const totals: Totals = {};
      const modelKey = session.model && Object.hasOwn(config.models ?? {}, session.model) ? session.model : undefined;
      const changed = await compactSession(config, session, res.tools, { modelKey, onStep: step => addStep(config, totals, step) });
      if (!changed) throw new InputError('Nothing to compact: the session has no turns older than the ones always kept.');
      addSessionUsage(session, totals, false);
      await sessions.save(session);
      return session;
    } finally {
      await lease.release();
    }
  }

  async function inspect() {
    const [sessionList, runList, owner, mcp, memory] = await Promise.all([sessions.list(), runs.list(), lockOwner(root), listMcp(res), listMemory(root)]);
    const unavailable = mcp.servers.filter(server => server.status === 'unavailable').map(server => `MCP ${server.name} unavailable: ${server.error}`);
    return {
      project: root,
      busy: gate.busy || !!owner,
      active: gate.active ? { ...gate.active } : undefined,
      model: modelInfo(config.model),
      models: modelChoices(config),
      limits: limitsOf(config),
      approval: config.approval ?? [],
      subagents: Object.entries(helperTools(config, res.tools, res.needsApproval)).map(([name, tools]) => ({
        name, description: config.subagents![name].description, model: config.subagents![name].model ?? 'session', maxSteps: config.subagents![name].maxSteps ?? 8, tools: Object.keys(tools),
      })),
      pricing: config.pricing ?? {},
      compaction: compactionPolicy(config) ?? false,
      memory: config.memory === false ? false : memory.entries.map(({ content: _content, ...entry }) => entry),
      skills: res.skills,
      tools: Object.keys(res.tools).sort(),
      toolDetails: res.toolDetails.map(detail => ({
        ...detail,
        enabled: res.switches.enabled(detail.name),
        alwaysAllow: detail.needsApproval && res.switches.allowed(detail.name),
      })),
      toolSettings: res.switches.settings,
      mcp: mcp.servers,
      fileAccess: config.fileAccess ?? { mode: 'analysis' as const },
      pythonScripts: Object.entries(config.python?.scripts ?? {}).map(([name, script]) => ({ name, description: script.description, modes: script.modes ?? ['chat', 'task'] })),
      ui: config.ui ?? {},
      sessions: sessionList.sessions.map(({ messages: _messages, ...record }) => record),
      runs: runList.runs,
      issues: [...sessionList.issues, ...runList.issues, ...mcp.issues, ...memory.issues, ...unavailable],
    };
  }

  let closing: Promise<void> | undefined;

  return {
    config,
    /** The current ToolLoopAgent; replaced when project MCP servers change. */
    get native() { return res.native; },
    sessions,
    runs: { ...runs, check },
    skills: { list: () => res.skills, read: readSkill },
    mcp: {
      list: () => listMcp(res),
      test: (draft: unknown) => testMcp(res, draft),
      add: (draft: unknown) => addMcp(res, draft),
      remove: (name: string) => removeMcp(res, name),
    },
    memory: {
      list: async () => (await listMemory(root)).entries,
      read: (name: string) => readMemory(root, name),
      forget: (name: string) => forgetMemory(root, name),
    },
    tools: {
      settings: () => res.switches.settings,
      /** { name, enabled?, alwaysAllow? }; applies from the next model step. */
      update: (change: unknown) => updateToolSwitch(res, change),
    },
    streamTurn: (request: TurnInput) => streamTurn(res, request),
    respond: (input: RespondInput) => respondTurn(res, input),
    approve,
    steer: (sessionId: string, text: string) => steerTurn(res, sessionId, text),
    compact,
    async runTask(task: string, options: Omit<TurnInput, 'message' | 'mode'> = {}): Promise<RunRecord> {
      const result = await consume(await streamTurn(res, { ...options, message: task, mode: 'task' }));
      if (result.error) throw new RunError(result.run!, result.error);
      return result.run!;
    },
    async chat(message: string, options: Omit<TurnInput, 'message' | 'mode'> = {}): Promise<TurnResult> {
      const result = await consume(await streamTurn(res, { ...options, message, mode: 'chat' }));
      if (result.error) throw new Error(result.error);
      return result;
    },
    cancel: () => gate.cancel(),
    recover,
    inspect,
    close(): Promise<void> {
      return closing ??= (async () => {
        try {
          await gate.close();
        } finally {
          await res.mcp.close();
        }
      })();
    },
  };
}

export type LabAgent = Awaited<ReturnType<typeof createAgent>>;

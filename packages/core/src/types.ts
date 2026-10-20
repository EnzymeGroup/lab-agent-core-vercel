import type { LanguageModel, ToolSet, UIMessage, UIMessageChunk, ToolLoopAgentSettings } from 'ai';

// ─── Configuration ──────────────────────────────────────────────────────────

export type TurnMode = 'chat' | 'task';

/** Limits what model file tools may read and write. Host code is never sandboxed. */
export interface FileAccessPolicy {
  /** analysis (default): writes only in the current run output. development: also writeRoots. */
  mode?: 'analysis' | 'development';
  readRoots?: string[];
  writeRoots?: string[];
}

/** A trusted Python entry point the model may call by name through runPython. */
export interface PythonScript {
  path: string;
  description: string;
  /** Defaults to both modes; [] disables the script. */
  modes?: TurnMode[];
  timeoutMs?: number;
}

export interface McpServerConfig {
  transport: 'stdio' | 'http';
  /** Optional servers that fail to connect are reported and skipped. */
  optional?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Workbench presentation. Has no effect on execution or provenance. */
export interface UiConfig {
  /** Product name shown in the header and browser title. */
  title?: string;
  /** Short line under the empty-state heading. */
  tagline?: string;
  /** CSS hex color (#rrggbb) used for primary actions. */
  accent?: string;
  /** Clickable suggestions shown in an empty conversation. */
  starters?: Array<{ title: string; prompt: string; mode?: TurnMode }>;
}

/** A focused helper the main agent can delegate to through the runSubagent tool. */
export interface SubagentConfig {
  description: string;
  instructions: string;
  /** Tool names from the main tool set. Defaults to all tools that need no approval. */
  tools?: string[];
  /** Key from config.models; defaults to the session's model. */
  model?: string;
  /** Default 8. */
  maxSteps?: number;
}

/** USD per million tokens, keyed by model key ("default" or a config.models key). */
export interface ModelPrice { input: number; output: number; cachedInput?: number }

export interface CompactionConfig {
  /** Summarize older turns when the model's view reaches this fraction of the budget. Default 0.75. */
  at?: number;
  /** Most recent user turns always kept verbatim. Default 2. */
  keepTurns?: number;
  /** Model key used to write the summary; defaults to the session's model. */
  model?: string;
}

export interface AgentConfig {
  root: string;
  /** The default model, offered as "default" in the workbench. */
  model: LanguageModel;
  /** Extra named models a session may switch to. Keys: letters, digits, _ and -; "default" is reserved. */
  models?: Record<string, LanguageModel>;
  /**
   * Tool names that pause the turn until a person approves or denies the call.
   * Exact names or a trailing-* prefix such as "mcp_*". Default none.
   */
  approval?: string[];
  /** Named helpers exposed through the runSubagent tool. */
  subagents?: Record<string, SubagentConfig>;
  /** Token prices used for run and session cost. Models without a price report no cost. */
  pricing?: Record<string, ModelPrice>;
  /** Summarize older turns instead of dropping them. false disables it. */
  compaction?: CompactionConfig | false;
  /** Project memory in .lab-agent/memory with saveMemory, readMemory and forgetMemory. Default true. */
  memory?: boolean;
  /** Passed to the native AI SDK telemetry option (OpenTelemetry spans) for every model call. */
  telemetry?: ToolLoopAgentSettings<never, ToolSet>['telemetry'];
  /** Project-scoped host environment; never included in model capabilities. */
  env?: NodeJS.ProcessEnv;
  /** File path (default AGENTS.md) or inline text. */
  instructions?: string | { text: string };
  /** Default .agents/skills. */
  skillsDir?: string;
  /** Native AI SDK tools. */
  tools?: ToolSet;
  python?: { command?: string; args?: string[]; scripts: Record<string, PythonScript> };
  mcp?: Record<string, McpServerConfig>;
  /**
   * Independent delivery checker, run as argv without a shell after each completed task.
   * repairAttempts > 0 sends a failed or partial report back to the agent for another try. Default 0.
   */
  validation?: { command: string[]; timeoutMs?: number; repairAttempts?: number };
  fileAccess?: FileAccessPolicy;
  /** Files fingerprinted with every task. inputs default to data/. */
  provenance?: { inputs?: string[]; code?: string[] };
  /** Native AI SDK hook, applied between Core's bounded context projections. */
  prepareStep?: ToolLoopAgentSettings<never, ToolSet>['prepareStep'];
  /**
   * maxRetries: provider retries with backoff for 429/5xx before a step fails (default 2).
   * maxContextTokens: optional token budget measured from the provider's reported input tokens.
   * maxTurnTokens: stop a turn once its total tokens reach this budget.
   */
  limits?: {
    maxSteps?: number; timeoutMs?: number; maxToolOutputBytes?: number; maxContextChars?: number;
    maxRetries?: number; maxContextTokens?: number; maxTurnTokens?: number;
  };
  ui?: UiConfig;
}

export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number }

export interface Skill {
  name: string;
  description: string;
  path: string;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** awaiting_approval: the turn paused on tool calls that need a person's decision. */
  state: 'idle' | 'running' | 'interrupted' | 'awaiting_approval';
  /** Complete AI SDK UIMessage history, including tool calls and results. */
  messages: UIMessage[];
  activeRunId?: string;
  error?: string;
  /** Key from config.models chosen for this session; absent means the default model. */
  model?: string;
  /** Older turns replaced by a summary in the model's view. History itself is never rewritten. */
  summary?: SessionSummaryRecord;
  /** Totals across every turn of this session, including subagents and summaries. */
  usage?: Usage & { costUsd?: number; turns: number };
}

export interface SessionSummaryRecord {
  text: string;
  /** Messages up to and including this ID are covered by the summary. */
  throughMessageId: string;
  messageCount: number;
  createdAt: string;
}

/** A tool call waiting for approval. */
export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** One approval decision for respond(). */
export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/** Size of the model's view after Core bounded it, measured on the latest step. */
export interface ContextStats {
  chars: number;
  maxChars: number;
  /** Earlier messages left out of the model's view (still in session history). */
  droppedMessages: number;
  /** Tool results shortened in the model's view; readToolOutput can page through them. */
  clippedResults: number;
  /** Earlier messages represented by the session summary. */
  summarizedMessages?: number;
  /** Input tokens the provider reported for the previous step, and the configured token budget. */
  tokens?: number;
  maxTokens?: number;
}

/** Stored on each assistant UIMessage as `metadata`. */
export interface TurnMetadata {
  model?: { key: string; provider: string; id: string };
  context?: ContextStats;
  usage?: Usage;
  costUsd?: number;
}

// ─── Runs and delivery ──────────────────────────────────────────────────────

/** awaiting_approval is not terminal: the run continues after respond(). */
export type ExecutionStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'aborted';
export type DeliveryStatus = 'not_checked' | 'passed' | 'partial' | 'failed';

/** The JSON a checker writes to AGENT_CHECK_FILE. */
export interface CheckReport {
  status: Exclude<DeliveryStatus, 'not_checked'>;
  checks: Array<{ name: string; status: string; [key: string]: unknown }>;
  issues: string[];
}

export interface FileHash { path: string; sha256: string; bytes: number }
export interface SkillFingerprint extends FileHash { name: string; loaded: boolean; loadedAt?: string }

/** Byte-level baseline captured when a task is accepted. */
export interface RunProvenance {
  coreVersion: string;
  aiSdkVersion: string;
  /** Host versions when the task started. python: the configured interpreter's --version output. */
  environment?: { node: string; platform: string; arch: string; python?: string; conda?: string };
  inputs: FileHash[];
  inputSelection?: { source: 'turn' | 'config' | 'default'; paths: string[] };
  skills?: SkillFingerprint[];
  /** Memory entries listed in the model's index when the task started. */
  memory?: { name: string; sha256: string; updatedAt: string }[];
  /** Images and PDFs attached to the task message. */
  attachments?: FileHash[];
  /** Project tool switches in effect when the task started, when any are set. */
  toolSettings?: { disabled: string[]; alwaysAllow: string[] };
  code: FileHash[];
  configHash: string;
  validationHash: string;
  artifacts: FileHash[];
}

/** One immutable check result. Every check appends one. */
export interface CheckObservation {
  id: string;
  /** repair: the check after an automatic repair attempt (validation.repairAttempts). */
  kind: 'initial' | 'repair' | 'recheck';
  checkedAt: string;
  delivery: DeliveryStatus;
  report: string | null;
  log: string | null;
  artifactHashes: FileHash[];
  inputChanges: string[];
  codeChanges: string[];
  artifactChanges: string[];
  validationHash?: string;
}

export interface RunRecord {
  schemaVersion?: number;
  id: string;
  directory: string;
  task: string;
  startedAt: string;
  finishedAt?: string;
  /** Did the model/tool loop finish? Independent of delivery. */
  execution: ExecutionStatus;
  /** Did the independent checker accept the output? */
  delivery: DeliveryStatus;
  session: { id: string; file?: string };
  /** key is the config.models entry used ("default" for config.model). */
  model?: { provider: string; id: string; key?: string };
  artifacts: string[];
  text?: string;
  error?: string;
  finishReason?: string;
  usage?: Usage;
  /** Present when every model used has a configured price. */
  costUsd?: number;
  /** One record per model call, in order. */
  steps?: StepRecord[];
  /** Automatic repair attempts made after failed checks. */
  repairs?: number;
  provenance?: RunProvenance;
  originalDelivery?: CheckObservation;
  checks?: CheckObservation[];
  pendingCheck?: { id: string; startedAt: string; kind: CheckObservation['kind'] };
  workflowId?: string;
  parentRunId?: string;
}

export interface StepRecord {
  /** main, a subagent name, or "summary". */
  agent: string;
  model: string;
  finishReason: string;
  usage: Usage;
  ms: number;
  tools: Array<{ name: string; ms?: number; error?: boolean }>;
}

// ─── Turns ──────────────────────────────────────────────────────────────────

export interface TurnInput {
  message: string;
  messageId?: string;
  sessionId?: string;
  mode?: TurnMode;
  /** "default" or a key from config.models. Omitted keeps the session's current model. */
  model?: string;
  /** Task-only: project paths frozen as this run's inputs. [] means none. */
  inputs?: string[];
  /** Images or PDFs (project paths) shown to the model with this message. Provider support varies. */
  attachments?: string[];
  workflowId?: string;
  parentRunId?: string;
  signal?: AbortSignal;
}

export interface TurnResult {
  session: SessionRecord;
  run?: RunRecord;
  text: string;
  error?: string;
  /** Tool calls the turn paused on; answer them with respond(). */
  pendingApprovals?: PendingApproval[];
}

export interface TurnStream {
  sessionId: string;
  runId?: string;
  stream: ReadableStream<UIMessageChunk>;
  completed: Promise<TurnResult>;
  cancel(): void;
}

import type { LanguageModel, ToolSet, UIMessage, UIMessageChunk, ToolLoopAgentSettings } from 'ai';

export interface FileAccessPolicy {
  mode?: 'analysis' | 'development';
  readRoots?: string[];
  writeRoots?: string[];
}

export interface PythonScript {
  path: string;
  description: string;
  timeoutMs?: number;
}
export interface McpServerConfig {
  optional?: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export interface AgentConfig {
  root: string;
  model: LanguageModel;
  /** Project-scoped host environment; never included in model capabilities. */
  env?: NodeJS.ProcessEnv;
  fileAccess?: FileAccessPolicy;
  provenance?: { inputs?: string[]; code?: string[] };
  prepareStep?: ToolLoopAgentSettings<never, ToolSet>['prepareStep'];
  instructions?: string | { text: string };
  skillsDir?: string;
  tools?: ToolSet;
  python?: { command?: string; args?: string[]; scripts: Record<string, PythonScript> };
  mcp?: Record<string, McpServerConfig>;
  validation?: { command: string[]; timeoutMs?: number };
  limits?: { maxSteps?: number; timeoutMs?: number; maxToolOutputBytes?: number; maxContextChars?: number };
}
export interface Skill {
  name: string;
  description: string;
  path: string;
}
export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'interrupted';
  messages: UIMessage[];
  activeRunId?: string;
  error?: string;
}
export type DeliveryStatus = 'not_checked' | 'passed' | 'partial' | 'failed';
export interface CheckReport {
  status: Exclude<DeliveryStatus, 'not_checked'>;
  checks: Array<{ name: string; status: string; [key: string]: unknown }>;
  issues: string[];
}
export interface RunRecord {
  schemaVersion?: number;
  provenance?: RunProvenance;
  originalDelivery?: CheckObservation;
  checks?: CheckObservation[];
  pendingCheck?: { id: string; startedAt: string; kind: 'initial' | 'recheck' };
  workflowId?: string;
  parentRunId?: string;
  id: string;
  directory: string;
  task: string;
  startedAt: string;
  finishedAt?: string;
  execution: 'running' | 'completed' | 'failed' | 'aborted';
  delivery: DeliveryStatus;
  session: { id: string; file?: string };
  model?: { provider: string; id: string };
  artifacts: string[];
  text?: string;
  error?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
export interface FileHash { path: string; sha256: string; bytes: number }
export interface RunProvenance {
  coreVersion: string;
  aiSdkVersion: string;
  inputs: FileHash[];
  code: FileHash[];
  configHash: string;
  validationHash: string;
  artifacts: FileHash[];
}
export interface CheckObservation {
  id: string;
  kind: 'initial' | 'recheck';
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
export interface TurnInput {
  workflowId?: string;
  parentRunId?: string;
  message: string;
  messageId?: string;
  sessionId?: string;
  mode?: 'chat' | 'task';
  signal?: AbortSignal;
}
export interface TurnResult {
  session: SessionRecord;
  run?: RunRecord;
  text: string;
  error?: string;
}
export interface TurnStream {
  sessionId: string;
  runId?: string;
  stream: ReadableStream<UIMessageChunk>;
  completed: Promise<TurnResult>;
  cancel(): void;
}

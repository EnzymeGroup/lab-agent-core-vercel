import type { LanguageModel, ToolSet, UIMessage, UIMessageChunk } from 'ai';

export interface PythonScript {
  path: string;
  description: string;
  timeoutMs?: number;
}
export interface McpServerConfig {
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
export interface TurnInput {
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

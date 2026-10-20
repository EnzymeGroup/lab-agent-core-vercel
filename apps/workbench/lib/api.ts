import type { CheckReport, ModelPrice, PendingApproval, RunRecord, SessionRecord, Skill, TurnMetadata, UiConfig } from '../../../packages/core/src/types';

export type { CheckReport, PendingApproval, RunRecord, SessionRecord, Skill, TurnMetadata, UiConfig };
export interface Subagent { name: string; description: string; model: string; maxSteps: number; tools: string[] }
export interface ModelChoice { key: string; provider: string; id: string; default: boolean }
export interface McpServer {
  name: string;
  transport: string;
  optional: boolean;
  status: 'configured' | 'connected' | 'unavailable';
  error?: string;
  tools?: string[];
  source?: 'config' | 'project';
  url?: string;
  headerNames?: string[];
}
export interface McpTestResult extends Omit<McpServer, 'tools'> { tools: Array<{ name: string; description: string }> }
export type SessionSummary = Omit<SessionRecord, 'messages'>;
export interface UploadedFile {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  importedAt: string;
}
export interface UploadListing {
  files: UploadedFile[];
  maxBytes: number;
  extensions: string[];
  /** Extensions that can be attached to a message (images, PDFs). */
  attachable?: string[];
}
/** An imported file chosen in Input files: attach it to the next message, or bind it as a task input. */
export interface DraftReference { id: string; text: string; path: string; attach: boolean }
// Mirrors of server limits, for immediate feedback; the server still enforces them.
export const MAX_TASK_INPUTS = 256;
export const MAX_ATTACHMENTS = 8;
export interface ArtifactPreview {
  kind: 'csv' | 'json' | 'markdown' | 'text' | 'image';
  path: string;
  bytes: number;
  truncated: boolean;
  content?: string;
  rows?: string[][];
  mediaType?: string;
}
export interface MemoryEntry { name: string; description: string; type: 'user' | 'feedback' | 'project' | 'reference'; updatedAt: string }
/** enabled and alwaysAllow come from the project's tool switches (.lab-agent/tools.json). */
export interface ToolDetail { name: string; description: string; inputSchema: unknown; needsApproval?: boolean; enabled?: boolean; alwaysAllow?: boolean }
export interface AgentState {
  project: string;
  busy: boolean;
  active?: { sessionId: string; runId?: string; mode: 'chat' | 'task'; startedAt: string };
  model: { provider: string; id: string };
  models?: ModelChoice[];
  limits?: { maxSteps: number; timeoutMs: number; maxContextChars: number; maxRetries?: number; maxContextTokens?: number; maxTurnTokens?: number };
  approval?: string[];
  subagents?: Subagent[];
  pricing?: Record<string, ModelPrice>;
  compaction?: { at: number; keepTurns: number; model?: string } | false;
  memory?: MemoryEntry[] | false;
  skills: Skill[];
  tools: string[];
  toolDetails?: ToolDetail[];
  toolSettings?: { disabled: string[]; alwaysAllow: string[] };
  pythonScripts?: Array<{ name: string; description: string; modes: Array<'chat' | 'task'> }>;
  mcp?: McpServer[];
  fileAccess?: { mode?: 'analysis' | 'development'; readRoots?: string[]; writeRoots?: string[] };
  sessions: SessionSummary[];
  runs: RunRecord[];
  issues: string[];
  ui?: UiConfig;
  demo: boolean;
}

export async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

/** Download a run artifact's raw bytes through the authenticated API. */
export async function fetchArtifact(token: string, runId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const query = `runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`;
  const response = await fetch(`/api/artifact?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store' });
  if (!response.ok) throw new Error(await responseError(response));
  return response.blob();
}

export async function responseError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return typeof data?.error?.message === 'string'
      ? data.error.message
      : `Request failed (${response.status} ${response.statusText}).`;
  } catch {
    return `Request failed (${response.status} ${response.statusText}).`;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** USD with enough precision for small per-call costs. */
export function formatCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`;
}

export function duration(startedAt: string, finishedAt?: string): string {
  const seconds = Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : Date.now()) - Date.parse(startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

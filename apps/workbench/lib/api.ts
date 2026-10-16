import type { CheckReport, RunRecord, SessionRecord, Skill } from '../../../packages/core/src/types';

export type { CheckReport, RunRecord, SessionRecord };
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
}
export interface ArtifactPreview {
  kind: 'csv' | 'json' | 'markdown' | 'text' | 'image';
  path: string;
  bytes: number;
  truncated: boolean;
  content?: string;
  rows?: string[][];
  mediaType?: string;
}
export interface AgentState {
  project: string;
  busy: boolean;
  active?: { sessionId: string; runId?: string; mode: 'chat' | 'task'; startedAt: string };
  model: { provider: string; id: string };
  skills: Skill[];
  tools: string[];
  toolDetails?: Array<{ name: string; description: string; inputSchema: unknown }>;
  mcp?: Array<{ name: string; transport: string; optional: boolean; status: 'connected' | 'unavailable'; error?: string }>;
  fileAccess?: { mode?: 'analysis' | 'development'; readRoots?: string[]; writeRoots?: string[] };
  sessions: SessionSummary[];
  runs: RunRecord[];
  issues: string[];
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

export function duration(startedAt: string, finishedAt?: string): string {
  const seconds = Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : Date.now()) - Date.parse(startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

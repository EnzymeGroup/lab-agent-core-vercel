'use client';

import { Boxes, ChevronRight, FolderOpen, LoaderCircle, Plus, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { formatDate, type AgentState } from '../lib/api';
import { cn } from '../lib/utils';
import type { CapabilitySection } from './capabilities';
import { BrandMark } from './brand';
import InputFiles from './input-files';
import { Button } from './ui/button';

/** Brand, session list, input imports and the capabilities entry point. */

interface Props {
  token: string;
  state?: AgentState;
  title: string;
  sessionId: string;
  creating: boolean;
  canCreate: boolean;
  onNewSession(): void;
  onSelectSession(id: string): void;
  onUseInput(path: string): void;
  onShowCapabilities(section?: CapabilitySection): void;
}

export default function Sidebar({ token, state, title, sessionId, creating, canCreate, onNewSession, onSelectSession, onUseInput, onShowCapabilities }: Props) {
  const project = state ? state.project.split('/').filter(Boolean).at(-1) || state.project : '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <a href="/" className="hidden h-14 shrink-0 items-center gap-2.5 px-4 desk:flex" aria-label={`${title} workbench home`}>
        <BrandMark title={title} />
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold">{title}</span>
          <span className="block text-[11px] text-muted-foreground">Agent workbench</span>
        </span>
      </a>

      <div className="space-y-2 px-3 pt-3 desk:pt-1">
        <Button variant="outline" className="w-full justify-start" onClick={onNewSession} disabled={!canCreate || creating} aria-label="New session">
          <Plus />{creating ? 'Creating…' : 'New session'}
        </Button>
        {state
          ? (
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground" title={state.project}>
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="sr-only">Project</span>
              <span className="truncate font-medium text-foreground/80">{project}</span>
            </div>
          )
          : <p className="px-2.5 py-1.5 text-xs text-muted-foreground">Connecting to your project…</p>}
      </div>

      <h2 className="px-5 pt-3 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Sessions</h2>
      <nav aria-label="Saved sessions" className="scroll-area min-h-0 flex-1 space-y-0.5 px-2 pb-2">
        {state?.sessions.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            No sessions yet. Create one to start a conversation or a task.
          </div>
        )}
        {state?.sessions.map(item => {
          const selected = sessionId === item.id;
          return (
            <button key={item.id} type="button" onClick={() => onSelectSession(item.id)} aria-current={selected ? 'true' : undefined}
              className={cn('flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors',
                selected ? 'bg-accent' : 'hover:bg-accent/60')}>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[13px]', selected ? 'font-medium' : 'text-foreground/85')}>{item.title || 'Untitled session'}</span>
                <time className="mt-0.5 block text-[11px] text-muted-foreground" dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
              </span>
              {item.state === 'running' && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-warning" aria-label="running" />}
              {item.state === 'awaiting_approval' && <ShieldQuestion className="size-3.5 shrink-0 text-warning" aria-label="needs approval" />}
              {item.state === 'interrupted' && <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-label={item.state} />}
            </button>
          );
        })}
      </nav>

      <div className="scroll-area max-h-[55%] shrink-0">
        <InputFiles token={token} busy={!!state?.busy} onUse={onUseInput} />
      </div>
      <div className="border-t p-2">
        <button type="button" onClick={() => onShowCapabilities()} disabled={!state}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-accent/60 disabled:opacity-50">
          <Boxes className="size-3.5 text-muted-foreground" />
          Capabilities
          <span className="ml-auto text-[11px] font-normal text-muted-foreground tabular">{(state?.tools.length ?? 0) + (state?.skills.length ?? 0)} tools & skills</span>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
        <div className="grid grid-cols-3 gap-1 px-1 pt-1">
          {([['skills', 'Skills', state?.skills.length], ['tools', 'Tools', state?.tools.length], ['mcp', 'MCP', state?.mcp?.length]] as const).map(([section, label, count]) => {
            const mcpIssue = section === 'mcp' && state?.mcp?.some(server => server.status === 'unavailable');
            return (
              <button key={section} type="button" disabled={!state} onClick={() => onShowCapabilities(section)} aria-label={`Open ${label} (${count ?? 0})`}
                className="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-50">
                {mcpIssue && <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />}
                {label}<span className="tabular text-foreground">{count ?? 0}</span>
              </button>
            );
          })}
        </div>
        <p className="px-3 pt-1 text-[11px] text-muted-foreground/80">One project · one active operation</p>
      </div>
    </div>
  );
}

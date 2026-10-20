'use client';

import { ChevronRight, ListChecks, Square } from 'lucide-react';
import { duration, type AgentState } from '../lib/api';
import type { PlanItem } from '../lib/messages';
import type { Mode } from './composer';
import { PlanChecklist } from './message';
import { Button } from './ui/button';

/** Presentational pieces of the conversation view. Stable hooks: .conversation-empty, .plan-panel, .activity-toolbar. */

export function Notice({ tone = 'neutral', role, children }: { tone?: 'neutral' | 'danger'; role?: 'alert' | 'status'; children: React.ReactNode }) {
  return (
    <div role={role} className={tone === 'danger'
      ? 'inline-error flex gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm'
      : 'flex gap-3 rounded-md border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground'}>
      {children}
    </div>
  );
}

export function EmptyConversation({ state, onStarter }: { state?: AgentState; onStarter(prompt: string, mode?: Mode): void }) {
  const starters = state?.ui?.starters ?? [];
  return (
    <div className="conversation-empty mx-auto max-w-2xl px-6 pt-16 pb-8 desk:pt-24">
      <h2 className="text-lg font-semibold">What should we work on?</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{state?.ui?.tagline ?? 'Describe what you need and the files or acceptance criteria that matter.'}</p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        <strong className="font-medium text-foreground">Task</strong> creates a tracked run with outputs and a separate delivery check.{' '}
        <strong className="font-medium text-foreground">Chat</strong> continues the session without a run.
      </p>
      {starters.length > 0 && (
        <ul className="mt-6 divide-y rounded-md border">
          {starters.map(starter => (
            <li key={starter.title}>
              <button type="button" onClick={() => onStarter(starter.prompt, starter.mode)} className="block w-full px-3 py-2.5 text-left transition-colors hover:bg-accent">
                <span className="flex items-baseline gap-2 text-sm font-medium">
                  {starter.title}
                  <span className="text-[11px] font-normal text-muted-foreground">{starter.mode === 'chat' ? 'Chat' : 'Task'}</span>
                </span>
                <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">{starter.prompt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlanPanel({ items }: { items: PlanItem[] }) {
  const done = items.filter(item => item.status === 'done').length;
  return (
    <details className="plan-panel group rounded-md border bg-background text-xs" open={done < items.length || undefined}>
      <summary className="flex items-center gap-2 px-3 py-2">
        <ListChecks className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Plan</span>
        <span className="tabular text-muted-foreground">{done}/{items.length}</span>
        <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t px-3 py-2"><PlanChecklist items={items} /></div>
    </details>
  );
}

/** Shown above the composer while a turn runs: mode, elapsed time, the current tool, and Stop. */
export function ActivityBar({ mode, startedAt, step, restoring, stopping, onStop }: {
  mode: Mode; startedAt: string; step?: string; restoring: boolean; stopping: boolean; onStop(): void;
}) {
  return (
    <div role="status" className="activity-toolbar flex items-center gap-3 rounded-md border bg-muted/50 py-1 pr-1 pl-3 text-xs">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
      <strong className="font-medium">{mode === 'chat' ? 'Chat in progress' : 'Task in progress'}</strong>
      <span className="tabular text-muted-foreground">{duration(startedAt)}</span>
      {step && <span className="hidden min-w-0 truncate text-muted-foreground md:inline">· <code className="font-mono text-foreground/80">{step}</code></span>}
      {restoring && <span className="hidden text-muted-foreground sm:inline">Running on server · restoring history</span>}
      <Button variant="outline" size="xs" className="ml-auto" onClick={onStop} disabled={stopping}>
        <Square className="fill-current" />{stopping ? 'Stopping…' : 'Stop'}
      </Button>
    </div>
  );
}

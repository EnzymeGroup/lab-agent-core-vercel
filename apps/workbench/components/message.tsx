'use client';

import type { UIMessage } from 'ai';
import { useState } from 'react';
import { Brain, Check, ChevronRight, Circle, CircleCheck, CircleDot, CircleX, Copy, CornerDownRight, ExternalLink, LoaderCircle, ShieldQuestion, Wrench } from 'lucide-react';
import { cn } from '../lib/utils';
import { Markdown } from './markdown';
import { Button } from './ui/button';

/**
 * One UIMessage. Assistant turns render as an agent timeline: text blocks, and
 * runs of tool calls / reasoning grouped into numbered steps.
 * Stable hooks used by tests and custom themes:
 * .message-user / .message-assistant, .tool-call > summary code, .tool-body.
 */

type Part = UIMessage['parts'][number];
type ToolPart = { type: string; toolName?: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string; preliminary?: boolean; approval?: { id: string; approved?: boolean; reason?: string } };
type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'done' };
type HelperOutput = { agent?: string; status?: 'working' | 'done'; steps?: number; tools?: string[]; text?: string };

/** Answer a tool call that is waiting for approval. `always` also stops this tool from asking again. */
export type ApproveHandler = (approvalId: string, approved: boolean, always?: { toolName: string }) => void;

const phase: Record<string, string> = {
  'input-streaming': 'Preparing', 'input-available': 'Running', 'output-available': 'Done',
  'output-error': 'Failed', 'output-denied': 'Denied', 'approval-requested': 'Needs approval', 'approval-responded': 'Answered',
};

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'Waiting for data…';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** First short string argument, shown next to the tool name (e.g. a path or script name). */
function argumentHint(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return;
  const value = Object.values(input).find(item => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 80) : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return;
  }
}

const isStep = (part: Part) => part.type === 'reasoning' || part.type === 'dynamic-tool' || part.type.startsWith('tool-');
const Label = ({ children }: { children: string }) => <span className="mb-1 block text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{children}</span>;
const Pre = ({ children }: { children: string }) => <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">{children}</pre>;

/** Timeline node: status icon on the rail, collapsible content to the right. */
function Node({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="relative">
      <span aria-hidden="true" className="absolute top-2 -left-[34px] flex size-[19px] items-center justify-center rounded-full bg-background ring-1 ring-border [&_svg]:size-3">{icon}</span>
      {children}
    </li>
  );
}
export function PlanChecklist({ items }: { items: PlanItem[] }) {
  return (
    <ul className="plan-items space-y-1 text-xs">
      {items.map((item, index) => (
        <li key={index} className={cn('flex items-start gap-2', item.status === 'done' && 'text-muted-foreground line-through')}>
          {item.status === 'done' ? <CircleCheck className="mt-px size-3.5 shrink-0 text-success" /> : item.status === 'in_progress' ? <CircleDot className="mt-px size-3.5 shrink-0 text-warning" /> : <Circle className="mt-px size-3.5 shrink-0 text-muted-foreground" />}
          <span>{item.step}<span className="sr-only"> ({item.status.replace('_', ' ')})</span></span>
        </li>
      ))}
    </ul>
  );
}

const planItems = (input: unknown): PlanItem[] | undefined => {
  const items = (input as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items as PlanItem[] : undefined;
};

/** Tool-specific views; the raw arguments and output stay one click away. */
function ToolView({ name, part }: { name: string; part: ToolPart }) {
  if (name === 'updatePlan' && planItems(part.input)) return <PlanChecklist items={planItems(part.input)!} />;
  if (name === 'runSubagent') {
    const output = part.output as HelperOutput | undefined;
    const task = (part.input as { task?: string } | undefined)?.task;
    return (
      <div className="space-y-2">
        {task && <div><Label>Task</Label><p className="text-xs whitespace-pre-wrap">{task}</p></div>}
        {output?.status === 'working' && <p className="text-xs text-muted-foreground">Working · {output.steps ?? 0} step(s){output.tools?.length ? ` · ${output.tools.join(', ')}` : ''}</p>}
        {output?.status === 'done' && <div><Label>Answer</Label><div className="text-sm"><Markdown>{output.text || '(no text)'}</Markdown></div></div>}
      </div>
    );
  }
  return null;
}

function ToolCall({ part, onApprove }: { part: ToolPart; onApprove?: ApproveHandler }) {
  const name = part.toolName || part.type.slice(5);
  const failed = part.state === 'output-error' || part.state === 'output-denied';
  const done = part.state === 'output-available' && !part.preliminary;
  const asking = part.state === 'approval-requested';
  const approval = asking || part.state === 'approval-responded';
  const hint = name === 'runSubagent' ? (part.input as { agent?: string } | undefined)?.agent : argumentHint(part.input);
  const icon = failed ? <CircleX className="text-destructive" /> : done ? <CircleCheck className="text-success" />
    : approval ? <ShieldQuestion className="text-warning" /> : <LoaderCircle className="animate-spin text-muted-foreground" />;
  const view = <ToolView name={name} part={part} />;
  const special = name === 'updatePlan' || name === 'runSubagent';
  const label = part.state === 'approval-responded' ? (part.approval?.approved ? 'Approved' : 'Denied') : phase[part.state] ?? part.state.replaceAll('-', ' ');
  return (
    <Node icon={icon}>
      <details open={failed || asking || special || undefined} className={cn('tool-call group rounded-md border bg-background', failed && 'tool-failed border-destructive/40', asking && 'tool-approval border-warning/60')}>
        <summary className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
          <code className="shrink-0 font-mono font-medium text-foreground">{name}</code>
          {hint && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{hint}</span>}
          <span className={cn('tool-phase ml-auto shrink-0 text-[11px]', failed ? 'text-destructive' : done ? 'text-muted-foreground' : 'text-foreground')}>{label}</span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="tool-body space-y-3 border-t px-3 py-3">
          {special ? view : <div><Label>Arguments</Label><Pre>{printable(part.input)}</Pre></div>}
          {special ? (
            <details className="text-xs">
              <summary className="text-muted-foreground">Raw arguments and output</summary>
              <div className="mt-2 space-y-2"><Pre>{printable(part.input)}</Pre>{part.output !== undefined && <Pre>{printable(part.output)}</Pre>}</div>
            </details>
          ) : part.output !== undefined && <div><Label>Output</Label><Pre>{printable(part.output)}</Pre></div>}
          {part.errorText && <p className="tool-error text-xs text-destructive" role="alert">{part.errorText}</p>}
          {part.state === 'output-denied' && <p className="tool-error text-xs text-destructive">Tool execution was denied{part.approval?.reason ? `: ${part.approval.reason}` : '.'}</p>}
          {asking && (
            <div className="approval-actions flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-3 py-2" role="group" aria-label={`Approval for ${name}`}>
              <p className="mr-auto text-xs">This tool needs your approval before it runs.</p>
              {onApprove ? (
                <>
                  <Button size="xs" variant="outline" aria-label={`Deny ${name}`} onClick={() => onApprove(part.approval!.id, false)}>Deny</Button>
                  <Button size="xs" variant="outline" aria-label={`Always allow ${name}`} title="Approve, and stop asking for this tool in this project"
                    onClick={() => onApprove(part.approval!.id, true, { toolName: name })}>Always allow</Button>
                  <Button size="xs" aria-label={`Approve ${name}`} onClick={() => onApprove(part.approval!.id, true)}>Approve</Button>
                </>
              ) : <span className="text-xs text-muted-foreground">Open this session to answer.</span>}
            </div>
          )}
        </div>
      </details>
    </Node>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Node icon={<Brain className="text-muted-foreground" />}>
      <details className="group py-1 text-xs text-muted-foreground">
        <summary className="flex items-center gap-1.5 py-1">
          <span>{streaming ? 'Thinking…' : 'Thought'}</span>
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        </summary>
        <p className="mt-1 border-l-2 pl-3 leading-relaxed whitespace-pre-wrap">{text}</p>
      </details>
    </Node>
  );
}

function Content({ part, user }: { part: Part; user: boolean }) {
  if (part.type === 'step-start') return null;
  if (part.type === 'data-steer') {
    return (
      <p className="steer-note flex items-start gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs">
        <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span><span className="text-muted-foreground">You, while it was running: </span>{String((part as { data?: { text?: unknown } }).data?.text ?? '')}</span>
      </p>
    );
  }
  if (part.type === 'text') {
    return user ? <p className="whitespace-pre-wrap break-words">{part.text}</p> : <Markdown>{part.text}</Markdown>;
  }
  if (part.type === 'source-url' || part.type === 'file') {
    const href = safeUrl(part.url);
    const label = part.type === 'source-url' ? part.title || href : part.filename || 'Attached file';
    if (!href) return <p className="text-xs text-muted-foreground">Attachment: {part.type === 'file' ? part.filename || part.mediaType : label}</p>;
    return <a className="inline-flex items-center gap-1 text-xs underline underline-offset-4 hover:text-muted-foreground" href={href} target="_blank" rel="noreferrer">{label}<ExternalLink className="size-3" /></a>;
  }
  return (
    <details className="rounded-md border px-3 py-2 text-xs">
      <summary className="text-muted-foreground">{part.type}</summary>
      <Pre>{printable(part)}</Pre>
    </details>
  );
}

/** Consecutive tool/reasoning parts become one timeline; everything else renders inline. */
function group(parts: Part[]) {
  const groups: Array<{ steps: boolean; parts: Part[] }> = [];
  for (const part of parts) {
    if (part.type === 'step-start') continue;
    const steps = isStep(part);
    const last = groups.at(-1);
    if (last && last.steps === steps && steps) last.parts.push(part);
    else groups.push({ steps, parts: [part] });
  }
  return groups;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Clipboard unavailable; text remains selectable. */ }
  };
  return (
    <button type="button" onClick={() => { void copy(); }} aria-label="Copy response" title="Copy response"
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100">
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export default function Message({ message, title, onApprove }: { message: UIMessage; title: string; onApprove?: ApproveHandler }) {
  const source = (message.metadata as { source?: string } | undefined)?.source;
  if (message.role === 'user' && source === 'repair') {
    const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    return (
      <article className="message message-repair" aria-label="Automatic repair">
        <details className="group rounded-md border border-dashed px-3 py-2 text-xs">
          <summary className="flex items-center gap-2 text-muted-foreground"><Wrench className="size-3.5" />{text.split('\n')[0]}<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" /></summary>
          <p className="mt-2 whitespace-pre-wrap">{text}</p>
        </details>
      </article>
    );
  }
  if (message.role === 'user') {
    return (
      <article className="message message-user flex flex-col items-end gap-1" aria-label="You message">
        {source === 'steer' && <span className="text-[11px] text-muted-foreground">Sent while the agent was working</span>}
        <div className="max-w-[85%] min-w-0 space-y-2 rounded-lg bg-muted px-3.5 py-2 leading-relaxed">
          {message.parts.map((part, index) => <Content key={index} part={part} user />)}
        </div>
      </article>
    );
  }
  const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n');
  return (
    <article className={cn('message group/message', `message-${message.role}`)} aria-label={`${message.role === 'assistant' ? 'Agent' : 'System'} message`}>
      <div className="mb-1.5 flex h-7 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{message.role === 'assistant' ? title : 'System'}</span>
        {text && <span className="ml-auto"><CopyButton text={text} /></span>}
      </div>
      <div className="min-w-0 space-y-3">
        {group(message.parts).map((item, index) => item.steps ? (
          <ol key={index} aria-label="Agent steps" className="relative ml-2.5 space-y-1.5 border-l pl-6">
            {item.parts.map((part, step) => part.type === 'reasoning'
              ? <Reasoning key={step} text={part.text} streaming={part.state === 'streaming'} />
              : <ToolCall key={(part as unknown as ToolPart).toolCallId ?? step} part={part as unknown as ToolPart} onApprove={onApprove} />)}
          </ol>
        ) : item.parts.map((part, part_index) => <Content key={`${index}-${part_index}`} part={part} user={false} />))}
      </div>
    </article>
  );
}

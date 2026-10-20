'use client';

import { useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { ArrowUp, ChevronRight, FlaskConical, MessageSquare, Paperclip, X } from 'lucide-react';
import { formatCost, type ModelChoice, type SessionRecord, type TurnMetadata } from '../lib/api';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/**
 * Message box with Task/Chat mode and explicit task input bindings.
 * Stable hooks: .task-inputs > summary, .task-input-body, .chat-policy.
 */

export type Mode = 'chat' | 'task';
const MAX_BINDINGS = 256;

interface Props {
  sessionId: string;
  mode: Mode;
  onModeChange(mode: Mode): void;
  input: string;
  onInputChange(value: string): void;
  boundInputs: string[];
  onBoundInputsChange(update: (previous: string[]) => string[]): void;
  bindingError: string;
  onBindingError(message: string): void;
  /** Images and PDFs shown to the model with the next message (chat or task). */
  attachments: string[];
  onRemoveAttachment(path: string): void;
  /** Number of registered Python scripts allowed in chat, when the server reports it. */
  chatScripts?: number;
  blocked: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onSubmit(): void;
  /** Configured models; the picker shows when there is more than one. */
  models: ModelChoice[];
  model: string;
  onModelChange(key: string): void;
  /** Bounded context measured on the latest step of this session. */
  context?: TurnMetadata['context'];
  /** This session's turn is running here: Enter queues the message for its next step. */
  steering?: boolean;
  usage?: SessionRecord['usage'];
  /** Summarize older turns now; absent when compaction is off or a turn is active. */
  onCompact?(): void;
  compacting?: boolean;
}

/** The larger of the character and token budgets decides the percentage. */
function ContextMeter({ context, usage, onCompact, compacting }: Pick<Props, 'context' | 'usage' | 'onCompact' | 'compacting'>) {
  if (!context) return null;
  const byChars = context.chars / context.maxChars;
  const byTokens = context.tokens !== undefined && context.maxTokens ? context.tokens / context.maxTokens : 0;
  const percent = Math.min(100, Math.round(Math.max(byChars, byTokens) * 100));
  const trimmed = context.droppedMessages + context.clippedResults;
  const detail = `${context.chars.toLocaleString()} of ${context.maxChars.toLocaleString()} characters sent on the last step`
    + (context.tokens !== undefined ? ` (${context.tokens.toLocaleString()} input tokens${context.maxTokens ? ` of ${context.maxTokens.toLocaleString()}` : ''})` : '')
    + (context.summarizedMessages ? `; ${context.summarizedMessages} earlier message(s) summarized` : '')
    + (context.droppedMessages ? `; ${context.droppedMessages} earlier message(s) left out` : '')
    + (context.clippedResults ? `; ${context.clippedResults} tool result(s) shortened` : '')
    + '. Full history stays on disk.'
    + (usage ? ` Session: ${(usage.totalTokens ?? 0).toLocaleString()} tokens${usage.costUsd !== undefined ? `, ${formatCost(usage.costUsd)}` : ''}.` : '');
  return (
    <span className="context-meter flex items-center gap-1.5 text-[11px] text-muted-foreground" title={detail}>
      <span aria-hidden="true" className="h-1 w-12 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full', percent >= 85 ? 'bg-warning' : 'bg-muted-foreground/60')} style={{ width: `${percent}%` }} />
      </span>
      <span>Context {percent}%{context.summarizedMessages ? ' · summarized' : trimmed ? ' · trimmed' : ''}</span>
      <span className="sr-only">{detail}</span>
      {onCompact && percent >= 50 && (
        <button type="button" onClick={onCompact} disabled={compacting} className="rounded-sm px-1 underline underline-offset-2 hover:text-foreground disabled:opacity-50">
          {compacting ? 'Summarizing…' : 'Compact'}
        </button>
      )}
    </span>
  );
}

function ModeSwitch({ sessionId, mode, onChange, disabled }: { sessionId: string; mode: Mode; onChange(mode: Mode): void; disabled: boolean }) {
  const options = [{ value: 'task' as const, label: 'Task', icon: FlaskConical }, { value: 'chat' as const, label: 'Chat', icon: MessageSquare }];
  return (
    <fieldset className="inline-flex rounded-md border p-0.5" disabled={disabled}>
      <legend className="sr-only">Interaction mode</legend>
      {options.map(({ value, label, icon: Icon }) => (
        <label key={value} className={cn(
          'relative flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
          mode === value && 'bg-accent text-foreground',
        )}>
          {/* Transparent and covering the label, so the input itself is the click target. */}
          <input className="absolute inset-0 m-0 cursor-pointer appearance-none opacity-0" type="radio" name={`mode-${sessionId}`} value={value} checked={mode === value} onChange={() => onChange(value)} />
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

function TaskInputs({ boundInputs, onChange, error, onError, blocked }: { boundInputs: string[]; onChange: Props['onBoundInputsChange']; error: string; onError(message: string): void; blocked: boolean }) {
  const [path, setPath] = useState('');
  const add = () => {
    const value = path.trim().replace(/^\.\//, '');
    if (!value) return;
    if (/^(?:[/\\]|[A-Za-z]:)/.test(value) || value.split(/[/\\]/).includes('..')) {
      onError('Use a project-relative file or directory path without parent-directory segments.');
      return;
    }
    if (boundInputs.length >= MAX_BINDINGS && !boundInputs.includes(value)) {
      onError('A task can bind up to 256 input declarations. Remove one before adding another.');
      return;
    }
    onChange(previous => previous.includes(value) ? previous : [...previous, value]);
    setPath('');
    onError('');
  };
  return (
    <details className="task-inputs group border-b" open={boundInputs.length > 0 || undefined}>
      <summary className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Paperclip className="size-3.5" />
        Task inputs
        <span className={cn('text-[11px]', boundInputs.length && 'font-medium text-foreground')}>{boundInputs.length ? `${boundInputs.length} explicit` : 'Project defaults'}</span>
        <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="task-input-body space-y-2 px-3 pb-3 text-xs">
        <p className="text-muted-foreground">
          {boundInputs.length
            ? 'These bindings override project defaults for task turns until removed. Only the recorded files are rechecked.'
            : 'Project defaults will select inputs. The server freezes the file set when this task starts.'}
        </p>
        {boundInputs.length > 0 && (
          <ul aria-label="Task input bindings" className="flex flex-wrap gap-1.5">
            {boundInputs.map(item => (
              <li key={item} className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-muted py-0.5 pr-0.5 pl-2">
                <code className="truncate font-mono text-[11px]">{item}</code>
                <button type="button" aria-label={`Remove input ${item}`} disabled={blocked} onClick={() => onChange(previous => previous.filter(value => value !== item))}
                  className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="task-input-path">Project-relative input path</label>
          <input id="task-input-path" value={path} onChange={event => setPath(event.target.value)} placeholder="data/input.csv or a directory" disabled={blocked}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground" />
          <Button size="sm" variant="outline" disabled={blocked || !path.trim()} onClick={add}>Add input</Button>
        </div>
        {boundInputs.length > 0 && (
          <Button size="sm" variant="link" className="h-auto px-0" disabled={blocked} onClick={() => { onChange(() => []); onError(''); }}>Use project defaults</Button>
        )}
        {error && <p className="text-destructive" role="alert">{error}</p>}
      </div>
    </details>
  );
}

export default function Composer(props: Props) {
  const { mode, input, blocked, boundInputs } = props;
  const submit = (event?: FormEvent) => { event?.preventDefault(); props.onSubmit(); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  };
  const chatPolicy = props.chatScripts === undefined
    ? 'Check Capabilities for the configured script modes.'
    : `${props.chatScripts} Python script(s) allowed in Chat; task-only scripts are unavailable.`;
  return (
    <form className="composer overflow-hidden rounded-lg border bg-background transition-colors focus-within:border-foreground/30" onSubmit={submit}>
      {mode === 'task'
        ? <TaskInputs boundInputs={boundInputs} onChange={props.onBoundInputsChange} error={props.bindingError} onError={props.onBindingError} blocked={blocked} />
        : (
          <p className="chat-policy border-b px-3 py-2 text-xs text-muted-foreground" role="note">
            Chat creates no task run. Enabled Python and native tools can have side effects on the host. {chatPolicy}
            {boundInputs.length > 0 && ' Task input bindings are retained for Task mode and omitted from Chat.'}
          </p>
        )}
      {props.attachments.length > 0 && (
        <ul className="message-attachments flex flex-wrap gap-1.5 border-b px-3 py-2" aria-label="Attachments">
          {props.attachments.map(path => (
            <li key={path} className="flex max-w-full items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-[11px]">
              <Paperclip className="size-3 shrink-0 text-muted-foreground" />
              <code className="min-w-0 truncate font-mono">{path.split('/').at(-1)}</code>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove attachment ${path}`}
                onClick={() => props.onRemoveAttachment(path)} disabled={blocked}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="message-input" className="sr-only">Message to agent</label>
      <textarea id="message-input" ref={props.textarea} value={input} rows={3} disabled={blocked} aria-describedby="composer-help"
        onChange={event => props.onInputChange(event.target.value)} onKeyDown={onKey}
        placeholder={props.steering ? 'Add a note for the running agent…' : mode === 'task' ? 'Describe the task and how to check the result…' : 'Ask about your project…'}
        className="block max-h-60 min-h-[72px] w-full resize-none bg-transparent px-3 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground field-sizing-content" />
      <div className="flex items-center gap-3 px-2 pt-1 pb-2">
        <ModeSwitch sessionId={props.sessionId} mode={mode} onChange={props.onModeChange} disabled={blocked || !!props.steering} />
        {props.models.length > 1 && (
          <>
            <label htmlFor={`model-${props.sessionId}`} className="sr-only">Model</label>
            <select id={`model-${props.sessionId}`} value={props.model} onChange={event => props.onModelChange(event.target.value)} disabled={blocked || !!props.steering}
              className="h-7 max-w-40 truncate rounded-md border bg-background px-1.5 text-xs disabled:opacity-50">
              {props.models.map(choice => <option key={choice.key} value={choice.key}>{choice.key === 'default' ? `${choice.id} (default)` : `${choice.key} · ${choice.id}`}</option>)}
            </select>
          </>
        )}
        <ContextMeter context={props.context} usage={props.usage} onCompact={props.onCompact} compacting={props.compacting} />
        <span id="composer-help" className="sr-only">Enter to send, Shift + Enter for a new line</span>
        <Button type="submit" size="sm" className="ml-auto" disabled={!input.trim() || blocked}>
          {props.steering ? 'Send to running turn' : mode === 'task' ? 'Run task' : 'Send message'}
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}

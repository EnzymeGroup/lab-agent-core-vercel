'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, ListChecks, LoaderCircle, ShieldQuestion, Square } from 'lucide-react';
import { api, duration, errorMessage, responseError, type AgentState, type SessionRecord, type TurnMetadata } from '../lib/api';
import Composer, { type Mode } from './composer';
import Message, { PlanChecklist } from './message';
import { Button } from './ui/button';

/**
 * One session. The server owns history: the browser sends only the newest user
 * message, and after any stream ends (or the page reloads mid-run) it restores
 * the saved session rather than trusting its local buffer.
 */

interface Props {
  token: string;
  session: SessionRecord;
  state?: AgentState;
  draftReference?: { id: string; text: string; path: string };
  onStateRefresh(): Promise<AgentState | undefined>;
  onSessionUpdate(session: SessionRecord): void;
}

const MAX_BINDINGS = 256;
const MAX_ATTACHMENTS = 8;
const ATTACHABLE = /\.(?:png|jpe?g|gif|webp|pdf)$/iu;

function Notice({ tone = 'neutral', role, children }: { tone?: 'neutral' | 'danger'; role?: 'alert' | 'status'; children: React.ReactNode }) {
  return (
    <div role={role} className={tone === 'danger'
      ? 'inline-error flex gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm'
      : 'flex gap-3 rounded-md border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground'}>
      {children}
    </div>
  );
}

function EmptyConversation({ state, onStarter }: { state?: AgentState; onStarter(prompt: string, mode?: Mode): void }) {
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

/** Bounded context size from the newest assistant message that recorded it. */
function latestContext(messages: UIMessage[]): TurnMetadata['context'] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const context = (messages[index].metadata as TurnMetadata | undefined)?.context;
    if (messages[index].role === 'assistant' && context) return context;
  }
}

type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'done' };

/** The newest updatePlan call in this session, shown above the composer. */
function latestPlan(messages: UIMessage[]): PlanItem[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = messages[index].parts;
    for (let part = parts.length - 1; part >= 0; part--) {
      const item = parts[part] as { type: string; input?: { items?: PlanItem[] } };
      if (item.type === 'tool-updatePlan' && Array.isArray(item.input?.items)) return item.input.items;
    }
  }
}

function PlanPanel({ items }: { items: PlanItem[] }) {
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

const hasPendingApproval = (messages: UIMessage[]) => messages.at(-1)?.role === 'assistant'
  && messages.at(-1)!.parts.some(part => (part as { state?: string }).state === 'approval-requested');

/** The newest tool call that has not finished, for the activity bar. */
function currentStep(messages: UIMessage[]): string | undefined {
  const parts = messages.at(-1)?.role === 'assistant' ? messages.at(-1)!.parts : [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] as { type: string; toolName?: string; state?: string };
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      return part.state === 'input-streaming' || part.state === 'input-available' ? part.toolName || part.type.slice(5) : undefined;
    }
  }
}

export default function Conversation({ token, session, state, draftReference, onStateRefresh, onSessionUpdate }: Props) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('task');
  const [model, setModel] = useState(session.model ?? 'default');
  const [boundInputs, setBoundInputs] = useState<string[]>([]);
  const [bindingError, setBindingError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [localStart, setLocalStart] = useState('');
  const [steerNote, setSteerNote] = useState('');
  const [compacting, setCompacting] = useState(false);
  const [, tick] = useState(0);
  // Refs let the memoized transport read the latest values without being recreated.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const modelRef = useRef(model);
  modelRef.current = model;
  const boundInputsRef = useRef(boundInputs);
  boundInputsRef.current = boundInputs;
  const [attachments, setAttachments] = useState<string[]>([]);
  /** Set only for the duration of one send, so the transport sends what the composer showed. */
  const attachmentsRef = useRef<string[]>([]);
  const refreshRef = useRef(onStateRefresh);
  refreshRef.current = onStateRefresh;
  const restoreRef = useRef<() => Promise<void>>(async () => {});
  const textarea = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const shouldFollow = useRef(true);
  const mounted = useRef(true);
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const insertedReference = useRef<string | undefined>(undefined);

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    headers: { Authorization: `Bearer ${token}` },
    // A new turn sends the newest user message. Answering an approval sends the assistant
    // message that carries the decisions; the server reads only the decisions from it.
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages.at(-1);
      if (last?.role === 'assistant') return { body: { sessionId: session.id, messages: [last] } };
      return {
        body: {
          sessionId: session.id, mode: modeRef.current, model: modelRef.current,
          ...(modeRef.current === 'task' && boundInputsRef.current.length ? { inputs: [...boundInputsRef.current] } : {}),
          ...(attachmentsRef.current.length ? { attachments: [...attachmentsRef.current] } : {}),
          messages: messages.filter(message => message.role === 'user').slice(-1),
        },
      };
    },
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(await responseError(response));
      void refreshRef.current();
      return response;
    },
  }), [token, session.id]);

  /** Restore now and once more shortly after, since persistence may trail the stream. */
  const settle = () => {
    void restoreRef.current();
    pendingTimers.current.push(setTimeout(() => { if (mounted.current) void restoreRef.current(); }, 700));
  };

  const { messages, sendMessage, setMessages, status, stop, clearError, addToolApprovalResponse } = useChat({
    id: session.id,
    messages: session.messages,
    transport,
    // Continue as soon as every pending tool call in the last message has an answer.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: error => { if (mounted.current) { setStreamError(error.message); settle(); } },
    onFinish: event => {
      if (!mounted.current) return;
      if (event.isDisconnect) setStreamError('The stream disconnected. The server may still be working; the saved session is being refreshed.');
      else if (event.isError) setStreamError(previous => previous || 'The turn ended with an error. See the saved session and run details.');
      settle();
    },
  });

  const streaming = status === 'submitted' || status === 'streaming';
  const runningHere = !!state?.busy && state.active?.sessionId === session.id;
  const working = streaming || runningHere;
  const awaiting = session.state === 'awaiting_approval' || (!working && hasPendingApproval(messages));
  // While this session's turn runs here, the composer sends steering instead of a new turn.
  const steering = working && runningHere;
  const blocked = (streaming && !steering) || (!!state?.busy && !steering) || stopping || awaiting;
  const title = state?.ui?.title ?? 'Lab Agent';

  const restore = useCallback(async () => {
    await refreshRef.current();
    try {
      const record = await api<SessionRecord>(token, `/api/session?id=${encodeURIComponent(session.id)}`);
      if (!mounted.current) return;
      onSessionUpdate(record);
      // Never replace the SDK buffer during a live stream.
      if (!streaming) setMessages(record.messages);
    } catch (error) {
      if (mounted.current) setStreamError(previous => previous || `Could not refresh the saved session: ${errorMessage(error)}`);
    }
  }, [token, session.id, streaming, onSessionUpdate, setMessages]);
  restoreRef.current = restore;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pendingTimers.current.forEach(clearTimeout); };
  }, []);
  useEffect(() => { if (!streaming) setMessages(session.messages); }, [session.messages, streaming, setMessages]);
  // Work accepted before a reload keeps running on the server; poll its saved history.
  useEffect(() => {
    if (!runningHere || streaming) return;
    const timer = setInterval(() => { void restoreRef.current(); }, 1600);
    return () => clearInterval(timer);
  }, [runningHere, streaming]);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [working]);
  useEffect(() => { if (shouldFollow.current) end.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [messages]);
  useEffect(() => { textarea.current?.focus(); }, [session.id]);
  // An imported file was chosen for this task: insert its path and bind it. Never auto-send.
  useEffect(() => {
    if (!draftReference || draftReference.id === insertedReference.current) return;
    insertedReference.current = draftReference.id;
    // Images and PDFs are shown to the model with the next message instead of being bound as task inputs.
    if (ATTACHABLE.test(draftReference.path)) {
      // The effect runs once per reference, so reading this render's attachments is current.
      if (attachments.length >= MAX_ATTACHMENTS && !attachments.includes(draftReference.path)) {
        setBindingError(`A message can carry up to ${MAX_ATTACHMENTS} attachments.`);
        return;
      }
      setBindingError('');
      setAttachments(previous => previous.includes(draftReference.path) ? previous : [...previous, draftReference.path]);
      textarea.current?.focus();
      return;
    }
    setMode('task');
    if (boundInputsRef.current.length >= MAX_BINDINGS && !boundInputsRef.current.includes(draftReference.path)) {
      setBindingError('A task can bind up to 256 input declarations. Remove one before using another uploaded file.');
      return;
    }
    setBindingError('');
    setInput(previous => previous ? `${previous}\n${draftReference.text}` : draftReference.text);
    setBoundInputs(previous => previous.includes(draftReference.path) ? previous : [...previous, draftReference.path]);
    textarea.current?.focus();
  }, [draftReference]);

  async function steer(text: string) {
    try {
      await api(token, '/api/steer', { method: 'POST', body: JSON.stringify({ sessionId: session.id, text }) });
      setInput('');
      setSteerNote('Sent. The agent sees it at its next step.');
    } catch (error) {
      setSteerNote(`Not sent: ${errorMessage(error)}`);
    }
  }

  async function compact() {
    if (compacting) return;
    setCompacting(true);
    try {
      await api(token, '/api/compact', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) });
      await restoreRef.current();
    } catch (error) {
      setStreamError(`Could not compact: ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setCompacting(false);
    }
  }

  async function approve(approvalId: string, approved: boolean, always?: { toolName: string }) {
    setStreamError('');
    clearError();
    if (always) {
      try {
        await api(token, '/api/tools', { method: 'PUT', body: JSON.stringify({ name: always.toolName, alwaysAllow: true }) });
      } catch (error) {
        setStreamError(`Could not set always allow: ${errorMessage(error)}`);
        return;
      }
    }
    shouldFollow.current = true;
    void addToolApprovalResponse({ id: approvalId, approved, ...(approved ? {} : { reason: 'Denied in the workbench.' }) });
  }

  async function submit() {
    const text = input.trim();
    if (text && steering) {
      await steer(text);
      return;
    }
    if (!text || blocked) return;
    setInput('');
    setStreamError('');
    clearError();
    setLocalStart(new Date().toISOString());
    shouldFollow.current = true;
    // The transport reads the attachments for this send; the composer clears at once.
    attachmentsRef.current = attachments;
    setAttachments([]);
    try {
      await sendMessage({ text });
    } finally {
      attachmentsRef.current = [];
    }
  }

  async function cancel() {
    if (stopping) return;
    setStopping(true);
    try {
      const result = await api<{ canceled: boolean }>(token, '/api/cancel', { method: 'POST' });
      await stop();
      if (!result.canceled) setStreamError('No active operation was found. The saved session has been refreshed.');
      await restoreRef.current();
    } catch (error) {
      setStreamError(`Cancellation was not confirmed: ${errorMessage(error)}. Reconnect and check the active operation before retrying.`);
    } finally {
      if (mounted.current) setStopping(false);
    }
  }

  const activeMode = state?.active?.sessionId === session.id ? state.active.mode : mode;
  const startedAt = state?.active?.sessionId === session.id ? state.active.startedAt : localStart || new Date().toISOString();
  const attention = streamError || session.error;
  const step = working ? currentStep(messages) : undefined;
  const plan = latestPlan(messages);
  useEffect(() => { if (!working) setSteerNote(''); }, [working]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollArea} className="scroll-area min-h-0 flex-1" onScroll={() => {
        const element = scrollArea.current;
        if (element) shouldFollow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      }}>
        {messages.length ? (
          <div className="messages mx-auto max-w-3xl space-y-8 px-4 pt-8 pb-6 desk:px-8">
            {session.summary && (
              <p className="compaction-note rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" role="note">
                The agent sees the first {session.summary.messageCount} messages as a summary. The full history below is unchanged.
              </p>
            )}
            {messages.map(message => <Message key={message.id} message={message} title={title} onApprove={awaiting && !streaming ? (id, approved, always) => { void approve(id, approved, always); } : undefined} />)}
            {(status === 'submitted' || (runningHere && messages.at(-1)?.role === 'user')) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Working…
              </div>
            )}
            <div ref={end} />
          </div>
        ) : <EmptyConversation state={state} onStarter={(prompt, starterMode) => { setInput(prompt); if (starterMode) setMode(starterMode); textarea.current?.focus(); }} />}
      </div>

      <div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-4 pb-4 desk:px-8 desk:pb-6">
        {working && (
          <div role="status" className="activity-toolbar flex items-center gap-3 rounded-md border bg-muted/50 py-1 pr-1 pl-3 text-xs">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
            <strong className="font-medium">{activeMode === 'chat' ? 'Chat in progress' : 'Task in progress'}</strong>
            <span className="tabular text-muted-foreground">{duration(startedAt)}</span>
            {step && <span className="hidden min-w-0 truncate text-muted-foreground md:inline">· <code className="font-mono text-foreground/80">{step}</code></span>}
            {!streaming && <span className="hidden text-muted-foreground sm:inline">Running on server · restoring history</span>}
            <Button variant="outline" size="xs" className="ml-auto" onClick={() => { void cancel(); }} disabled={stopping}>
              <Square className="fill-current" />{stopping ? 'Stopping…' : 'Stop'}
            </Button>
          </div>
        )}
        {plan && <PlanPanel items={plan} />}
        {steerNote && <p className="steer-status text-xs text-muted-foreground" role="status">{steerNote}</p>}
        {awaiting && !streaming && (
          <Notice role="status"><ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" /><p><strong className="font-medium text-foreground">Waiting for your approval.</strong> Approve or deny the tool call above to continue this turn.</p></Notice>
        )}
        {state?.busy && !runningHere && !streaming && <Notice role="status">The project has an active operation. New turns are available when it finishes.</Notice>}
        {session.state === 'interrupted' && (
          <Notice role="status"><CircleAlert className="mt-0.5 size-4 shrink-0" /><p><strong className="font-medium text-foreground">This session was interrupted.</strong> Saved tool evidence is preserved. Review the last turn before sending a new message; tools will not be replayed automatically.</p></Notice>
        )}
        {attention && (
          <Notice tone="danger" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <strong className="font-medium">Turn needs attention</strong>
              <p className="mt-0.5 break-words text-muted-foreground">{attention}</p>
            </div>
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => { void restore(); }}>Refresh saved result</Button>
          </Notice>
        )}
        <Composer
          sessionId={session.id} mode={mode} onModeChange={setMode} input={input} onInputChange={setInput}
          boundInputs={boundInputs} onBoundInputsChange={setBoundInputs} bindingError={bindingError} onBindingError={setBindingError}
          attachments={attachments} onRemoveAttachment={path => setAttachments(previous => previous.filter(item => item !== path))}
          chatScripts={state?.pythonScripts?.filter(script => script.modes.includes('chat')).length}
          blocked={blocked} steering={steering} textarea={textarea} onSubmit={() => { void submit(); }}
          models={state?.models ?? []} model={model} onModelChange={setModel} context={latestContext(messages)}
          usage={session.usage} onCompact={state?.compaction && !working && !awaiting ? () => { void compact(); } : undefined} compacting={compacting}
        />
      </div>
    </div>
  );
}

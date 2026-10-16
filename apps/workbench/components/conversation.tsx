'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, duration, errorMessage, responseError, type AgentState, type SessionRecord } from '../lib/api';
import Message from './message';

interface Props {
  token: string;
  session: SessionRecord;
  state?: AgentState;
  draftReference?: { id: string; text: string };
  onStateRefresh(): Promise<AgentState | undefined>;
  onSessionUpdate(session: SessionRecord): void;
}

export default function Conversation({ token, session, state, draftReference, onStateRefresh, onSessionUpdate }: Props) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'chat' | 'task'>('task');
  const [streamError, setStreamError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [localStart, setLocalStart] = useState('');
  const [, tick] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const shouldFollow = useRef(true);
  const restoreRef = useRef<() => Promise<void>>(async () => {});
  const refreshRef = useRef(onStateRefresh);
  refreshRef.current = onStateRefresh;
  const mounted = useRef(true);
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const insertedReference = useRef<string | undefined>(undefined);

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    headers: { Authorization: `Bearer ${token}` },
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { sessionId: session.id, mode: modeRef.current, messages: messages.filter(message => message.role === 'user').slice(-1) },
    }),
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(await responseError(response));
      void refreshRef.current();
      return response;
    },
  }), [token, session.id]);

  function settle() {
    void restoreRef.current();
    pendingTimers.current.push(setTimeout(() => { if (mounted.current) void restoreRef.current(); }, 700));
  }

  const { messages, sendMessage, setMessages, status, stop, clearError } = useChat({
    id: session.id,
    messages: session.messages,
    transport,
    onError: error => { if (mounted.current) { setStreamError(error.message); settle(); } },
    onFinish: event => {
      if (!mounted.current) return;
      if (event.isDisconnect) setStreamError('The stream disconnected. The server may still be working; the saved session is being refreshed.');
      else if (event.isError) setStreamError(previous => previous || 'The turn ended with an error. See the saved session and run details.');
      settle();
    },
  });

  const streaming = status === 'submitted' || status === 'streaming';
  const runningHere = state?.busy && state.active?.sessionId === session.id;
  const working = streaming || !!runningHere;
  const blocked = streaming || !!state?.busy || stopping;
  const restore = useCallback(async () => {
    await refreshRef.current();
    try {
      const record = await api<SessionRecord>(token, `/api/session?id=${encodeURIComponent(session.id)}`);
      if (!mounted.current) return;
      onSessionUpdate(record);
      // The server owns history. Never replace the SDK buffer during a live stream.
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
  useEffect(() => {
    if (!streaming) setMessages(session.messages);
  }, [session.messages, streaming, setMessages]);
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
  useEffect(() => {
    if (shouldFollow.current) end.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages]);
  useEffect(() => { textarea.current?.focus(); }, [session.id]);
  useEffect(() => {
    if (!draftReference || draftReference.id === insertedReference.current) return;
    insertedReference.current = draftReference.id;
    setInput(previous => previous ? `${previous}\n${draftReference.text}` : draftReference.text);
    textarea.current?.focus();
  }, [draftReference]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || blocked) return;
    setInput('');
    setStreamError('');
    clearError();
    setLocalStart(new Date().toISOString());
    shouldFollow.current = true;
    await sendMessage({ text });
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
    } finally { if (mounted.current) setStopping(false); }
  }

  function inputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }

  return <>
    <div className="conversation-heading"><div><h1>{session.title || 'New session'}</h1><span className="model-label" title={state ? `${state.model.provider}/${state.model.id}` : undefined}>{state ? `${state.model.provider} / ${state.model.id}` : 'Loading model…'}</span></div><button className="text-button" onClick={() => { void restore(); }} disabled={streaming} aria-label="Refresh saved session">Refresh</button></div>
    {working && <div className="activity-toolbar" role="status"><span className="activity-indicator" aria-hidden="true" /><strong>{state?.active?.mode === 'chat' || (!state?.active && mode === 'chat') ? 'Chat in progress' : 'Task in progress'}</strong><span className="elapsed">{duration(state?.active?.sessionId === session.id ? state.active.startedAt : localStart || new Date().toISOString())}</span>{!streaming && <span className="background-note">Running on server · restoring history</span>}<button onClick={() => { void cancel(); }} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop'}</button></div>}
    {state?.busy && !runningHere && !streaming && <div className="busy-note" role="status">The project has an active operation. New turns are available when it finishes.</div>}
    {session.state === 'interrupted' && <div className="inline-error" role="status"><strong>This session was interrupted.</strong> Saved tool evidence is preserved. Review the last turn before sending a new message; tools will not be replayed automatically.</div>}
    {(streamError || session.error) && <div className="inline-error" role="alert"><strong>Turn needs attention</strong><p>{streamError || session.error}</p><button className="text-button" onClick={() => { void restore(); }}>Refresh saved result</button></div>}
    <div className="message-scroll" ref={scrollArea} onScroll={() => { const element = scrollArea.current; if (element) shouldFollow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
      {messages.length ? <div className="messages">{messages.map(message => <Message key={message.id} message={message} />)}{status === 'submitted' && <p className="waiting-text" role="status">Waiting for the agent…</p>}<div ref={end} /></div> : <div className="conversation-empty"><h2>Ready for your next task</h2><p>Describe what you need and the files or acceptance criteria that matter.</p><dl><div><dt>Task</dt><dd>Creates a tracked run with outputs and a separate delivery check.</dd></div><div><dt>Chat</dt><dd>Continues this session without creating a task run.</dd></div></dl></div>}
    </div>
    <form className="composer" onSubmit={event => { void submit(event); }}>
      <div className="composer-controls"><fieldset className="mode-switch" disabled={blocked}><legend className="sr-only">Interaction mode</legend>{(['task', 'chat'] as const).map(value => <label key={value} className={mode === value ? 'active' : ''}><input type="radio" name={`mode-${session.id}`} value={value} checked={mode === value} onChange={() => setMode(value)} /><span>{value === 'task' ? 'Task' : 'Chat'}</span></label>)}</fieldset><span className="composer-mode-hint">{mode === 'task' ? 'Track execution & delivery' : 'Continue the conversation'}</span></div>
      <label htmlFor="message-input" className="sr-only">Message to agent</label><textarea id="message-input" ref={textarea} value={input} onChange={event => setInput(event.target.value)} onKeyDown={inputKey} placeholder={mode === 'task' ? 'Describe the task and how to check the result…' : 'Ask about your project…'} rows={3} disabled={blocked} aria-describedby="composer-help" />
      <div className="composer-footer"><span id="composer-help">Enter to send · Shift + Enter for a new line</span><button type="submit" className="primary" disabled={!input.trim() || blocked}>{mode === 'task' ? 'Run task' : 'Send message'} <span aria-hidden="true">↑</span></button></div>
    </form>
  </>;
}

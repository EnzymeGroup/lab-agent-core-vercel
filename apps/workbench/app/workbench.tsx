'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, formatDate, type AgentState, type SessionRecord } from '../lib/api';
import Conversation from '../components/conversation';
import RunPanel from '../components/run-panel';
import InputFiles from '../components/input-files';
import Capabilities from '../components/capabilities';

type Panel = 'conversation' | 'sessions' | 'artifacts';

export default function Workbench() {
  const [token, setToken] = useState('');
  const [state, setState] = useState<AgentState>();
  const [session, setSession] = useState<SessionRecord>();
  const [sessionId, setSessionId] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [connecting, setConnecting] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [creating, setCreating] = useState(false);
  const [panel, setPanel] = useState<Panel>('conversation');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [draftReference, setDraftReference] = useState<{ id: string; text: string; path: string }>();
  const selection = useRef(0);
  const selectedId = useRef('');
  const initialized = useRef(false);

  const refreshState = useCallback(async (auth = token) => {
    if (!auth) return;
    try {
      const next = await api<AgentState>(auth, '/api/state');
      setState(next);
      setConnectionError('');
      return next;
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }, [token]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectionError('');
    try {
      const response = await fetch('/api/bootstrap', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Bootstrap failed (${response.status}). Open the workbench from the local agent server address.`);
      const data = await response.json() as { token?: string };
      if (!data.token) throw new Error('The server did not return an access token. Restart the local agent server, then reconnect.');
      setToken(data.token);
      const next = await api<AgentState>(data.token, '/api/state');
      setState(next);
      if (!initialized.current) {
        let saved: string | null = null;
        try { saved = sessionStorage.getItem('lab-agent-session'); } catch { /* Storage can be disabled. */ }
        const id = next.sessions.some(item => item.id === saved) ? saved! : next.active?.sessionId ?? next.sessions[0]?.id ?? '';
        setSessionId(id);
        selectedId.current = id;
        initialized.current = true;
      }
    } catch (error) {
      setConnectionError(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => { void connect(); }, [connect]);
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);
  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(() => { void refreshState(); }, state?.busy ? 1600 : 7000);
    const refresh = () => { if (document.visibilityState === 'visible') void refreshState(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [token, state?.busy, refreshState]);

  const loadSession = useCallback(async (id: string) => {
    if (!token || !id) return;
    const request = ++selection.current;
    setLoadingSession(true);
    setSessionError('');
    try {
      const record = await api<SessionRecord>(token, `/api/session?id=${encodeURIComponent(id)}`);
      if (request === selection.current) setSession(record);
    } catch (error) {
      if (request === selection.current) { setSession(undefined); setSessionError(errorMessage(error)); }
    } finally {
      if (request === selection.current) setLoadingSession(false);
    }
  }, [token]);

  useEffect(() => {
    selectedId.current = sessionId;
    try {
      if (sessionId) sessionStorage.setItem('lab-agent-session', sessionId);
      else sessionStorage.removeItem('lab-agent-session');
    } catch { /* Session restore remains available in the session list. */ }
    if (sessionId) void loadSession(sessionId);
    else { setSession(undefined); setSessionError(''); }
  }, [sessionId, loadSession]);

  async function newSession() {
    if (!token || creating) return;
    setDraftReference(undefined);
    setCreating(true);
    setSessionError('');
    try {
      const record = await api<SessionRecord>(token, '/api/sessions', { method: 'POST', body: '{}' });
      ++selection.current;
      selectedId.current = record.id;
      setSession(record);
      setSessionId(record.id);
      setPanel('conversation');
      await refreshState();
      return record;
    } catch (error) { setSessionError(errorMessage(error)); }
    finally { setCreating(false); }
  }

  function selectSession(id: string) {
    selectedId.current = id;
    if (id !== sessionId) { setDraftReference(undefined); setSession(undefined); setSessionId(id); }
    setPanel('conversation');
  }

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem('lab-agent-theme', next); } catch { /* Theme still works without persistence. */ }
  }

  async function useInput(path: string) {
    if (!sessionId && !await newSession()) return;
    setDraftReference({ id: crypto.randomUUID(), text: `Input file: ${path}`, path });
    setPanel('conversation');
  }

  return (
    <div className="workbench">
      <a className="skip-link" href="#conversation">Skip to conversation</a>
      <header className="app-header">
        <a className="brand" href="/" aria-label="Lab Agent workbench home"><span className="brand-mark" aria-hidden="true">L</span><span>Lab Agent <span className="brand-subtitle">/ workbench</span></span></a>
        <div className="header-actions">
          {state?.demo && <span className="fixture-label">Demo fixture · no live model</span>}
          <span className={`connection-label ${connectionError ? 'problem' : ''}`}>{connecting ? 'Connecting…' : connectionError ? 'Connection issue' : state?.busy ? 'Working' : 'Connected locally'}</span>
          <button className="icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}><span aria-hidden="true">{theme === 'light' ? '◐' : '☀'}</span></button>
        </div>
      </header>

      {connectionError && <div className="connection-banner" role="alert"><div><strong>Cannot reach the agent.</strong> {connectionError}<span className="error-help">Ensure the local server is running. Reconnect after restarting it to renew the access token. Accepted work may still be running on the server.</span></div><button onClick={() => { void connect(); }} disabled={connecting}>{connecting ? 'Reconnecting…' : 'Reconnect'}</button></div>}
      {state?.issues?.length ? <div className="issues-banner" role="status"><strong>Project needs attention</strong><ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div> : null}

      <nav className="mobile-tabs" aria-label="Workbench panels">{(['sessions', 'conversation', 'artifacts'] as const).map(item => <button key={item} aria-pressed={panel === item} onClick={() => setPanel(item)}>{item === 'sessions' ? 'Sessions' : item === 'conversation' ? 'Conversation' : 'Runs & files'}</button>)}</nav>

      <div className="workspace" data-panel={panel}>
        <aside className="sessions-pane" aria-label="Sessions">
          <div className="pane-heading"><h2>Sessions</h2><button className="text-button" onClick={() => { void newSession(); }} disabled={!token || creating || !!connectionError} aria-label="New session">{creating ? 'Creating…' : '+ New'}</button></div>
          {state ? <div className="project-label" title={state.project}><span className="field-label">PROJECT</span><span>{state.project.split('/').filter(Boolean).at(-1) || state.project}</span></div> : <p className="pane-note">Connecting to your project…</p>}
          <div className="session-list">
            {state?.sessions.length === 0 && <p className="pane-note">No sessions yet. Create one to start a conversation or a task.</p>}
            {state?.sessions.map(item => <button className={`session-item ${sessionId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => selectSession(item.id)} aria-current={sessionId === item.id ? 'true' : undefined}><span className="session-title">{item.title || 'Untitled session'}</span><span className="session-meta"><time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>{item.state !== 'idle' && <span className={`small-status ${item.state}`}>{item.state}</span>}</span></button>)}
          </div>
          <InputFiles token={token} busy={!!state?.busy} onUse={path => { void useInput(path); }} />
          <button className="capabilities-button" onClick={() => setShowCapabilities(true)} disabled={!state}>Capabilities <span>{(state?.tools.length ?? 0) + (state?.skills.length ?? 0)} tools & skills</span></button>
          <div className="sidebar-footer">One project · one active operation</div>
        </aside>

        <main className="conversation-pane" id="conversation" tabIndex={-1}>
          {sessionError && <div className="inline-error" role="alert"><p>{sessionError}</p>{sessionId && <button onClick={() => { void loadSession(sessionId); }}>Retry loading session</button>}</div>}
          {creating ? <div className="empty-state" role="status"><h1>Creating session…</h1><p>Preparing a new conversation.</p></div> : loadingSession && !session ? <div className="empty-state" role="status"><h1>Loading session…</h1><p>Restoring the saved conversation.</p></div> : session && token ? <Conversation key={session.id} token={token} session={session} state={state} draftReference={draftReference} onStateRefresh={refreshState} onSessionUpdate={record => { if (selectedId.current === record.id) setSession(record); }} /> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">↗</span><h1>Your project workspace</h1><p>Start a session to ask a question or run a task. Task outputs and delivery checks appear alongside the conversation.</p><button className="primary" onClick={() => { void newSession(); }} disabled={!state || !!connectionError || creating}>{creating ? 'Creating…' : 'New session'}</button><p className="empty-hint">Task mode creates a tracked run. Chat mode keeps a conversation.</p></div>}
        </main>

        <aside className="artifacts-pane" aria-label="Runs and artifacts"><RunPanel token={token} state={state} sessionId={sessionId} onRefresh={refreshState} onSelectSession={selectSession} /></aside>
      </div>
      {showCapabilities && state && <Capabilities state={state} onClose={() => setShowCapabilities(false)} />}
    </div>
  );
}

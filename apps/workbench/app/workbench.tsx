'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Cpu, Layers, MessageSquare, Moon, PanelLeft, Plus, RefreshCw, Sun, WifiOff } from 'lucide-react';
import { api, errorMessage, formatCost, type AgentState, type DraftReference, type SessionRecord } from '../lib/api';
import { applyBranding, DEFAULT_TITLE } from '../lib/branding';
import { cn } from '../lib/utils';
import Conversation from '../components/conversation';
import RunPanel from '../components/run-panel';
import Sidebar from '../components/sidebar';
import Capabilities, { type CapabilitySection } from '../components/capabilities';
import { BrandMark } from '../components/brand';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

/**
 * Workbench shell: connection + token bootstrap, project state polling, session
 * selection, and the three panes (sessions · conversation · inspector). Below
 * 901px one pane shows at a time; hidden panes stay mounted so their state survives.
 */

type Panel = 'sessions' | 'conversation' | 'artifacts';
const PANELS: Array<{ id: Panel; label: string; icon: typeof Layers }> = [
  { id: 'sessions', label: 'Sessions', icon: PanelLeft },
  { id: 'conversation', label: 'Conversation', icon: MessageSquare },
  { id: 'artifacts', label: 'Runs & files', icon: Layers },
];
const SESSION_KEY = 'lab-agent-session';
const THEME_KEY = 'lab-agent-theme';

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); }, []);
  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* Theme still works without persistence. */ }
  };
  return [theme, toggle] as const;
}

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
  const [capabilities, setCapabilities] = useState<{ section?: CapabilitySection }>();
  const [draftReference, setDraftReference] = useState<DraftReference>();
  const [theme, toggleTheme] = useTheme();
  const selection = useRef(0);
  const selectedId = useRef('');
  const initialized = useRef(false);
  const title = state?.ui?.title ?? DEFAULT_TITLE;

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

  /** Fetch the per-process token, then restore the last session (or the active one). */
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
        try { saved = sessionStorage.getItem(SESSION_KEY); } catch { /* Storage can be disabled. */ }
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
  useEffect(() => { if (state) applyBranding(state.ui); }, [state?.ui?.title, state?.ui?.accent]); // eslint-disable-line react-hooks/exhaustive-deps
  // Poll faster while work is running; refresh when the tab becomes visible.
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
      if (sessionId) sessionStorage.setItem(SESSION_KEY, sessionId);
      else sessionStorage.removeItem(SESSION_KEY);
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
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function selectSession(id: string) {
    selectedId.current = id;
    if (id !== sessionId) { setDraftReference(undefined); setSession(undefined); setSessionId(id); }
    setPanel('conversation');
  }

  async function useInput(path: string, attach: boolean) {
    if (!sessionId && !await newSession()) return;
    setDraftReference({ id: crypto.randomUUID(), text: `Input file: ${path}`, path, attach });
    setPanel('conversation');
  }

  const canCreate = !!token && !connectionError;
  // The header shows the model this session last used (or the default).
  const sessionModel = state && (state.models?.find(choice => choice.key === (session?.model ?? 'default')) ?? state.model);
  const pane = (id: Panel) => cn('min-h-0 min-w-0 flex-col', panel === id ? 'flex' : 'hidden', 'desk:flex');

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <a href="#conversation" className="fixed top-2 left-2 z-50 -translate-y-20 rounded-md border-2 border-primary bg-card px-4 py-2 text-sm focus:translate-y-0">Skip to conversation</a>

      {connectionError && (
        <div role="alert" className="connection-banner flex flex-wrap items-center gap-3 border-b border-destructive/30 bg-destructive/8 px-4 py-3 text-sm">
          <WifiOff className="size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <strong className="font-medium">Cannot reach the agent.</strong> {connectionError}
            <span className="block text-xs text-muted-foreground">Ensure the local server is running. Reconnect after restarting it to renew the access token. Accepted work may still be running on the server.</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => { void connect(); }} disabled={connecting}>{connecting ? 'Reconnecting…' : 'Reconnect'}</Button>
        </div>
      )}
      {state?.issues?.length ? (
        <div role="status" className="flex gap-3 border-b border-warning/30 bg-warning/8 px-4 py-2.5 text-xs">
          <CircleAlert className="size-4 shrink-0 text-warning" />
          <div><strong className="font-medium">Project needs attention</strong><ul className="mt-1 list-disc pl-4 text-muted-foreground">{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>
        </div>
      ) : null}

      {/* Mobile: top bar / tabs / one pane. Desktop: sessions | top bar over conversation | inspector. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] desk:grid-cols-[256px_minmax(0,1fr)_340px] desk:grid-rows-[auto_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_400px]">
        <aside aria-label="Sessions" className={cn(pane('sessions'), 'row-start-3 bg-sidebar desk:col-start-1 desk:row-span-2 desk:row-start-1 desk:border-r')}>
          <Sidebar token={token} state={state} title={title} sessionId={sessionId} creating={creating} canCreate={canCreate}
            onNewSession={() => { void newSession(); }} onSelectSession={selectSession} onUseInput={(path, attach) => { void useInput(path, attach); }} onShowCapabilities={section => setCapabilities({ section })} />
        </aside>

        <header className="row-start-1 flex h-14 min-w-0 items-center gap-2 border-b bg-background px-3 desk:col-start-2 desk:px-5">
          <BrandMark title={title} size="sm" className="desk:hidden" />
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <p className="truncate text-sm font-medium" title={session?.title}>{session ? session.title || 'New session' : title}</p>
            {sessionModel && (
              <span className="model-label hidden max-w-56 shrink-0 items-center gap-1.5 text-xs text-muted-foreground xl:inline-flex" title={`${sessionModel.provider}/${sessionModel.id}`}>
                <Cpu className="size-3 shrink-0" /><span className="truncate">{sessionModel.provider} / {sessionModel.id}</span>
              </span>
            )}
            {session?.usage?.totalTokens !== undefined && (
              <span className="session-usage tabular hidden shrink-0 text-xs text-muted-foreground lg:inline" title="Tokens used by this session, including helpers and summaries">
                {session.usage.totalTokens.toLocaleString()} tok{session.usage.costUsd !== undefined ? ` · ${formatCost(session.usage.costUsd)}` : ''}
              </span>
            )}
          </div>
          {state?.demo && <Badge tone="warning" className="shrink-0">Demo fixture · no live model</Badge>}
          <span className="flex shrink-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className={cn('size-2 rounded-full', connectionError ? 'bg-destructive' : state?.busy ? 'bg-warning' : connecting ? 'bg-muted-foreground' : 'bg-success')} />
            <span className={cn('connection-label hidden lg:inline', connectionError && 'text-destructive')}>
              {connecting ? 'Connecting…' : connectionError ? 'Connection issue' : state?.busy ? 'Working' : 'Connected locally'}
            </span>
          </span>
          {session && (
            <Button variant="ghost" size="icon-sm" onClick={() => { void loadSession(session.id); void refreshState(); }} disabled={loadingSession} aria-label="Refresh saved session" title="Refresh saved session">
              <RefreshCw className={cn(loadingSession && 'animate-spin')} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
            {theme === 'light' ? <Moon /> : <Sun />}
          </Button>
        </header>

        <nav aria-label="Workbench panels" className="row-start-2 grid grid-cols-3 gap-1 border-b bg-background p-1.5 desk:hidden">
          {PANELS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={panel === id} onClick={() => setPanel(id)}
              className={cn('flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground', panel === id && 'bg-accent text-foreground')}>
              <Icon className="size-3.5" />{label}
            </button>
          ))}
        </nav>
        <main id="conversation" tabIndex={-1} className={cn(pane('conversation'), 'row-start-3 outline-none desk:col-start-2 desk:row-start-2')}>
          {sessionError && (
            <div role="alert" className="inline-error mx-4 mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p>{sessionError}</p>
              {sessionId && <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => { void loadSession(sessionId); }}>Retry loading session</Button>}
            </div>
          )}
          {creating ? <Placeholder title="Creating session…" text="Preparing a new conversation." />
            : loadingSession && !session ? <Placeholder title="Loading session…" text="Restoring the saved conversation." />
              : session && token ? (
                <Conversation key={session.id} token={token} session={session} state={state} draftReference={draftReference} onStateRefresh={refreshState}
                  onSessionUpdate={record => { if (selectedId.current === record.id) setSession(record); }} />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                  <h1 className="text-xl font-semibold">{state?.ui?.title ?? 'Agent workspace'}</h1>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{state?.ui?.tagline ?? 'Start a session to ask a question or run a task. Every task run is tracked, checked and kept with its outputs.'}</p>
                  <Button className="mt-6" onClick={() => { void newSession(); }} disabled={!state || !canCreate || creating}><Plus />{creating ? 'Creating…' : 'New session'}</Button>
                </div>
              )}
        </main>

        <aside aria-label="Runs and artifacts" className={cn(pane('artifacts'), 'row-start-3 bg-sidebar desk:col-start-3 desk:row-span-2 desk:row-start-1 desk:border-l')}>
          <RunPanel token={token} state={state} sessionId={sessionId} onRefresh={refreshState} onSelectSession={selectSession} />
        </aside>
      </div>
      {capabilities && state && <Capabilities token={token} state={state} section={capabilities.section} onChanged={refreshState} onClose={() => setCapabilities(undefined)} />}
    </div>
  );
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
      <span aria-hidden="true" className="mb-3 size-5 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

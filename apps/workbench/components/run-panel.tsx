'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, duration, errorMessage, formatDate, responseError, type AgentState, type CheckReport, type RunRecord } from '../lib/api';
import Preview from './artifact-preview';
import RunEvidence from './run-evidence';

const deliveryLabel = { not_checked: 'Not checked', passed: 'Passed', partial: 'Partial', failed: 'Failed' };

interface Props {
  token: string;
  state?: AgentState;
  sessionId: string;
  onRefresh(): Promise<AgentState | undefined>;
  onSelectSession(id: string): void;
}

export default function RunPanel({ token, state, sessionId, onRefresh, onSelectSession }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [allRuns, setAllRuns] = useState(false);
  const [detail, setDetail] = useState<{ run: RunRecord; check: CheckReport | null }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [preview, setPreview] = useState<{ runId: string; path: string }>();
  const previousSession = useRef(sessionId);
  const requestId = useRef(0);
  const visibleRuns = state?.runs.filter(run => allRuns || !sessionId || run.session.id === sessionId) ?? [];
  const selectedSummary = state?.runs.find(run => run.id === selectedId);

  useEffect(() => {
    if (sessionId !== previousSession.current) {
      previousSession.current = sessionId;
      setSelectedId('');
      setDetail(undefined);
      setAllRuns(false);
      return;
    }
    if (!selectedId || !visibleRuns.some(run => run.id === selectedId)) {
      setSelectedId(visibleRuns[0]?.id ?? '');
      setDetail(undefined);
    }
  }, [sessionId, selectedId, visibleRuns]);

  const load = useCallback(async () => {
    if (!token || !selectedId) return;
    const request = ++requestId.current;
    setLoading(true);
    try {
      const next = await api<{ run: RunRecord; check: CheckReport | null }>(token, `/api/run?id=${encodeURIComponent(selectedId)}`);
      if (request === requestId.current) { setDetail(next); setError(''); }
    } catch (caught) { if (request === requestId.current) setError(errorMessage(caught)); }
    finally { if (request === requestId.current) setLoading(false); }
  }, [token, selectedId]);

  useEffect(() => { void load(); }, [load, selectedSummary?.execution, selectedSummary?.delivery, selectedSummary?.artifacts.length, selectedSummary?.finishedAt]);

  async function recheck() {
    if (!selectedId || checking) return;
    setChecking(true);
    setError('');
    try {
      const operation = api<RunRecord>(token, '/api/check', { method: 'POST', body: JSON.stringify({ runId: selectedId }) });
      void onRefresh();
      await operation;
      await load();
      await onRefresh();
    } catch (caught) { setError(errorMessage(caught)); await onRefresh(); }
    finally { setChecking(false); }
  }

  async function download(path: string) {
    setDownloading(path);
    setError('');
    try {
      const response = await fetch(`/api/artifact?runId=${encodeURIComponent(selectedId)}&path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = path.split('/').at(-1) || 'artifact';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setDownloading(''); }
  }

  const run = detail?.run.id === selectedId ? detail.run : selectedSummary;
  const check = detail?.run.id === selectedId ? detail.check : null;

  return <>
    <div className="pane-heading"><h2>Runs & files</h2><button className="text-button" onClick={() => setAllRuns(value => !value)} aria-pressed={allRuns}>{allRuns ? 'This session' : 'All runs'}</button></div>
    <div className="runs-scroll">
      {!visibleRuns.length && <div className="run-empty"><span aria-hidden="true">☷</span><h3>No task runs{sessionId && !allRuns ? ' in this session' : ''}</h3><p>Run a task to track its execution, inspect delivery checks, and download output files.</p></div>}
      {!!visibleRuns.length && <div className="run-list" aria-label="Task runs">{visibleRuns.map(item => <button key={item.id} className={`run-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setDetail(undefined); setError(''); }} aria-pressed={selectedId === item.id}><span className="run-task">{item.task}</span><span className="run-item-meta"><time dateTime={item.startedAt}>{formatDate(item.startedAt)}</time><span className={`status status-${item.execution}`}>{item.execution}</span></span><span className="run-delivery">Delivery: <span className={`delivery-text delivery-${item.delivery}`}>{deliveryLabel[item.delivery]}</span></span></button>)}</div>}
      {error && <div className="inline-error" role="alert"><p>{error}</p><button onClick={() => { void load(); }}>Refresh run details</button></div>}
      {loading && !run && <p className="pane-note" role="status">Loading run details…</p>}
      {run && <section className="run-detail" aria-label="Selected run details">
        <div className="section-heading"><h3>Run details</h3><button className="text-button" onClick={() => { void load(); }} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button></div>
        <dl className="run-facts"><div><dt>Execution</dt><dd><span className={`status status-${run.execution}`}>{run.execution}</span></dd></div><div><dt>Delivery</dt><dd><span className={`delivery-text delivery-${run.delivery}`}>{deliveryLabel[run.delivery]}</span></dd></div><div><dt>Duration</dt><dd>{duration(run.startedAt, run.finishedAt)}</dd></div><div><dt>Run ID</dt><dd className="mono break-anywhere">{run.id}</dd></div>{run.usage?.totalTokens !== undefined && <div><dt>Tokens</dt><dd>{run.usage.totalTokens.toLocaleString()}</dd></div>}</dl>
        {run.error && <p className="run-error">{run.error}</p>}
        {run.session.id !== sessionId && <button className="full-width" onClick={() => onSelectSession(run.session.id)}>Open run session</button>}

        <section className="delivery-section" aria-label="Delivery check"><div className="section-heading"><h3>Delivery check</h3><button onClick={() => { void recheck(); }} disabled={checking || state?.busy || run.execution === 'running'}>{checking ? 'Checking…' : 'Recheck'}</button></div><p className="section-note">Execution and delivery are tracked separately. Rechecking runs the configured validator without a model call.</p>{run.delivery === 'not_checked' && <p className="unchecked-note">No completed delivery check is recorded.</p>}{check && <><p className={`check-summary delivery-${check.status}`}>Delivery {deliveryLabel[check.status].toLowerCase()}</p>{check.checks.length ? <table className="checks-table"><caption className="sr-only">Delivery checks</caption><thead><tr><th scope="col">Check</th><th scope="col">Status</th></tr></thead><tbody>{check.checks.map((item, index) => <tr key={index}><th scope="row">{item.name}{Object.keys(item).some(key => !['name', 'status'].includes(key)) && <details><summary>Details</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}</th><td>{item.status}</td></tr>)}</tbody></table> : <p className="section-note">The checker reported no individual checks.</p>}{check.issues.length > 0 && <ul className="check-issues">{check.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</>}
        </section>

        <section className="artifact-section" aria-label="Output files"><div className="section-heading"><h3>Output files</h3><span className="count-label">{run.artifacts.length}</span></div>{run.artifacts.length ? <><p className="section-note">Select a file to preview it, or save the original.</p><ul className="artifact-list">{run.artifacts.map(path => <li key={path}><button className="artifact-name" title={`Preview ${path}`} aria-label={`Preview ${path}`} onClick={() => setPreview({ runId: run.id, path })}>{path}</button><button aria-label={`Download ${path}`} onClick={() => { void download(path); }} disabled={!!downloading}>{downloading === path ? 'Saving…' : '↓ Save'}</button></li>)}</ul></> : <p className="section-note">No output files registered{run.execution === 'running' ? ' yet' : ''}.</p>}</section>
        <RunEvidence run={run} />
        {run.text && <details className="run-response"><summary>Final response</summary><div className="message-text">{run.text}</div></details>}
        <details className="run-storage"><summary>Storage path</summary><code className="break-anywhere">{run.directory}</code></details>
      </section>}
    </div>
    {preview && <Preview token={token} runId={preview.runId} path={preview.path} onClose={() => setPreview(undefined)} />}
  </>;
}

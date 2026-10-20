'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleX, Download, FileText, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api, duration, errorMessage, fetchArtifact, formatCost, formatDate, type AgentState, type CheckReport, type RunRecord } from '../lib/api';
import { cn } from '../lib/utils';
import Preview from './artifact-preview';
import RunEvidence from './run-evidence';
import { DeliveryBadge, ExecutionBadge, deliveryLabel, executionLabel } from './status';
import { Button } from './ui/button';
import { Markdown } from './markdown';

/** Task runs for the current session: execution, independent delivery check, outputs and evidence. */

interface Props {
  token: string;
  state?: AgentState;
  sessionId: string;
  onRefresh(): Promise<AgentState | undefined>;
  onSelectSession(id: string): void;
}

const Card = ({ label, title, action, children, className }: { label: string; title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) => (
  <section aria-label={label} className={cn('rounded-lg border bg-background p-3.5', className)}>
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {action}
    </div>
    {children}
  </section>
);

const dot = (run: RunRecord) => run.execution === 'running' || run.execution === 'awaiting_approval' ? 'bg-warning' : run.execution !== 'completed' ? 'bg-destructive'
  : run.delivery === 'passed' ? 'bg-success' : run.delivery === 'not_checked' ? 'bg-muted-foreground/50' : run.delivery === 'partial' ? 'bg-warning' : 'bg-destructive';

function RunList({ runs, selectedId, onSelect }: { runs: RunRecord[]; selectedId: string; onSelect(id: string): void }) {
  return (
    <div className="space-y-1.5" aria-label="Task runs">
      {runs.map(run => (
        <button key={run.id} type="button" onClick={() => onSelect(run.id)} aria-pressed={selectedId === run.id}
          className={cn('flex w-full gap-2.5 rounded-md border px-3 py-2 text-left transition-colors',
            selectedId === run.id ? 'border-foreground/25 bg-accent' : 'bg-background hover:bg-accent/60')}>
          <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot(run))} />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-xs leading-relaxed font-medium">{run.task}</span>
            <span className="mt-2 flex flex-wrap items-center gap-1.5">
              <ExecutionBadge execution={run.execution} />
              <DeliveryBadge delivery={run.delivery} />
              <time className="ml-auto text-[11px] text-muted-foreground" dateTime={run.startedAt}>{formatDate(run.startedAt)}</time>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

type Tone = 'done' | 'active' | 'warn' | 'failed' | 'idle';
const toneIcon: Record<Tone, React.ReactNode> = {
  done: <Check />, active: <LoaderCircle className="animate-spin" />, warn: <TriangleAlert />, failed: <CircleX />, idle: <span className="size-1.5 rounded-full bg-current" />,
};
const toneClass: Record<Tone, string> = {
  done: 'text-success border-success/40', active: 'text-warning border-warning/40',
  warn: 'text-warning border-warning/40', failed: 'text-destructive border-destructive/40', idle: 'text-muted-foreground',
};

/** One row per model call: who made it, how long it took, tokens and the tools it called. */
function ModelCalls({ steps }: { steps: NonNullable<RunRecord['steps']> }) {
  return (
    <details className="model-calls group rounded-lg border bg-background text-xs">
      <summary className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="font-medium">Model calls</span>
        <span className="text-muted-foreground">{steps.length}</span>
        <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <ol className="divide-y border-t">
        {steps.map((step, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-2">
            <span className="tabular w-5 text-muted-foreground">{index + 1}</span>
            <span className="font-medium">{step.agent}</span>
            <span className="text-muted-foreground">{step.model}</span>
            <span className="tabular ml-auto text-muted-foreground">{(step.ms / 1000).toFixed(1)}s · {(step.usage.totalTokens ?? 0).toLocaleString()} tok</span>
            {step.tools.length > 0 && (
              <span className="basis-full pl-7 font-mono text-[11px] text-muted-foreground">
                {step.tools.map(tool => `${tool.name}${tool.ms !== undefined ? ` ${tool.ms}ms` : ''}${tool.error ? ' (failed)' : ''}`).join(' · ')}
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Execute → Check → Deliver: execution and delivery shown as separate, independent stages. */
function Pipeline({ run }: { run: RunRecord }) {
  const execute: Tone = run.execution === 'completed' ? 'done' : run.execution === 'running' || run.execution === 'awaiting_approval' ? 'active' : 'failed';
  const check: Tone = run.delivery === 'passed' ? 'done' : run.delivery === 'partial' ? 'warn' : run.delivery === 'failed' ? 'failed' : 'idle';
  const deliver: Tone = run.delivery === 'passed' && run.artifacts.length ? 'done' : 'idle';
  const steps: Array<[string, string, Tone]> = [
    ['Execute', executionLabel[run.execution], execute],
    ['Check', deliveryLabel[run.delivery], check],
    ['Deliver', `${run.artifacts.length} file${run.artifacts.length === 1 ? '' : 's'}`, deliver],
  ];
  return (
    <ol aria-label="Run progress" className="grid grid-cols-3 rounded-lg border bg-background p-3">
      {steps.map(([label, detail, tone], index) => (
        <li key={label} className="relative flex flex-col items-center text-center">
          {index > 0 && <span aria-hidden="true" className={cn('absolute top-3.5 right-1/2 h-px w-full', 'bg-border')} />}
          <span className={cn('relative z-10 flex size-7 items-center justify-center rounded-full border bg-background [&_svg]:size-3.5', toneClass[tone])}>{toneIcon[tone]}</span>
          <span className="mt-1.5 text-[11px] font-medium">{label}</span>
          <span className="text-[11px] text-muted-foreground">{detail}</span>
        </li>
      ))}
    </ol>
  );
}

function CheckResult({ check }: { check: CheckReport }) {
  return (
    <div className="space-y-2">
      <p className={cn('check-summary text-sm font-medium', check.status === 'passed' ? 'text-success' : check.status === 'partial' ? 'text-warning' : 'text-destructive')}>
        Delivery {deliveryLabel[check.status].toLowerCase()}
      </p>
      {check.checks.length ? (
        <table className="w-full text-xs">
          <caption className="sr-only">Delivery checks</caption>
          <thead className="sr-only"><tr><th scope="col">Check</th><th scope="col">Status</th></tr></thead>
          <tbody className="divide-y">
            {check.checks.map((item, index) => (
              <tr key={index}>
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  {item.name}
                  {Object.keys(item).some(key => key !== 'name' && key !== 'status') && (
                    <details className="mt-1"><summary className="text-muted-foreground">Details</summary><pre className="mt-1 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{JSON.stringify(item, null, 2)}</pre></details>
                  )}
                </th>
                <td className="py-1.5 text-right text-muted-foreground">{item.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="text-xs text-muted-foreground">The checker reported no individual checks.</p>}
      {check.issues.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-destructive">{check.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
    </div>
  );
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

  // Follow the session; keep a valid selection as runs appear.
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
    } catch (caught) {
      if (request === requestId.current) setError(errorMessage(caught));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
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
    } catch (caught) {
      setError(errorMessage(caught));
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  async function download(path: string) {
    setDownloading(path);
    setError('');
    try {
      const url = URL.createObjectURL(await fetchArtifact(token, selectedId, path));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = path.split('/').at(-1) || 'artifact';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDownloading('');
    }
  }

  const run = detail?.run.id === selectedId ? detail.run : selectedSummary;
  const check = detail?.run.id === selectedId ? detail.check : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold">
          Runs & files
          {visibleRuns.length > 0 && <span className="text-xs font-normal text-muted-foreground tabular">{visibleRuns.length}</span>}
        </h2>
        <Button variant="outline" size="xs" onClick={() => setAllRuns(value => !value)} aria-pressed={allRuns}>{allRuns ? 'This session' : 'All runs'}</Button>
      </div>
      <div className="scroll-area min-h-0 flex-1 space-y-4 p-4">
        {!visibleRuns.length && (
          <div className="run-empty px-1 py-6">
            <h3 className="text-sm font-medium">No task runs{sessionId && !allRuns ? ' in this session' : ''}</h3>
            <p className="mt-1 text-xs text-muted-foreground">Run a task to track its execution, inspect delivery checks, and download output files.</p>
          </div>
        )}
        {visibleRuns.length > 0 && <RunList runs={visibleRuns} selectedId={selectedId} onSelect={id => { setSelectedId(id); setDetail(undefined); setError(''); }} />}
        {error && (
          <div className="inline-error rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert">
            <p>{error}</p>
            <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => { void load(); }}>Refresh run details</Button>
          </div>
        )}
        {loading && !run && <p className="text-xs text-muted-foreground" role="status">Loading run details…</p>}
        {run && (
          <section className="run-detail space-y-3 border-t pt-4" aria-label="Selected run details">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Run details</h3>
              <Button variant="ghost" size="xs" onClick={() => { void load(); }} disabled={loading}><RefreshCw className={cn(loading && 'animate-spin')} />Refresh</Button>
            </div>
            <Pipeline run={run} />
            <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-background p-3.5 text-xs">
              <div><dt className="text-muted-foreground">Execution</dt><dd className="mt-1"><ExecutionBadge execution={run.execution} /></dd></div>
              <div><dt className="text-muted-foreground">Delivery</dt><dd className="mt-1"><DeliveryBadge delivery={run.delivery} /></dd></div>
              <div><dt className="text-muted-foreground">Duration</dt><dd className="tabular mt-1">{duration(run.startedAt, run.finishedAt)}</dd></div>
              {run.usage?.totalTokens !== undefined && <div><dt className="text-muted-foreground">Tokens</dt><dd className="tabular mt-1">{run.usage.totalTokens.toLocaleString()}</dd></div>}
              {run.costUsd !== undefined && <div><dt className="text-muted-foreground">Cost</dt><dd className="tabular mt-1">{formatCost(run.costUsd)}</dd></div>}
              {!!run.repairs && <div><dt className="text-muted-foreground">Repairs</dt><dd className="tabular mt-1">{run.repairs}</dd></div>}
              <div className="col-span-2"><dt className="text-muted-foreground">Run ID</dt><dd className="mt-1 font-mono text-[11px] break-all">{run.id}</dd></div>
              {run.error && <p className="col-span-2 rounded-md border border-destructive/30 p-2.5 text-destructive">{run.error}</p>}
            </dl>
            {!!run.steps?.length && <ModelCalls steps={run.steps} />}
            {run.session.id !== sessionId && <Button variant="outline" size="sm" className="w-full" onClick={() => onSelectSession(run.session.id)}>Open run session</Button>}

            <Card label="Delivery check" title="Delivery check" action={
              <Button variant="outline" size="xs" onClick={() => { void recheck(); }} disabled={checking || state?.busy || run.execution === 'running' || run.execution === 'awaiting_approval'}>
                <ShieldCheck />{checking ? 'Checking…' : 'Recheck'}
              </Button>
            }>
              <p className="mb-3 text-xs text-muted-foreground">Execution and delivery are tracked separately. Rechecking runs the configured validator without a model call.</p>
              {run.delivery === 'not_checked' && <p className="text-xs text-muted-foreground">No completed delivery check is recorded.</p>}
              {check && <CheckResult check={check} />}
            </Card>

            <Card label="Output files" title="Output files" action={<span className="text-xs text-muted-foreground tabular">{run.artifacts.length}</span>}>
              {run.artifacts.length ? (
                <ul className="-mx-1 space-y-0.5">
                  {run.artifacts.map(path => (
                    <li key={path} className="flex items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-accent/60">
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs" title={`Preview ${path}`} aria-label={`Preview ${path}`} onClick={() => setPreview({ runId: run.id, path })}>
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono">{path.replace(/^output\//, '')}</span>
                      </button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Download ${path}`} title="Download" onClick={() => { void download(path); }} disabled={!!downloading}>
                        {downloading === path ? <LoaderCircle className="animate-spin" /> : <Download />}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted-foreground">No output files registered{run.execution === 'running' ? ' yet' : ''}.</p>}
            </Card>

            <RunEvidence run={run} />
            {run.text && (
              <details className="group rounded-lg border bg-background px-3.5 py-2.5">
                <summary className="flex items-center text-xs font-medium">Final response<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" /></summary>
                <Markdown className="mt-3">{run.text}</Markdown>
              </details>
            )}
            <details className="group rounded-lg border bg-background px-3.5 py-2.5">
              <summary className="flex items-center text-xs font-medium">Storage path<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" /></summary>
              <code className="mt-2 block font-mono text-[11px] break-all text-muted-foreground">{run.directory}</code>
            </details>
          </section>
        )}
      </div>
      {preview && <Preview token={token} runId={preview.runId} path={preview.path} onClose={() => setPreview(undefined)} />}
    </div>
  );
}

import { ChevronRight, CircleAlert } from 'lucide-react';
import { formatBytes, formatDate, type RunRecord } from '../lib/api';
import { deliveryLabel } from './status';

/**
 * Provenance for one run: original vs latest delivery, frozen inputs, changes
 * observed by rechecks, check history and byte-level hashes.
 * Stable hook: .skill-fingerprints.
 */

type FileHashes = NonNullable<RunRecord['provenance']>['inputs'];

function Hashes({ files }: { files: FileHashes }) {
  if (!files.length) return <p className="text-xs text-muted-foreground">No files recorded in this category.</p>;
  return (
    <ul className="space-y-1.5">
      {files.map(file => (
        <li key={file.path} className="rounded-md bg-muted px-2.5 py-1.5">
          <div className="flex items-center justify-between gap-2 text-xs"><code className="truncate font-mono">{file.path}</code><span className="shrink-0 text-muted-foreground tabular">{formatBytes(file.bytes)}</span></div>
          <code className="mt-0.5 block font-mono text-[10px] break-all text-muted-foreground">{file.sha256}</code>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group border-t pt-3">
      <summary className="flex items-center text-xs font-medium">{title}<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" /></summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

const Heading = ({ children }: { children: string }) => <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h4>;

const selectionLabel = { turn: 'Explicit task inputs', config: 'Project configuration', default: 'Project defaults' } as const;

export default function RunEvidence({ run }: { run: RunRecord }) {
  const latest = run.checks?.at(-1);
  const selection = run.provenance?.inputSelection;
  const changes = latest ? [
    ['Inputs', latest.inputChanges ?? []],
    ['Configured code', latest.codeChanges ?? []],
    ['Artifacts', latest.artifactChanges ?? []],
  ] as const : [];
  const changed = changes.some(([, files]) => files.length > 0);

  return (
    <section aria-label="Run evidence" className="space-y-3 rounded-lg border bg-background p-3.5">
      <h3 className="text-sm font-semibold">Run evidence</h3>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-muted-foreground">Initial delivery</dt><dd className="mt-0.5 font-medium">{run.originalDelivery ? deliveryLabel[run.originalDelivery.delivery] : 'Not recorded'}</dd></div>
        <div><dt className="text-muted-foreground">Latest delivery</dt><dd className="mt-0.5 font-medium">{deliveryLabel[run.delivery]}</dd></div>
        {latest && <div className="col-span-2"><dt className="text-muted-foreground">Latest check</dt><dd className="mt-0.5"><time dateTime={latest.checkedAt}>{formatDate(latest.checkedAt)}</time></dd></div>}
      </dl>

      {run.provenance && (
        <div className="rounded-md bg-muted p-3 text-xs">
          <strong className="font-medium">Frozen inputs: {run.provenance.inputs.length} file(s)</strong>
          {selection ? (
            <>
              <span className="mt-1 block text-muted-foreground">Selection: {selectionLabel[selection.source]}</span>
              <code className="mt-1 block font-mono text-[11px] break-all">{selection.paths.length ? selection.paths.join(', ') : 'No input paths selected'}</code>
            </>
          ) : <p className="mt-1 text-muted-foreground">Selection paths were not recorded. The file hashes below remain the historical baseline.</p>}
        </div>
      )}

      {changed && (
        <div className="flex gap-2 rounded-md border border-warning/40 p-3 text-xs">
          <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">Changes observed since execution</p>
            {changes.filter(([, files]) => files.length).map(([label, files]) => <p key={label} className="break-all text-muted-foreground">{label}: {files.join(', ')}</p>)}
          </div>
        </div>
      )}

      {run.checks?.length ? (
        <Section title={`Check history (${run.checks.length})`}>
          <ol className="space-y-2">
            {run.checks.map(check => (
              <li key={check.id} className="rounded-md bg-muted p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <strong className="font-medium">{check.kind === 'initial' ? 'Initial check' : 'Recheck'} · {deliveryLabel[check.delivery]}</strong>
                  <time className="text-muted-foreground" dateTime={check.checkedAt}>{formatDate(check.checkedAt)}</time>
                </div>
                {check.report && <code className="mt-1 block font-mono text-[10px] text-muted-foreground">{check.report}</code>}
                {check.log && <code className="block font-mono text-[10px] text-muted-foreground">{check.log}</code>}
                <details className="mt-2"><summary className="text-muted-foreground">Observed artifact hashes</summary><div className="mt-2"><Hashes files={check.artifactHashes} /></div></details>
              </li>
            ))}
          </ol>
        </Section>
      ) : <p className="text-xs text-muted-foreground">No immutable check history is available for this run.</p>}

      <Section title="Versions & provenance">
        {run.provenance ? (
          <>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-muted-foreground">Core</dt><dd>{run.provenance.coreVersion}</dd></div>
              <div><dt className="text-muted-foreground">AI SDK</dt><dd>{run.provenance.aiSdkVersion}</dd></div>
              <div><dt className="text-muted-foreground">Schema</dt><dd>{run.schemaVersion ?? 'Not recorded'}</dd></div>
            </dl>
            <div><Heading>Configuration hash</Heading><code className="mt-1 block font-mono text-[10px] break-all text-muted-foreground">{run.provenance.configHash}</code></div>
            <div className="space-y-1.5"><Heading>Frozen input hashes</Heading><Hashes files={run.provenance.inputs} /></div>
            <div className="space-y-1.5">
              <Heading>SKILL.md fingerprints</Heading>
              {!run.provenance.skills ? <p className="text-xs text-muted-foreground">Skill fingerprints were not recorded for this historical run.</p>
                : !run.provenance.skills.length ? <p className="text-xs text-muted-foreground">No available skill files were recorded.</p>
                  : (
                    <ul className="skill-fingerprints space-y-1.5">
                      {run.provenance.skills.map(skill => (
                        <li key={skill.path} className="rounded-md bg-muted px-2.5 py-1.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <strong className="font-medium">{skill.name}</strong>
                            <span className={skill.loaded ? 'text-success' : 'text-muted-foreground'}>{skill.loaded ? 'Loaded' : 'Not loaded'}</span>
                          </div>
                          <code className="block font-mono text-[11px]">{skill.path}</code>
                          <code className="block font-mono text-[10px] break-all text-muted-foreground">{skill.sha256}</code>
                          {skill.loadedAt && <time className="text-[11px] text-muted-foreground" dateTime={skill.loadedAt}>Loaded {formatDate(skill.loadedAt)}</time>}
                        </li>
                      ))}
                    </ul>
                  )}
            </div>
            <div className="space-y-1.5"><Heading>Configuration & code hashes</Heading><Hashes files={run.provenance.code} /></div>
            <div className="space-y-1.5"><Heading>Original artifact hashes</Heading><Hashes files={run.provenance.artifacts} /></div>
          </>
        ) : <p className="text-xs text-muted-foreground">This run has no recorded provenance. Historical versions and hashes are unavailable.</p>}
      </Section>
    </section>
  );
}

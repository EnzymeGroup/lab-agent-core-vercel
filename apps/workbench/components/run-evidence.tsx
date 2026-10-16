import { formatBytes, formatDate, type RunRecord } from '../lib/api';

const verdict = { not_checked: 'Not checked', passed: 'Passed', partial: 'Partial', failed: 'Failed' };

function Hashes({ files }: { files: NonNullable<RunRecord['provenance']>['inputs'] }) {
  return files.length ? <ul className="evidence-hashes">{files.map(file => <li key={file.path}><div><code>{file.path}</code><span>{formatBytes(file.bytes)}</span></div><code className="hash-value">{file.sha256}</code></li>)}</ul> : <p className="section-note">No files recorded in this category.</p>;
}

export default function RunEvidence({ run }: { run: RunRecord }) {
  const latest = run.checks?.at(-1);
  return <section className="evidence-section" aria-label="Run evidence">
    <h3>Run evidence</h3>
    <dl className="run-facts"><div><dt>Initial delivery</dt><dd>{run.originalDelivery ? verdict[run.originalDelivery.delivery] : 'Not recorded'}</dd></div><div><dt>Latest delivery</dt><dd>{verdict[run.delivery]}</dd></div>{latest && <div><dt>Latest check</dt><dd><time dateTime={latest.checkedAt}>{formatDate(latest.checkedAt)}</time></dd></div>}</dl>
    {latest && ((latest.inputChanges?.length ?? 0) + (latest.artifactChanges?.length ?? 0) + (latest.codeChanges?.length ?? 0) > 0) && <div className="evidence-changes"><p>Changes observed since execution</p>{latest.inputChanges?.length > 0 && <p>Inputs: {latest.inputChanges.join(', ')}</p>}{latest.codeChanges?.length > 0 && <p>Configured code: {latest.codeChanges.join(', ')}</p>}{latest.artifactChanges?.length > 0 && <p>Artifacts: {latest.artifactChanges.join(', ')}</p>}</div>}
    {run.checks?.length ? <details className="evidence-details"><summary>Check history ({run.checks.length})</summary><ol className="check-history">{run.checks.map(check => <li key={check.id}><strong>{check.kind === 'initial' ? 'Initial check' : 'Recheck'} · {verdict[check.delivery]}</strong><time dateTime={check.checkedAt}>{formatDate(check.checkedAt)}</time>{check.report && <code>{check.report}</code>}{check.log && <code>{check.log}</code>}<details><summary>Observed artifact hashes</summary><Hashes files={check.artifactHashes} /></details></li>)}</ol></details> : <p className="section-note">No immutable check history is available for this run.</p>}
    <details className="evidence-details"><summary>Versions & provenance</summary>{run.provenance ? <><dl className="run-facts"><div><dt>Core</dt><dd>{run.provenance.coreVersion}</dd></div><div><dt>AI SDK</dt><dd>{run.provenance.aiSdkVersion}</dd></div><div><dt>Schema</dt><dd>{run.schemaVersion ?? 'Not recorded'}</dd></div></dl><p className="field-label">CONFIGURATION HASH</p><code className="hash-value">{run.provenance.configHash}</code><h4>Configured input hashes</h4><Hashes files={run.provenance.inputs} /><h4>Configuration & code hashes</h4><Hashes files={run.provenance.code} /><h4>Original artifact hashes</h4><Hashes files={run.provenance.artifacts} /></> : <p className="section-note">This run has no recorded provenance. Historical versions and hashes are unavailable.</p>}</details>
  </section>;
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, formatBytes, formatDate, responseError, type UploadedFile, type UploadListing } from '../lib/api';

export default function InputFiles({ token, busy, onUse }: { token: string; busy: boolean; onUse(path: string): void }) {
  const [listing, setListing] = useState<UploadListing>();
  const [file, setFile] = useState<File>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try { setListing(await api<UploadListing>(token, '/api/uploads')); setError(''); }
    catch (caught) { setError(`Could not load input files: ${errorMessage(caught)}`); }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);

  function choose(selected?: File) {
    setError('');
    setNotice('');
    setFile(undefined);
    if (!selected || !listing) return;
    if (selected.size > listing.maxBytes) { setError(`File is too large. The import limit is ${formatBytes(listing.maxBytes)}.`); return; }
    if (!listing.extensions.some(extension => selected.name.toLowerCase().endsWith(extension.toLowerCase()))) { setError(`Unsupported file type. Choose ${listing.extensions.join(', ')}.`); return; }
    setFile(selected);
  }

  async function importFile() {
    if (!file || busy || importing) return;
    setImporting(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: file,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const imported = await response.json() as UploadedFile;
      setFile(undefined);
      if (input.current) input.current.value = '';
      await refresh();
      setNotice(`Imported ${imported.name}. Use its path in a message when you are ready.`);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setImporting(false); }
  }

  async function copy(path: string) {
    try { await navigator.clipboard.writeText(path); setNotice('Project path copied.'); setError(''); }
    catch { setError('Clipboard access is unavailable. Select and copy the project path below.'); }
  }

  return <details className="input-files"><summary>Input files <span>{listing?.files.length ?? 0}</span></summary><section className="input-file-body" aria-label="Input files">
    <p>Import a file into this project. Use for task inserts its path and binds it as a task input. Nothing is sent automatically.</p>
    <label htmlFor="input-file-picker">Choose an input file</label><input id="input-file-picker" ref={input} type="file" accept={listing?.extensions.join(',')} disabled={!listing || busy || importing} onChange={event => choose(event.target.files?.[0])} aria-describedby="input-file-limits" />
    <p id="input-file-limits" className="file-limits">{listing ? `Up to ${formatBytes(listing.maxBytes)}. ${listing.extensions.join(', ')}` : 'Loading accepted file types…'}</p>
    {file && <p className="selected-input">{file.name} · {formatBytes(file.size)}</p>}
    <button className="full-width" onClick={() => { void importFile(); }} disabled={!file || busy || importing}>{importing ? 'Importing…' : 'Import file'}</button>
    {busy && <p className="section-note">An operation is active. Import files after it finishes.</p>}
    {error && <div className="input-error" role="alert"><p>{error}</p>{!listing && <button onClick={() => { void refresh(); }}>Retry loading files</button>}</div>}
    {notice && <p className="input-notice" role="status">{notice}</p>}
    {listing?.files.length ? <ul className="uploaded-files">{listing.files.map(item => <li key={item.path}><strong>{item.name}</strong><span className="input-file-meta">{formatBytes(item.bytes)} · <time dateTime={item.importedAt}>{formatDate(item.importedAt)}</time></span><code className="input-path" tabIndex={0}>{item.path}</code><div className="input-actions"><button onClick={() => { void copy(item.path); }} aria-label={`Copy path for ${item.name}`}>Copy path</button><button onClick={() => onUse(item.path)} disabled={busy || importing} aria-label={`Use ${item.name} in task`}>Use for task</button></div><details className="input-integrity"><summary>SHA-256</summary><code>{item.sha256}</code></details></li>)}</ul> : listing && <p className="section-note">No imported input files yet.</p>}
  </section></details>;
}

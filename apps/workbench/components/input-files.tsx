'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, FileUp, Upload } from 'lucide-react';
import { api, errorMessage, formatBytes, formatDate, responseError, type UploadedFile, type UploadListing } from '../lib/api';
import { Button } from './ui/button';

/**
 * Explicit human import of input files into data/uploads/. Importing never sends
 * a message; "Use for task" only inserts the path and binds it. Stable hook: .input-files.
 */

export default function InputFiles({ token, busy, onUse }: { token: string; busy: boolean; onUse(path: string): void }) {
  const [listing, setListing] = useState<UploadListing>();
  const [file, setFile] = useState<File>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setListing(await api<UploadListing>(token, '/api/uploads'));
      setError('');
    } catch (caught) {
      setError(`Could not load input files: ${errorMessage(caught)}`);
    }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);

  /** Client-side checks mirror the server limits for faster feedback; the server still enforces them. */
  function choose(selected?: File) {
    setError('');
    setNotice('');
    setFile(undefined);
    if (!selected || !listing) return;
    if (selected.size > listing.maxBytes) return setError(`File is too large. The import limit is ${formatBytes(listing.maxBytes)}.`);
    if (!listing.extensions.some(extension => selected.name.toLowerCase().endsWith(extension.toLowerCase()))) {
      return setError(`Unsupported file type. Choose ${listing.extensions.join(', ')}.`);
    }
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
      if (picker.current) picker.current.value = '';
      await refresh();
      setNotice(`Imported ${imported.name}. Use its path in a message when you are ready.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setImporting(false);
    }
  }

  async function copy(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setNotice('Project path copied.');
      setError('');
    } catch {
      setError('Clipboard access is unavailable. Select and copy the project path below.');
    }
  }

  return (
    <details className="input-files group border-t">
      <summary className="flex items-center gap-2.5 px-5 py-3 text-xs font-medium transition-colors hover:bg-accent/60">
        <FileUp className="size-3.5 text-muted-foreground" />
        Input files
        <span className="text-[11px] font-normal text-muted-foreground tabular">{listing?.files.length ?? 0}</span>
        <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <section aria-label="Input files" className="space-y-3 px-4 pb-4 text-xs">
        <p className="text-muted-foreground">Import a file into this project. Use for task inserts its path and binds it as a task input. Attach (images and PDFs) shows the file to the model with the next message. Nothing is sent automatically.</p>
        <div className="rounded-md border border-dashed p-3">
          <label htmlFor="input-file-picker" className="mb-1.5 block font-medium">Choose an input file</label>
          <input id="input-file-picker" ref={picker} type="file" accept={listing?.extensions.join(',')} disabled={!listing || busy || importing}
            onChange={event => choose(event.target.files?.[0])} aria-describedby="input-file-limits"
            className="block w-full text-xs text-muted-foreground file:mr-2 file:h-7 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-accent disabled:opacity-50" />
          <p id="input-file-limits" className="mt-1.5 text-[11px] text-muted-foreground">
            {listing ? `Up to ${formatBytes(listing.maxBytes)}. ${listing.extensions.join(', ')}` : 'Loading accepted file types…'}
          </p>
        </div>
        {file && <p className="truncate rounded-md bg-muted px-2 py-1 font-mono text-[11px]">{file.name} · {formatBytes(file.size)}</p>}
        <Button size="sm" className="w-full" onClick={() => { void importFile(); }} disabled={!file || busy || importing}>
          <Upload />{importing ? 'Importing…' : 'Import file'}
        </Button>
        {busy && <p className="text-muted-foreground">An operation is active. Import files after it finishes.</p>}
        {error && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-destructive">
            <p>{error}</p>
            {!listing && <Button variant="link" size="sm" className="h-auto px-0" onClick={() => { void refresh(); }}>Retry loading files</Button>}
          </div>
        )}
        {notice && <p role="status" className="rounded-md border border-success/30 p-2.5 text-success">{notice}</p>}
        {listing?.files.length ? (
          <ul className="space-y-2">
            {listing.files.map(item => (
              <li key={item.path} className="rounded-md border bg-background p-3">
                <strong className="block truncate font-medium">{item.name}</strong>
                <span className="text-[11px] text-muted-foreground">{formatBytes(item.bytes)} · <time dateTime={item.importedAt}>{formatDate(item.importedAt)}</time></span>
                <code className="mt-1 block font-mono text-[11px] break-all text-muted-foreground" tabIndex={0}>{item.path}</code>
                <div className="mt-2 flex gap-1.5">
                  <Button variant="outline" size="sm" className="h-7 flex-1" onClick={() => { void copy(item.path); }} aria-label={`Copy path for ${item.name}`}><Copy />Copy path</Button>
                  {/\.(?:png|jpe?g|gif|webp|pdf)$/iu.test(item.path)
                    ? <Button variant="secondary" size="sm" className="h-7 flex-1" onClick={() => onUse(item.path)} disabled={busy || importing} aria-label={`Attach ${item.name} to the next message`}>Attach</Button>
                    : <Button variant="secondary" size="sm" className="h-7 flex-1" onClick={() => onUse(item.path)} disabled={busy || importing} aria-label={`Use ${item.name} in task`}>Use for task</Button>}
                </div>
                <details className="mt-2"><summary className="text-[11px] text-muted-foreground">SHA-256</summary><code className="mt-1 block font-mono text-[10px] break-all">{item.sha256}</code></details>
              </li>
            ))}
          </ul>
        ) : listing && <p className="text-muted-foreground">No imported input files yet.</p>}
      </section>
    </details>
  );
}

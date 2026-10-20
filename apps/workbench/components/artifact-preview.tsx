'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage, fetchArtifact, formatBytes, type ArtifactPreview } from '../lib/api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Markdown } from './markdown';

/**
 * Bounded preview of one registered artifact. The server decides what is
 * previewable; Markdown never renders raw HTML; images load as authenticated blobs.
 */

const Pre = ({ children }: { children: string }) => (
  <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted/70 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{children}</pre>
);

function CsvTable({ rows }: { rows: string[][] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">The CSV file contains no rows.</p>;
  const columns = rows.reduce((count, row) => Math.max(count, row.length), 0);
  return (
    <div className="max-h-[60vh] overflow-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">CSV rows · up to 50 rows and 30 columns</caption>
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">Row</th>
            {Array.from({ length: columns }, (_, index) => <th key={index} scope="col" className="px-3 py-2 font-medium text-muted-foreground">Column {index + 1}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, index) => (
            <tr key={index} className="hover:bg-accent/50">
              <th scope="row" className="px-3 py-1.5 font-normal text-muted-foreground tabular">{index + 1}</th>
              {row.map((value, column) => <td key={column} className="px-3 py-1.5 font-mono whitespace-pre-wrap">{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Preview({ token, runId, path, onClose }: { token: string; runId: string; path: string; onClose(): void }) {
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let canceled = false;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    setPreview(undefined);
    setImageUrl('');
    setError('');
    void (async () => {
      try {
        const query = `runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`;
        const next = await api<ArtifactPreview>(token, `/api/preview?${query}`, { signal: controller.signal });
        if (canceled) return;
        if (next.kind === 'image') {
          if (!['image/png', 'image/jpeg'].includes(next.mediaType ?? '')) throw new Error('Only PNG and JPEG images can be previewed. Download this artifact to inspect it locally.');
          const blob = await fetchArtifact(token, runId, path, controller.signal);
          objectUrl = URL.createObjectURL(new Blob([blob], { type: next.mediaType }));
          if (canceled) { URL.revokeObjectURL(objectUrl); return; }
          setImageUrl(objectUrl);
        }
        setPreview(next);
      } catch (caught) {
        if (!canceled) setError(errorMessage(caught));
      }
    })();
    return () => { canceled = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [token, runId, path, attempt]);

  return (
    <Dialog title="Artifact preview" description={<span className="font-mono">{path}</span>} closeLabel="Close artifact preview" onClose={onClose} className="max-w-4xl">
      {!preview && !error && <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>}
      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setAttempt(value => value + 1)}>Retry preview</Button>
        </div>
      )}
      {preview && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge>{preview.kind.toUpperCase()}</Badge>
            <span className="text-xs text-muted-foreground tabular">{formatBytes(preview.bytes)}</span>
          </div>
          {preview.truncated && <p role="status" className="rounded-md border border-warning/40 px-3 py-2 text-xs text-warning">This preview is truncated. Download the original file to inspect all content.</p>}
          {preview.kind === 'csv' && <CsvTable rows={preview.rows ?? []} />}
          {(preview.kind === 'json' || preview.kind === 'text') && <Pre>{preview.content ?? ''}</Pre>}
          {preview.kind === 'markdown' && <div className="rounded-md border p-5"><Markdown>{preview.content ?? ''}</Markdown></div>}
          {preview.kind === 'image' && imageUrl && (
            <div className="flex justify-center rounded-md bg-muted p-4">
              {/* A plain img: the source is an authenticated blob URL, not a static asset next/image could optimize. */}
              <img src={imageUrl} alt={`Artifact ${path}`} className="max-h-[60vh] object-contain" onError={() => setError('The image could not be decoded. Download the original file to inspect it locally.')} />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

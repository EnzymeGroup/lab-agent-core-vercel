'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, formatBytes, responseError, type ArtifactPreview } from '../lib/api';

function readableJson(content: string): string {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

/** Small text-only Markdown renderer. React escapes all content; raw HTML,
 * embedded images and executable links are never interpreted. */
function Markdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let code: string[] | undefined;
  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (code) { blocks.push(<pre key={index}>{code.join('\n')}</pre>); code = undefined; }
      else code = [];
      return;
    }
    if (code) { code.push(line); return; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push(heading[1].length === 1 ? <h3 key={index}>{heading[2]}</h3> : <h4 key={index}>{heading[2]}</h4>); return; }
    if (/^\s*[-*]\s+/.test(line)) { blocks.push(<p className="markdown-item" key={index}>• {line.replace(/^\s*[-*]\s+/, '')}</p>); return; }
    if (line.trim()) blocks.push(<p key={index}>{line}</p>);
    else blocks.push(<div className="markdown-space" key={index} />);
  });
  if (code) blocks.push(<pre key="unfinished-code">{code.join('\n')}</pre>);
  return <div className="markdown-preview">{blocks}</div>;
}

export default function Preview({ token, runId, path, onClose }: { token: string; runId: string; path: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let canceled = false;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    setPreview(undefined);
    setImageUrl('');
    setError('');
    void (async () => {
      try {
        const next = await api<ArtifactPreview>(token, `/api/preview?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`, { signal: controller.signal });
        if (canceled) return;
        if (next.kind === 'image') {
          if (!['image/png', 'image/jpeg'].includes(next.mediaType ?? '')) throw new Error('Only PNG and JPEG images can be previewed. Download this artifact to inspect it locally.');
          const response = await fetch(`/api/artifact?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error(await responseError(response));
          objectUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: next.mediaType }));
          if (canceled) { URL.revokeObjectURL(objectUrl); return; }
          setImageUrl(objectUrl);
        }
        setPreview(next);
      } catch (caught) { if (!canceled) setError(errorMessage(caught)); }
    })();
    return () => { canceled = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [token, runId, path, attempt]);

  const columnCount = preview?.rows?.reduce((count, row) => Math.max(count, row.length), 0) ?? 0;
  return <dialog ref={dialog} className="workbench-dialog preview-dialog" aria-labelledby="preview-title" onClose={onClose}>
    <div className="dialog-heading"><div><h2 id="preview-title">Artifact preview</h2><p className="preview-path">{path}</p></div><button autoFocus onClick={() => dialog.current?.close()} aria-label="Close artifact preview">Close</button></div>
    <div className="dialog-body">
      {!preview && !error && <p role="status">Loading preview…</p>}
      {error && <div className="input-error" role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>}
      {preview && <><div className="preview-meta"><span>{preview.kind.toUpperCase()}</span><span>{formatBytes(preview.bytes)}</span></div>{preview.truncated && <p className="preview-truncated" role="status">This preview is truncated. Download the original file to inspect all content.</p>}
        {preview.kind === 'csv' && (preview.rows?.length ? <div className="preview-table-scroll"><table className="preview-table"><caption>CSV rows · up to 50 rows and 30 columns</caption><thead><tr><th scope="col">Row</th>{Array.from({ length: columnCount }, (_, index) => <th key={index} scope="col">Column {index + 1}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table></div> : <p>The CSV file contains no rows.</p>)}
        {preview.kind === 'json' && <pre className="artifact-text-preview">{readableJson(preview.content ?? '')}</pre>}
        {preview.kind === 'markdown' && <Markdown content={preview.content ?? ''} />}
        {preview.kind === 'text' && <pre className="artifact-text-preview">{preview.content ?? ''}</pre>}
        {preview.kind === 'image' && imageUrl && <div className="image-preview"><img src={imageUrl} alt={`Artifact ${path}`} onError={() => setError('The image could not be decoded. Download the original file to inspect it locally.')} /></div>}
      </>}
    </div>
  </dialog>;
}

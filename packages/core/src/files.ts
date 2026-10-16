import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { LabAgent } from './agent.js';
import { acquireOperation, atomicJSON, InputError, NotFoundError, readJSON, storagePath, within } from './storage.js';
import { sha256 } from './provenance.js';

export const uploadLimit = 10 * 1024 * 1024;
export const uploadExtensions = ['.csv', '.tsv', '.json', '.txt', '.md', '.fasta', '.fa', '.fna', '.faa', '.pdb', '.cif'];
export interface ImportedFile { path: string; name: string; bytes: number; sha256: string; importedAt: string }

export async function listUploads(root: string): Promise<ImportedFile[]> {
  const directory = await storagePath(root, '.lab-agent/uploads');
  const entries = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const files: ImportedFile[] = [];
  for (const entry of entries.sort().slice(-1000)) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(entry)) continue;
    const file = await readJSON(root, `.lab-agent/uploads/${entry}`) as ImportedFile;
    if (typeof file.path !== 'string' || !/^data\/uploads\/[a-f0-9-]{36}-[^/\\]+$/u.test(file.path) ||
      typeof file.name !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > uploadLimit ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) || Number.isNaN(Date.parse(file.importedAt))) throw new Error(`Invalid upload record: ${entry}`);
    files.push(file);
  }
  return files.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

/** Explicit human input import, separate from model file write permissions. */
export async function importUpload(root: string, name: string, request: Request): Promise<ImportedFile> {
  if (Buffer.byteLength(name, 'utf8') > 180) throw new InputError('Input filename exceeds 180 UTF-8 bytes.');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u.test(name) || name.includes('..') || !uploadExtensions.includes(extname(name).toLowerCase())) {
    throw new InputError(`Choose a plain filename with an allowed extension: ${uploadExtensions.join(', ')}.`);
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > uploadLimit)) throw new InputError('Input upload exceeds 10 MiB.');
  const release = await acquireOperation(root);
  let file: string | undefined;
  try {
    if ((await listUploads(root)).length >= 1000) throw new InputError('This project has reached the 1000 imported input limit. Archive inputs from the host before importing more.');
    const reader = request.body?.getReader();
    if (!reader) throw new InputError('Upload body is required.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > uploadLimit) { await reader.cancel(); throw new InputError('Input upload exceeds 10 MiB.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new InputError('Input file is empty.');
    const data = Buffer.concat(chunks);
    if (data.includes(0)) throw new InputError('Only text scientific inputs can be imported.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new InputError('Imported scientific inputs must be UTF-8 text.'); }
    const id = randomUUID();
    const record: ImportedFile = { path: `data/uploads/${id}-${name}`, name, bytes: size, sha256: sha256(data), importedAt: new Date().toISOString() };
    file = await storagePath(root, record.path, true);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await atomicJSON(root, `.lab-agent/uploads/${id}.json`, record);
    file = undefined;
    return record;
  } finally {
    if (file) await rm(file, { force: true });
    await release();
  }
}

export async function openArtifact(agent: LabAgent, id: string, path: string) {
  const run = await agent.runs.load(id);
  if (!run.artifacts.includes(path)) throw new NotFoundError('Unknown artifact.');
  if (!path.startsWith('output/')) throw new InputError('Artifact path must be inside output/.');
  const file = await storagePath(agent.config.root, `runs/${run.id}/${path}`);
  if (!within(resolve(run.directory, 'output'), file)) throw new InputError('Artifact escapes this run output directory.');
  const info = await lstat(file);
  if (!info.isFile() || info.nlink > 1) throw new InputError('Artifact must be an unaliased regular file.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) throw new InputError('Artifact must be an unaliased regular file.');
    return { file, name: basename(file), handle, bytes: info.size };
  } catch (error) { await handle.close(); throw error; }
}

export interface ArtifactPreview {
  kind: 'csv' | 'json' | 'markdown' | 'text' | 'image';
  path: string; bytes: number; truncated: boolean; content?: string; rows?: string[][]; mediaType?: string;
}

/** RFC4180-style quoted fields, bounded rows/columns/cell text for UI rendering. */
export function csvPreview(text: string, separator = ','): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let truncated = false;
  const pushCell = () => {
    if (row.length < 30) row.push(cell); else truncated = true;
    cell = '';
  };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { if (cell.length < 2000) cell += '"'; else truncated = true; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else if (cell.length < 2000) cell += char;
    } else if (!quoted && char === separator) pushCell();
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      if (rows.length === 50) return { rows, truncated: truncated || i < text.length - 1 };
    } else if (cell.length < 2000) cell += char;
    else truncated = true;
  }
  if (cell || row.length) pushRow();
  return { rows, truncated: truncated || quoted };
}

export async function previewArtifact(agent: LabAgent, id: string, path: string): Promise<ArtifactPreview> {
  const artifact = await openArtifact(agent, id, path);
  try {
    const extension = extname(path).toLowerCase();
    const result = { path, bytes: artifact.bytes, truncated: false };
    if (['.png', '.jpg', '.jpeg'].includes(extension)) {
      if (artifact.bytes > uploadLimit) throw new InputError('Image preview exceeds 10 MiB. Download the artifact instead.');
      const signature = Buffer.alloc(8); await artifact.handle.read(signature, 0, 8, 0);
      const png = signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
      if (!(extension === '.png' ? png : jpeg)) throw new InputError('Image signature does not match its filename.');
      return { ...result, kind: 'image', mediaType: png ? 'image/png' : 'image/jpeg' };
    }
    if (!['.csv', '.tsv', '.json', '.md', '.txt', '.log', '.fasta', '.fa', '.fna', '.faa', '.pdb', '.cif'].includes(extension)) {
      throw new InputError('Preview supports CSV, TSV, JSON, Markdown, text, PNG and JPEG. Download other artifact formats.');
    }
    const limit = 256 * 1024;
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    for (;;) {
      const read = await artifact.handle.read(buffer, length, buffer.length - length);
      length += read.bytesRead;
      if (!read.bytesRead || length === buffer.length) break;
    }
    let content = buffer.subarray(0, Math.min(length, limit)).toString('utf8');
    result.truncated = length > limit || artifact.bytes > limit;
    if (extension === '.csv' || extension === '.tsv') {
      const parsed = csvPreview(content, extension === '.tsv' ? '\t' : ',');
      return { ...result, kind: 'csv', rows: parsed.rows, truncated: result.truncated || parsed.truncated };
    }
    if (extension === '.json' && !result.truncated) {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Show invalid JSON as text, without execution. */ }
    }
    if (Buffer.byteLength(content, 'utf8') > limit) {
      // Decode a bounded UTF-8 prefix without materializing a replacement for
      // an incomplete final character; byte limits also hold for non-ASCII.
      content = new TextDecoder().decode(Buffer.from(content).subarray(0, limit), { stream: true });
      result.truncated = true;
    }
    return { ...result, kind: extension === '.json' ? 'json' : extension === '.md' ? 'markdown' : 'text', content };
  } finally { await artifact.handle.close(); }
}

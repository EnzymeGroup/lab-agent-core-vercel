import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { InputError, NotFoundError } from '../errors.js';
import { acquireOperation } from '../store/lock.js';
import { atomicJSON, readDirectory, readJSON, storagePath, within } from '../store/files.js';
import { sha256 } from '../store/hash.js';
import type { LabAgent } from '../agent/create.js';

/**
 * Human input import (uploads) and safe artifact access for the workbench.
 * Uploads are separate from model write permissions: unique, read-only, never overwritten.
 */

export const uploadLimit = 10 * 1024 * 1024;
const MAX_UPLOADS = 1000;
const MAX_FILENAME_BYTES = 180;
const PREVIEW_TEXT_BYTES = 256 * 1024;

const SCIENCE_TEXT = ['.fasta', '.fa', '.fna', '.faa', '.pdb', '.cif'];
/** Binary uploads, used as message attachments; checked by their leading bytes instead of UTF-8. */
const BINARY_SIGNATURES: Record<string, (data: Buffer) => boolean> = {
  '.png': data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  '.jpeg': data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  '.gif': data => data.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': data => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP',
  '.pdf': data => data.subarray(0, 5).toString('latin1') === '%PDF-',
};
export const uploadExtensions = ['.csv', '.tsv', '.json', '.txt', '.md', '.yaml', '.yml', '.log', ...SCIENCE_TEXT, ...Object.keys(BINARY_SIGNATURES)];
const PREVIEW_TEXT = new Set(['.csv', '.tsv', '.json', '.md', '.txt', '.log', '.yaml', '.yml', ...SCIENCE_TEXT]);

export interface ImportedFile { path: string; name: string; bytes: number; sha256: string; importedAt: string }

function validRecord(file: ImportedFile): boolean {
  return typeof file.path === 'string' && /^data\/uploads\/[a-f0-9-]{36}-[^/\\]+$/u.test(file.path)
    && typeof file.name === 'string' && Number.isSafeInteger(file.bytes) && file.bytes >= 1 && file.bytes <= uploadLimit
    && /^[a-f0-9]{64}$/u.test(file.sha256) && !Number.isNaN(Date.parse(file.importedAt));
}

export async function listUploads(root: string): Promise<ImportedFile[]> {
  const names = (await readDirectory(root, '.lab-agent/uploads')).map(entry => entry.name).sort().slice(-MAX_UPLOADS);
  const files: ImportedFile[] = [];
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
    const file = await readJSON(root, `.lab-agent/uploads/${name}`) as ImportedFile;
    if (!validRecord(file)) throw new Error(`Invalid upload record: ${name}`);
    files.push(file);
  }
  return files.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

/** Read a request body, stopping as soon as it exceeds `maxBytes`. */
export async function readBody(request: Request, maxBytes: number, tooLarge: string): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new InputError(tooLarge);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function importUpload(root: string, name: string, request: Request): Promise<ImportedFile> {
  if (Buffer.byteLength(name, 'utf8') > MAX_FILENAME_BYTES) throw new InputError('Input filename exceeds 180 UTF-8 bytes.');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u.test(name) || name.includes('..') || !uploadExtensions.includes(extname(name).toLowerCase())) {
    throw new InputError(`Choose a plain filename with an allowed extension: ${uploadExtensions.join(', ')}.`);
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > uploadLimit)) throw new InputError('Input upload exceeds 10 MiB.');
  const release = await acquireOperation(root);
  let file: string | undefined;
  try {
    if ((await listUploads(root)).length >= MAX_UPLOADS) {
      throw new InputError('This project has reached the 1000 imported input limit. Archive inputs from the host before importing more.');
    }
    const data = await readBody(request, uploadLimit, 'Input upload exceeds 10 MiB.');
    if (!data.length) throw new InputError('Input file is empty.');
    const signature = BINARY_SIGNATURES[extname(name).toLowerCase()];
    if (signature) {
      if (!signature(data)) throw new InputError(`${name} does not look like a ${extname(name).slice(1).toUpperCase()} file.`);
    } else {
      if (data.includes(0)) throw new InputError('Only UTF-8 text files can be imported.');
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new InputError('Only UTF-8 text files can be imported.'); }
    }
    const id = randomUUID();
    const record: ImportedFile = { path: `data/uploads/${id}-${name}`, name, bytes: data.length, sha256: sha256(data), importedAt: new Date().toISOString() };
    file = await storagePath(root, record.path, true);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicJSON(root, `.lab-agent/uploads/${id}.json`, record);
    file = undefined;
    return record;
  } finally {
    if (file) await rm(file, { force: true });
    await release();
  }
}

/** Open a registered artifact of a run. Rejects symlinks, hard links and paths outside output/. */
export async function openArtifact(agent: LabAgent, id: string, path: string) {
  const run = await agent.runs.load(id);
  if (!run.artifacts.includes(path)) throw new NotFoundError('Unknown artifact.');
  if (!path.startsWith('output/')) throw new InputError('Artifact path must be inside output/.');
  const file = await storagePath(agent.config.root, `runs/${run.id}/${path}`);
  if (!within(resolve(run.directory, 'output'), file)) throw new InputError('Artifact escapes this run output directory.');
  const linkInfo = await lstat(file);
  if (!linkInfo.isFile() || linkInfo.nlink > 1) throw new InputError('Artifact must be an unaliased regular file.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) throw new InputError('Artifact must be an unaliased regular file.');
    return { file, name: basename(file), handle, bytes: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// ─── Previews ───────────────────────────────────────────────────────────────

export interface ArtifactPreview {
  kind: 'csv' | 'json' | 'markdown' | 'text' | 'image';
  path: string;
  bytes: number;
  truncated: boolean;
  content?: string;
  rows?: string[][];
  mediaType?: string;
}

const MAX_ROWS = 50;
const MAX_COLUMNS = 30;
const MAX_CELL_CHARS = 2000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** RFC 4180-style quoted fields, bounded to 50 rows × 30 columns × 2000 chars. */
export function csvPreview(text: string, separator = ','): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  const addChar = (char: string) => { if (cell.length < MAX_CELL_CHARS) cell += char; else truncated = true; };
  const pushCell = () => {
    if (row.length < MAX_COLUMNS) row.push(cell); else truncated = true;
    cell = '';
  };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { addChar('"'); i++; }
      else if (quoted || !cell) quoted = !quoted;
      else addChar(char);
    } else if (!quoted && char === separator) {
      pushCell();
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      if (rows.length === MAX_ROWS) return { rows, truncated: truncated || i < text.length - 1 };
    } else {
      addChar(char);
    }
  }
  if (cell || row.length) pushRow();
  return { rows, truncated: truncated || quoted };
}

async function previewImage(handle: Awaited<ReturnType<typeof open>>, extension: string, bytes: number) {
  if (bytes > uploadLimit) throw new InputError('Image preview exceeds 10 MiB. Download the artifact instead.');
  const signature = Buffer.alloc(8);
  await handle.read(signature, 0, 8, 0);
  const png = signature.equals(PNG_SIGNATURE);
  const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
  if (!(extension === '.png' ? png : jpeg)) throw new InputError('Image signature does not match its filename.');
  return png ? 'image/png' : 'image/jpeg';
}

/** Bounded, escaped-on-render preview. Raw HTML and SVG are never previewed. */
export async function previewArtifact(agent: LabAgent, id: string, path: string): Promise<ArtifactPreview> {
  const artifact = await openArtifact(agent, id, path);
  try {
    const extension = extname(path).toLowerCase();
    const base = { path, bytes: artifact.bytes, truncated: false };
    if (['.png', '.jpg', '.jpeg'].includes(extension)) {
      return { ...base, kind: 'image', mediaType: await previewImage(artifact.handle, extension, artifact.bytes) };
    }
    if (!PREVIEW_TEXT.has(extension)) {
      throw new InputError('Preview supports CSV, TSV, JSON, Markdown, YAML, text, PNG and JPEG. Download other artifact formats.');
    }
    const buffer = Buffer.alloc(PREVIEW_TEXT_BYTES + 1);
    let length = 0;
    for (;;) {
      const chunk = await artifact.handle.read(buffer, length, buffer.length - length);
      length += chunk.bytesRead;
      if (!chunk.bytesRead || length === buffer.length) break;
    }
    let content = buffer.subarray(0, Math.min(length, PREVIEW_TEXT_BYTES)).toString('utf8');
    let truncated = length > PREVIEW_TEXT_BYTES || artifact.bytes > PREVIEW_TEXT_BYTES;
    if (extension === '.csv' || extension === '.tsv') {
      const parsed = csvPreview(content, extension === '.tsv' ? '\t' : ',');
      return { ...base, kind: 'csv', rows: parsed.rows, truncated: truncated || parsed.truncated };
    }
    if (extension === '.json' && !truncated) {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Show invalid JSON as text. */ }
    }
    if (Buffer.byteLength(content, 'utf8') > PREVIEW_TEXT_BYTES) {
      // Decode a bounded UTF-8 prefix without a replacement for a split final character.
      content = new TextDecoder().decode(Buffer.from(content).subarray(0, PREVIEW_TEXT_BYTES), { stream: true });
      truncated = true;
    }
    const kind = extension === '.json' ? 'json' : extension === '.md' ? 'markdown' : 'text';
    return { ...base, kind, content, truncated };
  } finally {
    await artifact.handle.close();
  }
}

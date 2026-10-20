import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { constants as zlibConstants, createGunzip } from 'node:zlib';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { createWorkspace, type FileAccessPolicy, type Workspace } from 'lab-agent-core-vercel';

/**
 * inspectFile: a first look at large or binary project files (FASTQ, BAM, VCF, gzip …)
 * without loading them. Reads at most the first MiB through Core's file policy, so
 * secrets, .lab-agent/ and paths outside readRoots stay unavailable. Statistics describe
 * that sample only; full processing belongs in a registered script.
 */

export interface InspectToolOptions {
  /** Project root (config.root). */
  root: string;
  /** The same policy as config.fileAccess. */
  fileAccess?: FileAccessPolicy;
}

const RAW_BYTES = 1024 * 1024;
const DECODED_BYTES = 1024 * 1024;
const MAX_LINE = 500;

type Compression = 'none' | 'gzip' | 'bgzf' | 'bzip2' | 'xz' | 'zstd' | 'zip';

function compressionOf(head: Buffer): Compression {
  if (head[0] === 0x1f && head[1] === 0x8b) {
    // BGZF: gzip with an extra field whose subfield id is "BC".
    return (head[3] & 4) && head.subarray(12, 14).toString('latin1') === 'BC' ? 'bgzf' : 'gzip';
  }
  if (head.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
  if (head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
  if (head.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  return 'none';
}

const BINARY_MAGIC: Array<[string, Buffer]> = [
  ['cram', Buffer.from('CRAM')], ['hdf5', Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])], ['parquet', Buffer.from('PAR1')],
  ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47])], ['pdf', Buffer.from('%PDF-')], ['sqlite', Buffer.from('SQLite format 3\0')],
];

/** Decompress the start of a gzip/BGZF stream; a truncated tail is fine. Stops at `limit` decoded bytes. */
function inflatePrefix(raw: Buffer, limit: number): Promise<{ data: Buffer; complete: boolean }> {
  return new Promise(accept => {
    const gunzip = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      accept({ data: Buffer.concat(chunks).subarray(0, limit), complete });
    };
    gunzip.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) finish(false);
    });
    gunzip.on('end', () => finish(true));
    gunzip.on('error', () => finish(false));
    gunzip.end(raw);
  });
}

function bamHeader(data: Buffer, lines: number) {
  if (data.length < 12 || data.subarray(0, 4).toString('latin1') !== 'BAM\u0001') return undefined;
  const textLength = data.readInt32LE(4);
  const text = data.subarray(8, Math.min(data.length, 8 + textLength)).toString('utf8');
  const references: Array<{ name: string; length: number }> = [];
  let offset = 8 + textLength;
  let count: number | undefined;
  if (offset + 4 <= data.length) {
    count = data.readInt32LE(offset);
    offset += 4;
    while (references.length < 50 && references.length < count && offset + 4 <= data.length) {
      const nameLength = data.readInt32LE(offset);
      if (offset + 4 + nameLength + 4 > data.length) break;
      const name = data.subarray(offset + 4, offset + 4 + nameLength - 1).toString('latin1');
      references.push({ name, length: data.readInt32LE(offset + 4 + nameLength) });
      offset += 4 + nameLength + 4;
    }
  }
  return {
    format: 'bam',
    preview: text.split('\n').filter(Boolean).slice(0, lines).map(line => line.slice(0, MAX_LINE)),
    header: { headerLines: text.split('\n').filter(Boolean).length, ...(count === undefined ? {} : { references: count }), firstReferences: references },
  };
}

function lengths(values: number[]) {
  if (!values.length) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { min: Math.min(...values), max: Math.max(...values), mean: Math.round((total / values.length) * 10) / 10 };
}

const gc = (sequences: string[]) => {
  let gcCount = 0;
  let acgt = 0;
  for (const sequence of sequences) for (const base of sequence.toUpperCase()) {
    if (base === 'G' || base === 'C') { gcCount++; acgt++; } else if (base === 'A' || base === 'T') acgt++;
  }
  return acgt ? Math.round((gcCount / acgt) * 1000) / 10 : undefined;
};

/** Format and sample statistics from complete lines of text. */
function describeText(all: string[], complete: boolean) {
  const first = all.find(line => line.trim()) ?? '';
  if (first.startsWith('##fileformat=VCF')) {
    const header = all.findIndex(line => line.startsWith('#CHROM'));
    const samples = header >= 0 ? all[header].split('\t').slice(9) : [];
    const records = all.filter(line => line && !line.startsWith('#'));
    return { format: 'vcf', stats: { headerLines: all.filter(line => line.startsWith('##')).length, samples: samples.length, firstSamples: samples.slice(0, 20), recordsSampled: records.length, chromosomes: [...new Set(records.map(line => line.split('\t')[0]))].slice(0, 30) } };
  }
  if (/^@(HD|SQ|RG|PG)\t/u.test(first)) return { format: 'sam', stats: { headerLines: all.filter(line => line.startsWith('@')).length, alignmentsSampled: all.filter(line => line && !line.startsWith('@')).length } };
  if (first.startsWith('##gff-version')) return { format: 'gff', stats: { featuresSampled: all.filter(line => line && !line.startsWith('#')).length } };
  if (first.startsWith('>')) {
    const records: Array<{ id: string; sequence: string }> = [];
    for (const line of all) {
      if (line.startsWith('>')) records.push({ id: line.slice(1).split(/\s/u)[0], sequence: '' });
      else if (records.length) records.at(-1)!.sequence += line.trim();
    }
    // The last record may continue past the sample.
    const whole = complete ? records : records.slice(0, -1);
    return { format: 'fasta', stats: { recordsSampled: whole.length, firstIds: records.slice(0, 10).map(record => record.id), length: lengths(whole.map(record => record.sequence.length)), gcPercent: gc(whole.map(record => record.sequence)) } };
  }
  if (first.startsWith('@') && all[2]?.startsWith('+')) {
    const reads: string[] = [];
    const qualities: string[] = [];
    for (let index = 0; index + 3 < all.length; index += 4) {
      if (!all[index].startsWith('@') || !all[index + 2].startsWith('+')) break;
      reads.push(all[index + 1]);
      qualities.push(all[index + 3]);
    }
    const scores = qualities.join('');
    const minScore = scores.length ? Math.min(...[...scores].map(char => char.charCodeAt(0))) : undefined;
    return { format: 'fastq', stats: { readsSampled: reads.length, length: lengths(reads.map(read => read.length)), gcPercent: gc(reads), qualityEncoding: minScore === undefined ? undefined : minScore < 59 ? 'phred+33' : 'phred+64 (or high-quality phred+33)' } };
  }
  const trimmed = all.join('\n').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return { format: 'json' };
  const rows = all.filter(line => line && !line.startsWith('#')).slice(0, 50);
  for (const [separator, name] of [['\t', 'tsv'], [',', 'csv']] as const) {
    const widths = rows.map(line => line.split(separator).length);
    if (rows.length >= 2 && widths[0] > 1 && widths.every(width => width === widths[0])) {
      const isBed = separator === '\t' && rows.every(line => /^\S+\t\d+\t\d+(?:\t|$)/u.test(line));
      return { format: isBed ? 'bed' : name, stats: { columns: widths[0], rowsSampled: rows.length } };
    }
  }
  return { format: 'text' };
}

export async function inspect(workspace: Workspace, path: string, lines: number) {
  const file = await workspace.resolve(path);
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let head: Buffer;
  let bytes: number;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    if (info.nlink > 1) throw new Error('Hard-linked files are unavailable to file tools.');
    bytes = info.size;
    head = Buffer.alloc(Math.min(bytes, RAW_BYTES));
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  const compression = compressionOf(head);
  const base = { path, bytes, compression };
  if (compression !== 'none' && compression !== 'gzip' && compression !== 'bgzf') {
    return { ...base, format: 'compressed', note: `${compression} data cannot be previewed here; decompress it with a registered script.` };
  }
  let data = head;
  let complete = bytes <= RAW_BYTES;
  if (compression !== 'none') {
    const inflated = await inflatePrefix(head, DECODED_BYTES);
    data = inflated.data;
    complete = complete && inflated.complete;
    const bam = bamHeader(data, lines);
    if (bam) return { ...base, ...bam, sampledBytes: data.length, note: 'BAM header and reference list; alignment records are not decoded. Use samtools through a registered script for counts.' };
  } else if (data.length > DECODED_BYTES) {
    data = data.subarray(0, DECODED_BYTES);
  }
  const magic = BINARY_MAGIC.find(([, signature]) => data.subarray(0, signature.length).equals(signature));
  const sample = data.subarray(0, 4096);
  if (magic || sample.includes(0) || new TextDecoder('utf-8').decode(sample).split('�').length > 8) {
    return { ...base, format: magic?.[0] ?? 'binary', magic: data.subarray(0, 16).toString('hex'), note: 'Binary content; use a registered script to read it.' };
  }
  const text = new TextDecoder('utf-8').decode(data);
  const all = text.split('\n').map(line => line.replace(/\r$/u, ''));
  // The last line may be cut off unless the whole file was read.
  if (!complete || all.at(-1) === '') all.pop();
  const { format, stats } = describeText(all, complete) as { format: string; stats?: Record<string, unknown> };
  return {
    ...base, format, sampledBytes: data.length, complete,
    preview: all.slice(0, lines).map(line => line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line),
    ...(stats ? { stats } : {}),
    note: complete ? 'The whole file was read.' : `Statistics cover the first ${Math.round(data.length / 1024)} KiB${compression === 'none' ? '' : ' after decompression'} only.`,
  };
}

export function inspectTools(options: InspectToolOptions): ToolSet {
  let workspace: Promise<Workspace> | undefined;
  return {
    inspectFile: tool({
      description: 'First look at a project file of any size or type without loading it: size, compression (gzip, BGZF, …), detected format (FASTQ, FASTA, VCF, SAM, BAM header, GFF, BED, CSV/TSV, JSON, text or binary), the first lines and sample statistics (read lengths, GC%, samples, references). Reads at most the first MiB. Use it before readFile on large files.',
      inputSchema: z.object({
        path: z.string().min(1).max(1024),
        lines: z.number().int().min(1).max(200).default(20).describe('Preview lines to return.'),
      }),
      async execute({ path, lines }) {
        workspace ??= createWorkspace(options.root, options.fileAccess);
        return inspect(await workspace, path, lines);
      },
    }),
  };
}

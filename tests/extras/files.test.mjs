import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { inspectTools } from '../../packages/extras/dist/files.js';
import { callTool } from '../fixtures/project.mjs';

// lab-agent-extras/files against generated fixture files. Not live model inference.

const call = (tools, input) => callTool(tools, 'inspectFile', input);

/** One BGZF block (gzip member with the "BC" extra subfield), as written by bgzip and samtools. */
function bgzf(data) {
  const deflated = deflateRawSync(data);
  const header = Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0, 0, 0]);
  header.writeUInt16LE(header.length + deflated.length + 8 - 1, 16);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, deflated, trailer]);
}

function bam(text, references) {
  const parts = [Buffer.from('BAM\u0001', 'latin1')];
  const int = value => { const buffer = Buffer.alloc(4); buffer.writeInt32LE(value); return buffer; };
  parts.push(int(Buffer.byteLength(text)), Buffer.from(text), int(references.length));
  for (const [name, length] of references) parts.push(int(name.length + 1), Buffer.from(`${name}\0`, 'latin1'), int(length));
  return bgzf(Buffer.concat(parts));
}

const FASTQ = '@r1\nACGTACGTAA\n+\nIIIIIIIIII\n@r2\nGGGCCC\n+\nIIIIII\n@r3\nATATATATATAT\n+\n############\n';
const VCF = '##fileformat=VCFv4.2\n##contig=<ID=chr1>\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1\tS2\nchr1\t100\t.\tA\tG\t50\tPASS\t.\tGT\t0/1\t1/1\nchr2\t200\t.\tC\tT\t60\tPASS\t.\tGT\t0/0\t0/1\n';

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'));
  await mkdir(path.join(root, 'other'));
  const put = (name, content) => writeFile(path.join(root, name), content);
  await put('data/reads.fastq', FASTQ);
  await put('data/reads.fastq.gz', gzipSync(FASTQ));
  await put('data/calls.vcf.gz', Buffer.concat([bgzf(Buffer.from(VCF)), bgzf(Buffer.alloc(0))]));
  await put('data/aln.bam', bam('@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:248956422\n@SQ\tSN:chr2\tLN:242193529\n', [['chr1', 248956422], ['chr2', 242193529]]));
  const record = index => `>seq${index} sample\n${'ACGTGC'.repeat(80)}\n${'AT'.repeat(10)}\n`;
  await put('data/big.fasta', Array.from({ length: 3000 }, (_, index) => record(index)).join(''));
  await put('data/table.csv', 'gene,count,sample\nTP53,10,a\nBRCA1,4,b\n');
  await put('data/peaks.bed', 'chr1\t10\t20\tpeak1\nchr2\t5\t9\tpeak2\n');
  await put('data/plot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
  await put('data/archive.bz2', Buffer.from('BZh91AY&SY\u0001\u0002', 'latin1'));
  await put('other/notes.txt', 'outside readRoots\n');
  await put('.env', 'SECRET=1\n');
  return root;
}

test('FASTQ, plain and gzip: format, preview and read statistics', async t => {
  const tools = inspectTools({ root: await project(t) });
  const plain = await call(tools, { path: 'data/reads.fastq', lines: 4 });
  assert.deepEqual([plain.format, plain.compression, plain.complete], ['fastq', 'none', true]);
  assert.deepEqual(plain.preview, ['@r1', 'ACGTACGTAA', '+', 'IIIIIIIIII']);
  assert.deepEqual(plain.stats.length, { min: 6, max: 12, mean: 9.3 });
  assert.equal(plain.stats.readsSampled, 3);
  assert.equal(plain.stats.qualityEncoding, 'phred+33');
  const gz = await call(tools, { path: 'data/reads.fastq.gz' });
  assert.deepEqual([gz.format, gz.compression, gz.stats.readsSampled, gz.stats.gcPercent], ['fastq', 'gzip', 3, plain.stats.gcPercent]);
});

test('BGZF VCF and the BAM header are decoded', async t => {
  const tools = inspectTools({ root: await project(t) });
  const vcf = await call(tools, { path: 'data/calls.vcf.gz' });
  assert.deepEqual([vcf.format, vcf.compression], ['vcf', 'bgzf']);
  assert.deepEqual(vcf.stats.firstSamples, ['S1', 'S2']);
  assert.deepEqual(vcf.stats.chromosomes, ['chr1', 'chr2']);
  assert.equal(vcf.stats.recordsSampled, 2);

  const aln = await call(tools, { path: 'data/aln.bam' });
  assert.deepEqual([aln.format, aln.compression], ['bam', 'bgzf']);
  assert.equal(aln.preview[0], '@HD\tVN:1.6\tSO:coordinate');
  assert.deepEqual(aln.header.firstReferences, [{ name: 'chr1', length: 248956422 }, { name: 'chr2', length: 242193529 }]);
  assert.equal(aln.header.references, 2);
  assert.match(aln.note, /samtools/);
});

test('a large file is sampled: only complete records count', async t => {
  const tools = inspectTools({ root: await project(t) });
  const fasta = await call(tools, { path: 'data/big.fasta', lines: 3 });
  assert.equal(fasta.format, 'fasta');
  assert.equal(fasta.complete, false);
  assert.ok(fasta.bytes > 1024 * 1024);
  assert.equal(fasta.sampledBytes, 1024 * 1024);
  assert.ok(fasta.stats.recordsSampled > 100 && fasta.stats.recordsSampled < 3000);
  assert.deepEqual(fasta.stats.length, { min: 500, max: 500, mean: 500 });
  assert.match(fasta.note, /first 1024 KiB only/);
  assert.equal(fasta.preview.length, 3);
});

test('tables, BED, binary and other compression are recognized', async t => {
  const tools = inspectTools({ root: await project(t) });
  const csv = await call(tools, { path: 'data/table.csv' });
  assert.deepEqual([csv.format, csv.stats.columns, csv.stats.rowsSampled], ['csv', 3, 3]);
  assert.equal((await call(tools, { path: 'data/peaks.bed' })).format, 'bed');
  const png = await call(tools, { path: 'data/plot.png' });
  assert.equal(png.format, 'png');
  assert.equal(png.preview, undefined);
  const bz = await call(tools, { path: 'data/archive.bz2' });
  assert.deepEqual([bz.format, bz.compression], ['compressed', 'bzip2']);
});

test('the file policy applies: secrets, readRoots and missing files', async t => {
  const root = await project(t);
  const tools = inspectTools({ root });
  await assert.rejects(call(tools, { path: '.env' }));
  await assert.rejects(call(tools, { path: '../outside.txt' }), /escapes/);
  await assert.rejects(call(tools, { path: 'data/missing.fastq' }), /ENOENT/);
  await assert.rejects(call(tools, { path: 'data' }), /not a regular file/);
  const restricted = inspectTools({ root, fileAccess: { readRoots: ['data'] } });
  assert.equal((await call(restricted, { path: 'data/table.csv' })).format, 'csv');
  await assert.rejects(call(restricted, { path: 'other/notes.txt' }), /readRoots/);
});

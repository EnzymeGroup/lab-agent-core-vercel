#!/usr/bin/env node
// Citation checker for deep-research tasks (Core checker protocol: writes AGENT_CHECK_FILE).
// It checks structure, not truth: the report exists, every [S#] it uses was recorded by citeSource
// with at least one verified quote, enough distinct sources are cited, and long paragraphs cite something.
// Environment: RESEARCH_REPORT (default report.md), RESEARCH_SOURCES (default sources.json),
// RESEARCH_MIN_SOURCES (default 3).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = process.env.AGENT_OUTPUT_DIR;
const checkFile = process.env.AGENT_CHECK_FILE;
if (!output || !checkFile) {
  console.error('Run this as a lab-agent checker: AGENT_OUTPUT_DIR and AGENT_CHECK_FILE are required.');
  process.exit(2);
}
const reportName = process.env.RESEARCH_REPORT ?? 'report.md';
const sourcesName = process.env.RESEARCH_SOURCES ?? 'sources.json';
const minSources = Number(process.env.RESEARCH_MIN_SOURCES ?? 3);

const checks = [];
const issues = [];
const check = (name, ok, detail, failure = 'failed') => {
  checks.push({ name, status: ok ? 'passed' : failure, ...(detail ? { detail } : {}) });
  if (!ok) issues.push(`${name}: ${detail}`);
};

const report = await readFile(path.join(output, reportName), 'utf8').catch(() => undefined);
check('report', !!report?.trim(), report?.trim() ? undefined : `${reportName} is missing or empty`);

let sources = [];
try {
  sources = JSON.parse(await readFile(path.join(output, sourcesName), 'utf8'));
  if (!Array.isArray(sources)) throw new Error('not a list');
  check('sources', true);
} catch (error) {
  check('sources', false, `${sourcesName} is missing or invalid (${error.message}); record sources with citeSource`);
}

if (report?.trim()) {
  const known = new Map(sources.map(source => [source.id, source]));
  const cited = new Set();
  for (const group of report.matchAll(/\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/gu)) for (const id of group[1].split(/[,;]/u)) cited.add(id.trim());
  const unknown = [...cited].filter(id => !known.has(id));
  check('citations resolve', !unknown.length, unknown.length ? `${unknown.join(', ')} not in ${sourcesName}` : undefined);
  const unquoted = [...cited].filter(id => known.has(id) && !(known.get(id).quotes?.length));
  check('citations quoted', !unquoted.length, unquoted.length ? `${unquoted.join(', ')} have no verified quote` : undefined);
  const distinct = [...cited].filter(id => known.has(id)).length;
  check('enough sources', distinct >= minSources, `${distinct} distinct source(s) cited; ${minSources} required`, distinct ? 'partial' : 'failed');

  // Prose paragraphs of some length should carry a citation; headings, lists of references and code are skipped.
  const body = report.split(/^#{1,6}\s*(?:references|sources|bibliography)\b.*$/imu)[0].replace(/```[\s\S]*?```/gu, '');
  const bare = body.split(/\n\s*\n/u).map(part => part.trim())
    .filter(part => part.length >= 200 && !part.startsWith('#') && !/\[S\d+/u.test(part));
  check('paragraphs cite sources', !bare.length, bare.length ? `${bare.length} paragraph(s) of 200+ characters cite nothing, e.g. "${bare[0].slice(0, 80)}…"` : undefined, 'partial');
  const unused = sources.filter(source => !cited.has(source.id)).map(source => source.id);
  if (unused.length) checks.push({ name: 'unused sources', status: 'passed', detail: `recorded but not cited: ${unused.join(', ')}` });
}

const status = checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'partial') ? 'partial' : 'passed';
await writeFile(checkFile, JSON.stringify({ status, checks, issues }, null, 2));

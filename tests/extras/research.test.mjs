import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, discoverSkills, createWorkspace, loadAgentConfig, modelFromEnv, runWithExecutionContext } from '../../packages/core/dist/index.js';
import { webTools } from '../../packages/extras/dist/web.js';
import { researchTools, researchSubagents, normalizeQuote, CITATIONS_CHECKER, RESEARCH_SKILL_DIR } from '../../packages/extras/dist/research.js';
import { startModelServer } from '../fixtures/model-server.mjs';

// lab-agent-extras/research against local pages and the deterministic model fixture. Not live research.
const repository = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

const call = (tools, name, input) => tools[name].execute(tools[name].inputSchema.parse(input), { toolCallId: 'test', messages: [] });

async function pages(t, count = 5) {
  const server = http.createServer((req, res) => {
    const index = Number(req.url.slice(1));
    if (!(index >= 1 && index <= count)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Paper ${index}</title></head><body><p>Finding ${index}: the “p53 protein” halts the cell cycle — after DNA   damage.</p></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function task(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-research-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 'run-fixture';
  const outputDirectory = path.join(root, 'runs', runId, 'output');
  await mkdir(outputDirectory, { recursive: true });
  return { root, outputDirectory, inTask: work => runWithExecutionContext({ runId, outputDirectory }, work) };
}

test('quotes are matched ignoring case, spacing, curly quotes and dashes', () => {
  assert.equal(normalizeQuote('The “p53  protein” — halts'), normalizeQuote('the "p53 protein" - halts'));
});

test('citeSource verifies the quote, keeps one id per page and refuses paraphrases and chat', async t => {
  const base = await pages(t);
  const { root, outputDirectory, inTask } = await task(t);
  const tools = researchTools({ root, allowPrivate: true });
  const first = await inTask(() => call(tools, 'citeSource', { url: `${base}/1`, quote: 'the "p53 protein" halts the cell cycle - after DNA damage' }));
  assert.deepEqual([first.id, first.cite, first.title, first.quotes], ['S1', '[S1]', 'Paper 1', 1]);
  const again = await inTask(() => call(tools, 'citeSource', { url: `${base}/1#section`, quote: 'Finding 1: the “p53 protein”' }));
  assert.deepEqual([again.id, again.quotes], ['S1', 2], 'the same page keeps its id');
  await assert.rejects(inTask(() => call(tools, 'citeSource', { url: `${base}/2`, quote: 'p53 activates apoptosis in every tissue' })), /quote was not found/);
  await assert.rejects(call(tools, 'citeSource', { url: `${base}/2`, quote: 'Finding 2: the "p53 protein"' }), /task mode/);

  const saved = JSON.parse(await readFile(path.join(outputDirectory, 'sources.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.match(saved[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(saved[0].quotes.length, 2);
  const listed = await inTask(() => call(tools, 'listSources', {}));
  assert.deepEqual(listed.sources.map(source => source.id), ['S1']);
});

test('parallel citeSource calls never lose a record', async t => {
  const base = await pages(t);
  const { root, outputDirectory, inTask } = await task(t);
  const tools = researchTools({ root, allowPrivate: true });
  const results = await inTask(() => Promise.all([1, 2, 3, 4, 5].map(index => call(tools, 'citeSource', { url: `${base}/${index}`, quote: `Finding ${index}: the "p53 protein"` }))));
  assert.deepEqual(results.map(result => result.id).sort(), ['S1', 'S2', 'S3', 'S4', 'S5']);
  const saved = JSON.parse(await readFile(path.join(outputDirectory, 'sources.json'), 'utf8'));
  assert.deepEqual(saved.map(source => source.id), ['S1', 'S2', 'S3', 'S4', 'S5']);
});

async function check(t, files, env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lab-agent-citations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  const checkFile = path.join(dir, 'check.json');
  await run(process.execPath, [CITATIONS_CHECKER], { env: { ...process.env, AGENT_OUTPUT_DIR: dir, AGENT_CHECK_FILE: checkFile, ...env } });
  return JSON.parse(await readFile(checkFile, 'utf8'));
}

const SOURCES = JSON.stringify([
  { id: 'S1', url: 'https://a.example', quotes: ['x'], retrievedAt: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64) },
  { id: 'S2', url: 'https://b.example', quotes: ['y'], retrievedAt: '2026-01-01T00:00:00Z', sha256: 'b'.repeat(64) },
  { id: 'S3', url: 'https://c.example', quotes: [], retrievedAt: '2026-01-01T00:00:00Z', sha256: 'c'.repeat(64) },
]);

test('the citation checker: passed, partial and failed reports', async t => {
  const passed = await check(t, { 'report.md': '# T\n\nOne [S1]. Two [S1, S2].\n\n## Sources\n[S1] a\n', 'sources.json': SOURCES }, { RESEARCH_MIN_SOURCES: '2' });
  assert.equal(passed.status, 'passed', JSON.stringify(passed.issues));
  assert.match(passed.checks.find(item => item.name === 'unused sources').detail, /S3/);

  const few = await check(t, { 'report.md': '# T\n\nOne [S1].\n', 'sources.json': SOURCES });
  assert.equal(few.status, 'partial');
  assert.match(few.issues.join(' '), /1 distinct source\(s\) cited; 3 required/);

  const bare = await check(t, { 'report.md': `# T\n\n${'Uncited claim. '.repeat(20)}\n\nCited [S1] [S2].\n`, 'sources.json': SOURCES }, { RESEARCH_MIN_SOURCES: '2' });
  assert.equal(bare.status, 'partial');
  assert.match(bare.issues.join(' '), /cite nothing/);

  const invented = await check(t, { 'report.md': 'Claim [S9]. Other [S3].\n', 'sources.json': SOURCES });
  assert.equal(invented.status, 'failed');
  assert.match(invented.issues.join(' '), /S9 not in sources.json/);
  assert.match(invented.issues.join(' '), /S3 have no verified quote/);

  const missing = await check(t, {});
  assert.equal(missing.status, 'failed');
  assert.match(missing.issues.join(' '), /report.md is missing/);
});

test('a Core task: two researcher helpers in parallel, report.md cites both, the checker passes', async t => {
  const base = await pages(t);
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-research-agent-'));
  await cp(path.join(repository, 'examples/sequence-summary'), root, { recursive: true, filter: source => !/(?:^|\/)(?:runs|\.lab-agent|__pycache__)(?:\/|$)/.test(source) });
  const offered = input => (input.tools ?? []).map(item => item.function.name);
  const plan = input => {
    if (!offered(input).includes('runSubagent')) {
      // A helper: read its sub-question's page and cite it.
      const index = JSON.stringify(input.messages).match(/page (\d)/)[1];
      return [{ name: 'citeSource', args: { url: `${base}/${index}`, quote: `Finding ${index}: the "p53 protein" halts the cell cycle` } }];
    }
    const output = JSON.stringify(input.messages).match(/outputDirectory is (runs\/[^ ]+\/output)/)[1];
    return [
      [1, 2].map(index => ({ name: 'runSubagent', args: { agent: 'researcher', task: `Sub-question ${index}: read page ${index}.` } })),
      { name: 'writeFile', args: { path: `${output}/report.md`, content: '# p53\n\np53 halts the cell cycle [S1, S2].\n\n## Sources\n[S1] [S2]\n' } },
    ];
  };
  const fixture = await startModelServer({ plan });
  const model = modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const agent = await createAgent({
    root, model, env: { ...process.env, RESEARCH_MIN_SOURCES: '2' },
    tools: { ...webTools({ search: false, allowPrivate: true }), ...researchTools({ root, allowPrivate: true }) },
    subagents: researchSubagents({ tools: ['webFetch', 'citeSource'] }),
    validation: { command: [process.execPath, CITATIONS_CHECKER] },
  });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });

  const result = await agent.runTask('[chat-only] research p53');
  assert.equal(result.execution, 'completed');
  assert.equal(result.delivery, 'passed', JSON.stringify(await agent.runs.report(result.id)));
  assert.deepEqual(result.artifacts, ['output/report.md', 'output/sources.json']);
  assert.equal(result.steps.filter(step => step.agent === 'researcher').length, 4, 'two helpers, two steps each');
  const sources = JSON.parse(await readFile(path.join(result.directory, 'output/sources.json'), 'utf8'));
  assert.deepEqual(sources.map(source => source.id).sort(), ['S1', 'S2']);
});

test('the packaged Skill and the example project stay in step', async () => {
  const example = path.join(repository, 'packages/extras/examples/research');
  assert.equal(await readFile(path.join(example, '.agents/skills/deep-research/SKILL.md'), 'utf8'), await readFile(path.join(RESEARCH_SKILL_DIR, 'SKILL.md'), 'utf8'), 'the example copy matches the packaged Skill');
  const skills = await discoverSkills(await createWorkspace(example));
  assert.deepEqual(skills.map(skill => skill.name), ['deep-research']);

  const env = { LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'fixture', LAB_AGENT_API_KEY: 'fixture-only' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const config = await loadAgentConfig(example);
    assert.deepEqual(Object.keys(config.subagents).sort(), ['researcher', 'verifier']);
    for (const name of ['webSearch', 'webFetch', 'citeSource', 'listSources', 'ncbiSearch', 'uniprotSearch']) assert.ok(config.tools[name], name);
    assert.equal(config.tools.ensemblLookup, undefined);
    assert.deepEqual(config.validation.command, ['node', CITATIONS_CHECKER]);
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

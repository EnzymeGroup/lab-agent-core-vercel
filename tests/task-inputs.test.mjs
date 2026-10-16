import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, createRequestHandler, InputError, modelFromEnv, runCommand } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

async function setup(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-task-inputs-'));
  await cp(new URL('../examples/sequence-summary/', import.meta.url), root, { recursive: true,
    filter: file => !/(?:^|\/)(?:runs|\.lab-agent|node_modules|__pycache__)(?:\/|$)/u.test(file) });
  const fixture = await startModelServer();
  const model = modelFromEnv({ LAB_AGENT_MODEL: 'input-fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const config = { root, model, python: { scripts: { summarize: { path: 'tools/summarize.py', description: 'Summarize FASTA', modes: ['task'] } } }, validation: { command: ['python3', 'tools/validate.py'] }, ...extra };
  const agent = await createAgent(config);
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:8787'; const token = 'task-input-token-for-local-test-only';
  const handler = createRequestHandler(agent, { origin, token, assets: root });
  const request = (url, init = {}) => handler(new Request(`${origin}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }));
  return { root, fixture, config, agent, request };
}

test('uploading unrelated sample B never changes default run A frozen provenance or recheck verdict', async t => {
  const { agent, request, fixture } = await setup(t);
  const run = await agent.runTask('Summarize sample A.');
  assert.equal(run.delivery, 'passed');
  assert.equal(run.provenance.inputSelection.source, 'default');
  const baseline = JSON.stringify(run.provenance.inputs);
  assert.equal((await request('/api/uploads?name=sample_B.csv', { method: 'POST', body: 'sample,value\nB,2\n' })).status, 201);
  const count = fixture.requests.length;
  const checked = await agent.runs.check(run.id);
  assert.equal(checked.delivery, 'passed');
  assert.deepEqual(checked.checks.at(-1).inputChanges, []);
  assert.equal(JSON.stringify(checked.provenance.inputs), baseline);
  assert.equal(fixture.requests.length, count);
});

test('per-task binding overrides project directory selection and detects changed or deleted bound inputs', async t => {
  const { root, agent } = await setup(t, { provenance: { inputs: ['data'] } });
  await writeFile(path.join(root, 'data/unrelated.csv'), 'B,original');
  const run = await agent.runTask('Analyze only sample A.', { inputs: ['data/input.fasta'] });
  assert.deepEqual(run.provenance.inputSelection, { source: 'turn', paths: ['data/input.fasta'] });
  assert.deepEqual(run.provenance.inputs.map(file => file.path), ['data/input.fasta']);
  await writeFile(path.join(root, 'data/unrelated.csv'), 'B,modified');
  assert.equal((await agent.runs.check(run.id)).delivery, 'passed');
  const input = path.join(root, 'data/input.fasta'); const source = await readFile(input, 'utf8');
  await writeFile(input, `${source}\n>extra\nAAAA\n`);
  const changed = await agent.runs.check(run.id);
  assert.equal(changed.delivery, 'failed');
  assert.deepEqual(changed.checks.at(-1).inputChanges, ['data/input.fasta']);
  await writeFile(input, source);
  assert.equal((await agent.runs.check(run.id)).delivery, 'passed');
  await rm(input);
  const deleted = await agent.runs.check(run.id);
  assert.equal(deleted.delivery, 'failed');
  assert.deepEqual(deleted.checks.at(-1).inputChanges, ['data/input.fasta']);
  assert.equal(deleted.originalDelivery.delivery, 'passed');
});

test('directories enumerate once, explicit empty bindings remain empty, and rc.2 recorded baselines stay frozen', async t => {
  const { root, agent } = await setup(t);
  const directory = await agent.runTask('Analyze frozen input directory.', { inputs: ['data'] });
  delete directory.provenance.inputSelection;
  delete directory.provenance.skills;
  await agent.runs.save(directory); // rc.2 additive-field compatibility.
  await writeFile(path.join(root, 'data/later.csv'), 'unrelated,new');
  assert.equal((await agent.runs.check(directory.id)).delivery, 'passed');
  const none = await agent.runTask('Analyze with no declared provenance inputs.', { inputs: [] });
  assert.deepEqual(none.provenance.inputs, []);
  assert.deepEqual(none.provenance.inputSelection, { source: 'turn', paths: [] });
  await writeFile(path.join(root, 'data/another.csv'), 'another,new');
  assert.equal((await agent.runs.check(none.id)).delivery, 'passed');
});

test('input manifests include hidden assay files and deduplicate canonical path spellings', async t => {
  const { root, agent } = await setup(t);
  await writeFile(path.join(root, 'data/.assay.csv'), 'sample,value\nA,1\n');
  const directory = await agent.runTask('Bind all scientific input files.', { inputs: ['data'] });
  assert.ok(directory.provenance.inputs.some(file => file.path === 'data/.assay.csv'));
  await writeFile(path.join(root, 'data/.assay.csv'), 'sample,value\nA,changed\n');
  assert.equal((await agent.runs.check(directory.id)).delivery, 'failed');
  const one = await agent.runTask('Bind input exactly once.', { inputs: ['data/input.fasta', './data/input.fasta', path.join(root, 'data/input.fasta')] });
  assert.equal(one.provenance.inputs.length, 1);
});

test('invalid input declarations and chat bindings reject before inference or user-message persistence', async t => {
  const { agent, fixture, request } = await setup(t);
  const session = await agent.sessions.create('Rejected bindings');
  for (const inputs of [['../outside.csv'], ['missing.csv'], ['.env'], ['.lab-agent/sessions'], [null], Array(257).fill('data/input.fasta')]) {
    await assert.rejects(agent.runTask('Do not start invalid task.', { sessionId: session.id, inputs }), InputError);
  }
  await assert.rejects(agent.chat('No task inputs in chat.', { sessionId: session.id, inputs: [] }), /task mode only/);
  const response = await request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, mode: 'task', inputs: ['missing.csv'], messages: [{ id: 'bad-input-message', role: 'user', parts: [{ type: 'text', text: 'Invalid input' }] }] }) });
  assert.equal(response.status, 400);
  assert.deepEqual((await agent.sessions.load(session.id)).messages, []);
  assert.equal((await agent.runs.list()).runs.length, 0);
  assert.equal(fixture.requests.length, 0);
});

test('installed CLI shape accepts repeatable --input and passes an explicit frozen manifest', async t => {
  const { root, fixture } = await setup(t);
  const entry = new URL('../packages/core/dist/index.js', import.meta.url).href;
  const configFile = path.join(root, 'agent.config.ts');
  const source = await readFile(configFile, 'utf8');
  await writeFile(configFile, source.replace("'lab-agent-core-vercel'", JSON.stringify(entry)));
  await writeFile(path.join(root, 'data/notes.txt'), 'Fixed unit policy');
  const result = await runCommand(process.execPath, [fileURLToPath(new URL('../packages/core/dist/cli.js', import.meta.url)), 'run', 'Summarize source FASTA.', '--root', root, '--input', 'data/input.fasta', '--input', 'data/notes.txt', '--json'], {
    cwd: root, env: { LAB_AGENT_MODEL: 'input-fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url }, timeoutMs: 15_000,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const run = JSON.parse(result.stdout);
  assert.equal(run.delivery, 'passed');
  assert.deepEqual(run.provenance.inputs.map(file => file.path), ['data/input.fasta', 'data/notes.txt']);
});

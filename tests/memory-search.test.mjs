import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, createHttpServer, createTools, createWorkspace, saveMemory, InputError } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';
import { callTool, copyExample, fixtureModel } from './fixtures/project.mjs';

// Deterministic local HTTP model fixture. Not live model inference.
// The SDK parses inputs (and fills defaults) before execute; do the same here.
const call = callTool;

async function searchProject(t, policy) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'data/a.csv': 'id,value\n1,alpha\n2,beta\n',
    'data/sub/b.tsv': 'x\tALPHA\n',
    '.env': 'SECRET=alpha\n',
    'secrets/key.txt': 'alpha\n',
    'node_modules/pkg/index.js': 'alpha\n',
    '.lab-agent/memory/note.md': 'alpha\n',
    'bin.dat': 'alpha\0\n',
    'big.txt': `alpha\n${'x'.repeat(1_100_000)}\n`,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const workspace = await createWorkspace(root, policy);
  return createTools(workspace, { root, model: {} });
}

test('findFiles: recursive globs over allowed files only', async t => {
  const tools = await searchProject(t);
  assert.deepEqual((await call(tools, 'findFiles', { pattern: '*.csv' })).files, ['data/a.csv']);
  assert.deepEqual((await call(tools, 'findFiles', { pattern: 'data/**/*.{csv,tsv}' })).files, ['data/a.csv', 'data/sub/b.tsv']);
  assert.deepEqual((await call(tools, 'findFiles', { pattern: '*.tsv', path: 'data' })).files, ['data/sub/b.tsv']);
  assert.deepEqual((await call(tools, 'findFiles', { pattern: 'sub/*.tsv', path: 'data' })).files, ['data/sub/b.tsv']);
  const all = (await call(tools, 'findFiles', { pattern: '**' })).files;
  assert.deepEqual(all, ['big.txt', 'bin.dat', 'data/a.csv', 'data/sub/b.tsv'], 'secrets, metadata and node_modules never appear');
  const limited = await call(tools, 'findFiles', { pattern: '**', limit: 1 });
  assert.equal(limited.files.length, 1);
  assert.equal(limited.truncated, true);
  await assert.rejects(call(tools, 'findFiles', { pattern: '*', path: '.lab-agent' }), /unavailable/);
});

test('searchFiles: regex matches with line numbers; secrets, binaries and large files are excluded', async t => {
  const tools = await searchProject(t);
  const result = await call(tools, 'searchFiles', { pattern: 'alpha', ignoreCase: true });
  assert.deepEqual(result.matches, [{ path: 'data/a.csv', line: 2, text: '1,alpha' }, { path: 'data/sub/b.tsv', line: 1, text: 'x\tALPHA' }]);
  assert.deepEqual(result.skipped, { binary: 1, tooLarge: 1, unreadable: 0 });
  assert.equal(result.filesSearched, 2);
  assert.equal((await call(tools, 'searchFiles', { pattern: 'alpha' })).matches.length, 1, 'case-sensitive by default');
  assert.deepEqual((await call(tools, 'searchFiles', { pattern: '\\d,', glob: '*.csv' })).matches.map(match => match.line), [2, 3]);
  await assert.rejects(call(tools, 'searchFiles', { pattern: '(' }), /Invalid regular expression/);

  const scoped = await searchProject(t, { readRoots: ['data/sub'] });
  assert.deepEqual((await call(scoped, 'searchFiles', { pattern: 'alpha', ignoreCase: true })).matches.map(match => match.path), ['data/sub/b.tsv']);
});

const lastUserText = input => {
  const user = (input.messages ?? []).findLast(message => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
};
const systemText = input => (input.messages ?? []).filter(message => message.role === 'system').map(message => message.content).join('\n');
const completions = fixture => fixture.requests.filter(request => request.path === '/v1/chat/completions' && request.body);

async function memoryAgent(t, config = {}) {
  const root = await copyExample('lab-agent-memory-');
  const fixture = await startModelServer({
    plan: input => {
      const text = lastUserText(input);
      if (/\[remember\]/.test(text)) return [{ name: 'saveMemory', args: { name: 'output-format', description: 'Deliver tables as TSV', type: 'feedback', content: 'Write tables as TSV.\n**Why:** the lab pipeline reads TSV.' } }];
      if (/\[recall\]/.test(text)) return [{ name: 'readMemory', args: { name: 'output-format' } }];
      if (/\[forget\]/.test(text)) return [{ name: 'forgetMemory', args: { name: 'output-format' } }];
      return [];
    },
  });
  const model = fixtureModel(fixture.url, 'fixture-default');
  t.after(async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const agent = await createAgent({ root, model, validation: undefined, ...config });
  t.after(() => agent.close());
  return { root, agent, fixture };
}

test('memory: saved in one session, indexed in the next, read and forgotten', async t => {
  const { root, agent, fixture } = await memoryAgent(t);
  const first = await agent.chat('[remember] use TSV from now on');
  assert.equal(first.error, undefined);
  await access(path.join(root, '.lab-agent/memory/output-format.md'));
  assert.match(systemText(completions(fixture)[0].body), /Project memory persists across sessions/);
  assert.match(lastUserText(completions(fixture)[0].body), /Project memory index: \(empty\)/);

  const before = completions(fixture).length;
  const second = await agent.chat('[recall] how should tables look?');
  const request = completions(fixture)[before].body;
  assert.match(lastUserText(request), /- output-format \[feedback\]: Deliver tables as TSV/, 'a new session sees the index');
  const read = second.session.messages.flatMap(message => message.parts).find(part => part.type === 'tool-readMemory');
  assert.equal(read.output.content, 'Write tables as TSV.\n**Why:** the lab pipeline reads TSV.');
  assert.ok(!second.session.messages.some(message => JSON.stringify(message.parts).includes('Project memory index')), 'the index is never stored in history');

  const state = await agent.inspect();
  assert.deepEqual(state.memory.map(({ updatedAt: _updatedAt, ...entry }) => entry), [{ name: 'output-format', description: 'Deliver tables as TSV', type: 'feedback' }]);
  assert.ok(state.tools.includes('saveMemory') && state.tools.includes('searchFiles'));

  // A task records which entries the model was shown.
  const run = await agent.runTask('[chat-only] summarize');
  assert.deepEqual(run.provenance.memory.map(entry => entry.name), ['output-format']);
  assert.match(run.provenance.memory[0].sha256, /^[a-f0-9]{64}$/);

  await agent.chat('[forget] that was wrong');
  assert.deepEqual(await agent.memory.list(), []);
  await assert.rejects(agent.memory.read('output-format'), /No memory named/);
  await assert.rejects(agent.memory.read('../escape'), InputError);
});

test('memory: workbench routes read and delete entries; file tools never see them', async t => {
  const { root, agent } = await memoryAgent(t);
  await saveMemory(root, { name: 'data-location', description: 'Raw reads live on the cluster', type: 'reference', content: 'See /lab/raw.' });
  const server = await createHttpServer(agent);
  t.after(() => server.close());
  const request = (method, route) => fetch(`${server.url}${route}`, { method, headers: { Authorization: `Bearer ${server.token}` } });

  const state = await (await request('GET', '/api/state')).json();
  assert.equal(state.memory[0].name, 'data-location');
  assert.equal(state.memory[0].content, undefined, 'state carries summaries only');
  assert.equal((await (await request('GET', '/api/memory?name=data-location')).json()).content, 'See /lab/raw.');
  assert.equal((await request('GET', '/api/memory?name=missing')).status, 404);
  assert.equal((await request('DELETE', '/api/memory?name=data-location')).status, 200);
  assert.deepEqual(await agent.memory.list(), []);

  await assert.rejects(agent.native.tools.readFile.execute({ path: '.lab-agent/memory/data-location.md' }, { toolCallId: 'x', messages: [] }), /unavailable/);
});

test('memory: false removes the tools, rules and index; helpers never get memory tools', async t => {
  const { agent, fixture } = await memoryAgent(t, { memory: false });
  await agent.chat('hello');
  const body = completions(fixture)[0].body;
  assert.doesNotMatch(systemText(body), /Project memory/);
  assert.doesNotMatch(lastUserText(body), /Project memory index/);
  const state = await agent.inspect();
  assert.equal(state.memory, false);
  assert.ok(!state.tools.includes('saveMemory'));

  const helper = await memoryAgent(t, { subagents: { scout: { description: 'Look around', instructions: 'Report what you find.' } } });
  const scout = (await helper.agent.inspect()).subagents[0];
  assert.ok(!scout.tools.some(name => /Memory$/.test(name)));
  assert.ok(scout.tools.includes('searchFiles'));
  await assert.rejects(memoryAgent(t, { subagents: { scout: { description: 'x', instructions: 'y', tools: ['saveMemory'] } } }), /cannot include saveMemory/);
  await assert.rejects(memoryAgent(t, { memory: 'yes' }), /memory must be true or false/);
});

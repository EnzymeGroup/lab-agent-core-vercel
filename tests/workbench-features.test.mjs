import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAgent, createHttpServer, InputError, NotFoundError } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';
import { startMcpHttpServer } from './fixtures/mcp-http-server.mjs';
import { copyExample, fixtureModel } from './fixtures/project.mjs';

// Deterministic local HTTP fixtures (model and MCP). Not live model inference.

async function setup(t, config = {}) {
  const root = await copyExample('lab-agent-workbench-');
  const fixture = await startModelServer();
  const model = id => fixtureModel(fixture.url, id);
  const agent = await createAgent({ root, model: model('fixture-default'), models: { strong: model('fixture-strong') },
    python: { scripts: { summarize: { path: 'tools/summarize.py', description: 'Summarize FASTA source data' } } }, ...config });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  return { root, agent, fixture, model };
}

test('sessions switch between configured models and runs record the model key', async t => {
  const { agent, fixture } = await setup(t);
  const state = await agent.inspect();
  assert.deepEqual(state.models.map(choice => [choice.key, choice.id, choice.default]), [['default', 'fixture-default', true], ['strong', 'fixture-strong', false]]);
  assert.deepEqual(state.limits, { maxSteps: 20, timeoutMs: 600_000, maxContextChars: 120_000, maxRetries: 2 });

  const first = await agent.chat('[chat-only] hello', { model: 'strong' });
  assert.equal(fixture.requests.at(-1).body.model, 'fixture-strong');
  assert.equal(first.session.model, 'strong');

  // The session keeps its model until another is chosen.
  await agent.chat('[chat-only] again', { sessionId: first.session.id });
  assert.equal(fixture.requests.at(-1).body.model, 'fixture-strong');

  const run = await agent.runTask('[chat-only] task on default', { sessionId: first.session.id, model: 'default' });
  assert.deepEqual(run.model, { key: 'default', provider: 'openai.chat', id: 'fixture-default' });
  assert.equal(fixture.requests.at(-1).body.model, 'fixture-default');
  assert.equal((await agent.sessions.load(first.session.id)).model, undefined);

  await assert.rejects(agent.chat('[chat-only] nope', { model: 'missing' }), error => error instanceof InputError && /Unknown model "missing"/.test(error.message));
});

test('assistant messages carry model, bounded context size and token usage', async t => {
  const { agent } = await setup(t, { limits: { maxContextChars: 50_000 } });
  const { session } = await agent.chat('[chat-only] measure context');
  const metadata = session.messages.at(-1).metadata;
  assert.equal(metadata.model.key, 'default');
  assert.ok(metadata.context.chars > 0 && metadata.context.chars <= 50_000);
  assert.equal(metadata.context.maxChars, 50_000);
  assert.equal(metadata.context.droppedMessages, 0);
  assert.equal(metadata.usage.totalTokens, 20);
});

test('reading a Skill returns its text without marking it as used', async t => {
  const { agent } = await setup(t);
  const skill = await agent.skills.read('sequence-summary');
  assert.match(skill.content, /^---\nname: sequence-summary/);
  assert.equal(skill.path, '.agents/skills/sequence-summary/SKILL.md');
  await assert.rejects(agent.skills.read('missing'), NotFoundError);
  const run = await agent.runTask('[chat-only] no skill needed');
  assert.ok(run.provenance.skills.every(fingerprint => !fingerprint.loaded));
});

test('project HTTP MCP servers can be tested, added with secret headers, used and removed', async t => {
  const { root, agent } = await setup(t);
  const mcp = await startMcpHttpServer({ token: 'fixture-mcp-token' });
  t.after(() => mcp.close());

  const unauthorized = await agent.mcp.test({ name: 'remote', url: mcp.url });
  assert.equal(unauthorized.status, 'unavailable');
  const tested = await agent.mcp.test({ name: 'remote', url: mcp.url, headers: { Authorization: 'Bearer fixture-mcp-token' } });
  assert.equal(tested.status, 'connected');
  assert.deepEqual(tested.tools.map(tool => tool.name), ['mcp_remote_echo']);
  assert.equal((await agent.mcp.list()).servers.length, 0, 'testing changes nothing');

  await assert.rejects(agent.mcp.add({ name: 'local', url: 'file:///bin/sh' }), InputError);
  await assert.rejects(agent.mcp.add({ name: 'creds', url: 'http://user:pass@127.0.0.1/' }), InputError);
  await assert.rejects(agent.mcp.add({ name: 'stdio', transport: 'stdio', command: 'sh' }), InputError);

  const added = await agent.mcp.add({ name: 'remote', url: mcp.url, headers: { Authorization: 'Bearer fixture-mcp-token' } });
  const server = added.servers.find(item => item.name === 'remote');
  assert.equal(server.source, 'project');
  assert.equal(server.status, 'connected');
  assert.deepEqual(server.tools, ['mcp_remote_echo']);
  assert.deepEqual(server.headerNames, ['Authorization']);
  assert.ok(!JSON.stringify(added).includes('fixture-mcp-token'), 'header values are never returned');
  assert.ok(agent.native.tools.mcp_remote_echo, 'the live agent sees the new tool');
  await assert.rejects(agent.mcp.add({ name: 'remote', url: mcp.url }), /already exists/);

  const { session } = await agent.chat('[tool:mcp_remote_echo] call it');
  // MCP tools are dynamic: their UI parts are `dynamic-tool` with a toolName.
  const call = session.messages.flatMap(message => message.parts).find(part => part.type === 'dynamic-tool' && part.toolName === 'mcp_remote_echo');
  assert.equal(call.state, 'output-available');
  assert.match(JSON.stringify(call.output), /HTTP echo/);

  const stored = JSON.parse(await readFile(path.join(root, '.lab-agent/mcp.json'), 'utf8'));
  assert.equal(stored.servers[0].headers.Authorization, 'Bearer fixture-mcp-token');

  const removed = await agent.mcp.remove('remote');
  assert.equal(removed.servers.length, 0);
  assert.equal(agent.native.tools.mcp_remote_echo, undefined);
  await assert.rejects(agent.mcp.remove('remote'), NotFoundError);
});

test('HTTP routes expose models, Skills and MCP management behind the token', async t => {
  const { agent } = await setup(t);
  const mcp = await startMcpHttpServer();
  t.after(() => mcp.close());
  const server = await createHttpServer(agent);
  t.after(() => server.close());
  const call = (route, init = {}) => fetch(`${server.url}${route}`, { ...init, headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', ...init.headers } });

  const state = await (await call('/api/state')).json();
  assert.deepEqual(state.models.map(choice => choice.key), ['default', 'strong']);
  assert.equal((await call('/api/skill?name=sequence-summary')).status, 200);
  assert.equal((await call('/api/skill?name=missing')).status, 404);
  assert.equal((await fetch(`${server.url}/api/mcp`, { method: 'POST', body: '{}' })).status, 403, 'token required');

  const draft = JSON.stringify({ name: 'remote', url: mcp.url });
  assert.equal((await (await call('/api/mcp/test', { method: 'POST', body: draft })).json()).status, 'connected');
  assert.equal((await call('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'bad', url: 'ftp://x' }) })).status, 400);
  assert.equal((await call('/api/mcp', { method: 'POST', body: draft })).status, 201);
  assert.ok((await (await call('/api/state')).json()).tools.includes('mcp_remote_echo'));
  assert.equal((await call('/api/mcp?name=remote', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/mcp?name=remote', { method: 'DELETE' })).status, 404);
});

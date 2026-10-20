import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, createHttpServer, modelFromEnv, InputError } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

// Core upgrades on feat/extras: tool switches, parallel helpers, attachments, environment provenance.
// Deterministic local HTTP model fixture. Not live model inference.
const repository = fileURLToPath(new URL('../', import.meta.url));

async function setup(t, { fixture: fixtureOptions, config = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-upgrades-'));
  await cp(path.join(repository, 'examples/sequence-summary'), root, { recursive: true,
    filter: source => !/(?:^|\/)(?:runs|\.lab-agent|__pycache__)(?:\/|$)/.test(source) });
  const fixture = await startModelServer(fixtureOptions);
  const model = modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'fixture-default', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const calls = [];
  const stamp = tool({
    description: 'Stamp a note (side effect that needs approval in these tests).',
    inputSchema: z.object({ note: z.string() }),
    execute: async ({ note }) => { calls.push(note); return { stamped: note }; },
  });
  let agent;
  t.after(async () => { await agent?.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  agent = await createAgent({ root, model, ...config, tools: { stamp, ...config.tools } });
  return { root, agent, fixture, calls, model };
}

const completions = fixture => fixture.requests.filter(request => request.path === '/v1/chat/completions');
const toolParts = (session, name) => session.messages.flatMap(message => message.parts).filter(part => part.type === `tool-${name}`);
const offered = request => (request.body.tools ?? []).map(item => item.function.name);

test('tool switches: alwaysAllow skips the pause; it is saved, recorded and reversible', async t => {
  const { root, agent, calls, model } = await setup(t, { fixture: { plan: [{ name: 'stamp', args: { note: 'auto' } }] }, config: { approval: ['stamp'] } });
  await assert.rejects(agent.tools.update({ name: 'readFile', alwaysAllow: true }), /does not need approval/);
  await assert.rejects(agent.tools.update({ name: 'nope', enabled: false }), /Unknown tool/);
  await assert.rejects(agent.tools.update({ name: 'stamp' }), InputError);

  assert.deepEqual(await agent.tools.update({ name: 'stamp', alwaysAllow: true }), { disabled: [], alwaysAllow: ['stamp'] });
  const state = await agent.inspect();
  const detail = state.toolDetails.find(item => item.name === 'stamp');
  assert.deepEqual([detail.needsApproval, detail.alwaysAllow, detail.enabled], [true, true, true]);
  const run = await agent.runTask('[chat-only] stamp');
  assert.equal(run.execution, 'completed');
  assert.deepEqual(calls, ['auto']);
  assert.deepEqual(run.provenance.toolSettings, { disabled: [], alwaysAllow: ['stamp'] });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.lab-agent/tools.json'), 'utf8')), { disabled: [], alwaysAllow: ['stamp'] });

  // A new agent on the same project reads the saved switches.
  await agent.close();
  const again = await createAgent({ root, model, tools: agent.config.tools, approval: ['stamp'] });
  t.after(() => again.close());
  assert.deepEqual(again.tools.settings(), { disabled: [], alwaysAllow: ['stamp'] });
  await again.tools.update({ name: 'stamp', alwaysAllow: false });
  const paused = await again.chat('[chat-only] stamp again');
  assert.equal(paused.session.state, 'awaiting_approval');
});

test('tool switches: a disabled tool is not offered, and never runs if called anyway', async t => {
  const { agent, fixture, calls } = await setup(t, { fixture: { plan: [{ name: 'stamp', args: { note: 'off' } }] } });
  await agent.tools.update({ name: 'stamp', enabled: false });
  const { session } = await agent.chat('[chat-only] stamp');
  assert.ok(!offered(completions(fixture)[0]).includes('stamp'));
  assert.ok(offered(completions(fixture)[0]).includes('readFile'));
  assert.deepEqual(calls, []);
  // The SDK refuses a call to a tool outside activeTools before approval or execution.
  const [refused] = toolParts(session, 'stamp');
  assert.equal(refused.state, 'output-error');
  assert.match(refused.errorText, /unavailable tool 'stamp'/);
  assert.equal((await agent.inspect()).toolDetails.find(detail => detail.name === 'stamp').enabled, false);

  await agent.tools.update({ name: 'stamp', enabled: true });
  await agent.chat('[chat-only] stamp now');
  assert.deepEqual(calls, ['off']);
});

test('tool switches over HTTP: PUT /api/tools', async t => {
  const { agent } = await setup(t, { config: { approval: ['stamp'] } });
  const server = await createHttpServer(agent);
  t.after(() => server.close());
  const put = body => fetch(`${server.url}/api/tools`, { method: 'PUT', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await put({ name: 'stamp', alwaysAllow: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { disabled: [], alwaysAllow: ['stamp'] });
  assert.equal((await put({ name: 'listFiles', alwaysAllow: true })).status, 400);
  const state = await (await fetch(`${server.url}/api/state`, { headers: { Authorization: `Bearer ${server.token}` } })).json();
  assert.deepEqual(state.toolSettings, { disabled: [], alwaysAllow: ['stamp'] });
});

test('parallel helpers: two runSubagent calls in one step run at the same time', async t => {
  const spans = [];
  const wait = tool({
    description: 'Wait briefly and report.',
    inputSchema: z.object({ label: z.string() }),
    execute: async ({ label }) => {
      const start = Date.now();
      await new Promise(resolve => setTimeout(resolve, 400));
      spans.push({ label, start, end: Date.now() });
      return { label };
    },
  });
  const plan = input => offered({ body: input }).includes('runSubagent')
    ? [[{ name: 'runSubagent', args: { agent: 'worker', task: 'a' } }, { name: 'runSubagent', args: { agent: 'worker', task: 'b' } }]]
    : [{ name: 'wait', args: { label: JSON.stringify(input.messages).includes('"a"') ? 'a' : 'b' } }];
  const { agent } = await setup(t, {
    fixture: { plan },
    config: { tools: { wait }, subagents: { worker: { description: 'Waits.', instructions: 'Call wait once.', tools: ['wait'] } } },
  });
  const { session } = await agent.chat('[chat-only] fan out');
  const results = toolParts(session, 'runSubagent');
  assert.equal(results.length, 2);
  assert.ok(results.every(part => part.state === 'output-available' && part.output.status === 'done'));
  assert.equal(spans.length, 2);
  const [first, second] = spans.sort((x, y) => x.start - y.start);
  assert.ok(second.start < first.end, `helpers overlapped (${second.start - first.start} ms apart)`);
});

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('attachments: an image reaches the model as data; history keeps only a reference', async t => {
  const { root, agent, fixture } = await setup(t, { fixture: { plan: [] }, config: { limits: { maxContextChars: 20_000 } } });
  await writeFile(path.join(root, 'data/plot.png'), Buffer.concat([PNG, Buffer.alloc(40_000)]));
  const run = await agent.runTask('[chat-only] describe the plot', { attachments: ['data/plot.png'] });
  assert.equal(run.execution, 'completed', 'inline bytes do not count against maxContextChars');
  assert.deepEqual(run.provenance.attachments.map(file => file.path), ['data/plot.png']);
  const [request] = completions(fixture);
  const user = request.body.messages.find(message => message.role === 'user');
  const image = user.content.find(part => part.type === 'image_url');
  assert.match(image.image_url.url, /^data:image\/png;base64,iVBOR/);
  const session = await agent.sessions.load(run.session.id);
  const stored = session.messages[0].parts.find(part => part.type === 'file');
  assert.deepEqual(stored, { type: 'file', mediaType: 'image/png', filename: 'plot.png', url: 'project:data/plot.png' });

  // A later turn re-reads the file; a removed file becomes a note instead of breaking the session.
  await rm(path.join(root, 'data/plot.png'));
  await agent.chat('[chat-only] again', { sessionId: run.session.id });
  const note = completions(fixture).at(-1).body.messages.find(message => message.role === 'user');
  assert.match(JSON.stringify(note.content), /Attachment data\/plot.png is unavailable/);

  await assert.rejects(agent.chat('x', { attachments: ['data/input.fasta'] }), /images or PDFs only/);
  await assert.rejects(agent.chat('x', { attachments: ['missing.png'] }), InputError);
  await writeFile(path.join(root, '.env.png'), PNG);
  await assert.rejects(agent.chat('x', { attachments: ['.env.png'] }), InputError, 'secrets stay unreadable');
  await assert.rejects(agent.chat('x', { attachments: Array.from({ length: 9 }, (_, index) => `${index}.png`) }), /at most 8/);
});

test('uploads accept images and PDFs by their leading bytes; HTTP chat forwards attachments', async t => {
  const { agent, fixture } = await setup(t, { fixture: { plan: [] } });
  const server = await createHttpServer(agent);
  t.after(() => server.close());
  const auth = { Authorization: `Bearer ${server.token}` };
  const upload = (name, body) => fetch(`${server.url}/api/uploads?name=${name}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body });
  const ok = await upload('plot.png', PNG);
  assert.equal(ok.status, 201);
  const { path: uploaded } = await ok.json();
  assert.equal((await upload('fake.png', Buffer.from('not an image'))).status, 400);
  assert.equal((await upload('paper.pdf', Buffer.from('%PDF-1.4\n%fixture\n'))).status, 201);

  const session = await agent.sessions.create();
  const response = await fetch(`${server.url}/api/chat`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, mode: 'chat', attachments: [uploaded], messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '[chat-only] look' }] }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  while ((await agent.inspect()).busy) await new Promise(resolve => setTimeout(resolve, 20));
  const user = completions(fixture)[0].body.messages.find(message => message.role === 'user');
  assert.ok(user.content.some(part => part.type === 'image_url'));
});

test('provenance records the host environment', async t => {
  const env = { ...process.env, CONDA_DEFAULT_ENV: 'bio-fixture' };
  const plain = await setup(t, { fixture: { plan: [] }, config: { env } });
  const run = await plain.agent.runTask('[chat-only] env');
  const environment = run.provenance.environment;
  assert.equal(environment.node, process.versions.node);
  assert.equal(environment.platform, process.platform);
  assert.equal(environment.python, undefined, 'no python config, no python probe');
  assert.equal(environment.conda, 'bio-fixture');

  const python = await setup(t, { fixture: { plan: [] }, config: { env, python: { scripts: {} } } });
  assert.match((await python.agent.runTask('[chat-only] env')).provenance.environment.python, /^Python 3\./);
  const broken = await setup(t, { fixture: { plan: [] }, config: { env, python: { command: 'definitely-not-python', scripts: {} } } });
  assert.equal((await broken.agent.runTask('[chat-only] env')).provenance.environment.python, 'unavailable');
});

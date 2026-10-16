import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, createRequestHandler, getExecutionContext, modelFromEnv } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=', 'base64');
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-files-'));
  const fixture = await startModelServer({ plan: [{ name: 'produce', args: {} }] });
  const model = modelFromEnv({ LAB_AGENT_MODEL: 'file-fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const agent = await createAgent({ root, model, tools: { produce: tool({ inputSchema: z.object({}), execute: async () => {
    const output = getExecutionContext().outputDirectory;
    await Promise.all([
      writeFile(path.join(output, 'result.csv'), 'name,description\r\n"a,b","line one\nline two"\r\n"quote","say ""hello"""\r\n'),
      writeFile(path.join(output, 'result.json'), '{"value":1,"unknown":null}'),
      writeFile(path.join(output, 'report.md'), '# Report\n\n<script>window.executed=true</script>'),
      writeFile(path.join(output, 'plot.png'), png),
      writeFile(path.join(output, 'bad.png'), '<script>unsafe</script>'),
      writeFile(path.join(output, 'large.txt'), 'a'.repeat(300_000)),
      writeFile(path.join(output, 'invalid-utf8.txt'), Buffer.alloc(256 * 1024, 255)),
      writeFile(path.join(output, 'unicode.json'), JSON.stringify({ source: '汉'.repeat(100_000) })),
      writeFile(path.join(output, 'report.html'), '<script>unsafe</script>'),
    ]);
    return { produced: true };
  } }) } });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:8888';
  const token = 'test-files-token-long-enough-for-workbench';
  const handler = createRequestHandler(agent, { origin, token, assets: root });
  const request = (url, init = {}) => handler(new Request(`${origin}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }));
  return { root, agent, fixture, request };
}

test('authenticated upload imports exact immutable bytes under unique confined names and model reads that input', async t => {
  const { root, agent, request } = await setup(t);
  const content = '>original id\nACDE\n';
  const response = await request('/api/uploads?name=sample.fasta', { method: 'POST', body: content });
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.match(file.path, /^data\/uploads\/[a-f0-9-]+-sample\.fasta$/);
  assert.equal(await readFile(path.join(root, file.path), 'utf8'), content);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const second = await (await request('/api/uploads?name=sample.fasta', { method: 'POST', body: 'second' })).json();
  assert.notEqual(file.path, second.path);
  assert.equal(await readFile(path.join(root, file.path), 'utf8'), content);
  const listing = await (await request('/api/uploads')).json();
  assert.equal(listing.files.length, 2);
  assert.equal(listing.maxBytes, 10 * 1024 * 1024);
  // Inspect the native file tool over the exact same workspace policy used by
  // model execution; no model request is required to read imported data here.
  assert.equal(await agent.native.tools.readFile.execute({ path: file.path }, { toolCallId: 'read-upload', messages: [] }), content);
  await assert.rejects(agent.native.tools.writeFile.execute({ path: file.path, content: 'changed' }, { toolCallId: 'write-upload', messages: [] }));
});

test('uploads reject traversal, unsupported/binary/empty/oversized data, foreign origin, missing token, and active task ownership', async t => {
  const { request, agent } = await setup(t);
  for (const name of ['../file.csv', 'data/file.csv', '.env', 'tool.py', 'report.html', 'report.svg', 'a..csv', `${'汉'.repeat(100)}.csv`]) {
    assert.equal((await request(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', body: 'data' })).status, 400, name);
  }
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: '' })).status, 400);
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: Buffer.from([65, 0, 66]) })).status, 400);
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: Buffer.alloc(10 * 1024 * 1024 + 1, 65) })).status, 400);
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: 'data', headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: 'data', headers: { authorization: '' } })).status, 403);
  const turn = await agent.streamTurn({ message: '[wait] Hold operation ownership.', mode: 'task' });
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: 'data' })).status, 409);
  turn.cancel(); await turn.completed; await turn.stream.cancel();
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: 'data' })).status, 201);
});

test('input destination symlinks never redirect import into host code', async t => {
  const { root, request } = await setup(t);
  await symlink(root, path.join(root, 'data'));
  assert.equal((await request('/api/uploads?name=file.csv', { method: 'POST', body: 'data' })).status, 500);
  await assert.rejects(readFile(path.join(root, 'file.csv')), { code: 'ENOENT' });
});

test('previews parse quoted CSV, format JSON, cap long text and identify raster images without rendering active formats', async t => {
  const { agent, request } = await setup(t);
  const run = await agent.runTask('Generate preview fixtures.');
  const preview = async name => {
    const response = await request(`/api/preview?runId=${run.id}&path=${encodeURIComponent(`output/${name}`)}`);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    return response.json();
  };
  const csv = await preview('result.csv');
  assert.deepEqual(csv.rows, [['name', 'description'], ['a,b', 'line one\nline two'], ['quote', 'say "hello"']]);
  assert.equal(csv.kind, 'csv');
  const json = await preview('result.json');
  assert.match(json.content, /\n  "value": 1/);
  assert.equal((await preview('report.md')).kind, 'markdown');
  assert.match((await preview('report.md')).content, /<script>/, 'Raw content travels only as JSON for safe UI text rendering.');
  const large = await preview('large.txt');
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.content) <= 256 * 1024);
  for (const name of ['invalid-utf8.txt', 'unicode.json']) {
    const text = await preview(name);
    assert.ok(Buffer.byteLength(text.content) <= 256 * 1024);
    assert.equal(text.truncated, true);
  }
  assert.equal((await preview('plot.png')).mediaType, 'image/png');
  for (const name of ['bad.png', 'report.html']) assert.equal((await request(`/api/preview?runId=${run.id}&path=output/${name}`)).status, 400);
  assert.equal((await request(`/api/preview?runId=${run.id}&path=../run.json`)).status, 404);
  const download = await request(`/api/artifact?runId=${run.id}&path=output/plot.png`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
});

test('artifact preview/download reject hardlinked or replaced symlink files', async t => {
  const { root, agent, request } = await setup(t);
  const run = await agent.runTask('Generate fixtures.');
  const file = path.join(run.directory, 'output/result.json');
  await writeFile(path.join(root, '.env'), 'SECRET_ONLY_FOR_HOST=secret');
  await rm(file); await link(path.join(root, '.env'), file);
  for (const route of ['preview', 'artifact']) assert.equal((await request(`/api/${route}?runId=${run.id}&path=output/result.json`)).status, 400);
  await rm(file); await symlink(path.join(root, '.env'), file);
  for (const route of ['preview', 'artifact']) assert.equal((await request(`/api/${route}?runId=${run.id}&path=output/result.json`)).status, 500);
});

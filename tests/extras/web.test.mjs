import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, modelFromEnv } from '../../packages/core/dist/index.js';
import { webTools, tavily, htmlToText } from '../../packages/extras/dist/web.js';
import { isPrivateAddress } from '../../packages/extras/dist/net.js';
import { startModelServer } from '../fixtures/model-server.mjs';

// lab-agent-extras/web against local HTTP fixtures. No real search provider or website is contacted.
const repository = fileURLToPath(new URL('../../', import.meta.url));

async function site(t, routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: '' });
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.at(-1).body = body;
      const route = routes[req.url.split('?')[0]];
      if (!route) { res.writeHead(404); res.end('missing'); return; }
      route(req, res, body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, requests };
}

const call = (tools, name, input) => tools[name].execute(tools[name].inputSchema.parse(input), { toolCallId: 'test', messages: [] });

const PAGE = `<!doctype html><html><head><title>Gene &amp; Protein</title><style>body{}</style><script>steal()</script></head>
<body><h1>BRCA1</h1><p>DNA repair&nbsp;protein. See <a href="https://example.org/brca1">the entry</a>.</p>
<ul><li>Chromosome 17</li><li>Tumor suppressor</li></ul><!-- hidden --></body></html>`;

test('private and reserved addresses are recognized', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
});

test('htmlToText keeps readable structure and drops scripts and styles', () => {
  const { title, text } = htmlToText(PAGE);
  assert.equal(title, 'Gene & Protein');
  assert.match(text, /# BRCA1/);
  assert.match(text, /DNA repair protein\. See the entry \(https:\/\/example\.org\/brca1\)\./);
  assert.match(text, /- Chromosome 17\n- Tumor suppressor/);
  assert.doesNotMatch(text, /steal|body\{\}|hidden/);
});

test('webFetch refuses loopback by default, including hostnames that resolve to it', async t => {
  const { port } = await site(t, { '/': (_req, res) => res.end('ok') });
  const tools = webTools({ search: false });
  assert.deepEqual(Object.keys(tools), ['webFetch']);
  await assert.rejects(call(tools, 'webFetch', { url: `http://127.0.0.1:${port}/` }), /private or reserved/);
  await assert.rejects(call(tools, 'webFetch', { url: `http://localhost:${port}/` }), /private or reserved/);
  await assert.rejects(call(tools, 'webFetch', { url: `http://[::1]:${port}/` }), /private or reserved/);
  await assert.rejects(call(tools, 'webFetch', { url: 'file:///etc/passwd' }), /Only http and https/);
  await assert.rejects(call(tools, 'webFetch', { url: `http://user:pw@example.org/` }), /embedded credentials/);
});

test('webFetch reads HTML, gzip, JSON, pages long text and refuses binary types', async t => {
  const long = 'x'.repeat(2500);
  const { base } = await site(t, {
    '/page': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); },
    '/gz': (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(gzipSync('compressed text')); },
    '/data.json': (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"gene":"TP53"}'); },
    '/long': (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(long); },
    '/big': (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('y'.repeat(5000)); },
    '/hop': (_req, res) => { res.writeHead(302, { location: '/page' }); res.end(); },
    '/loop': (_req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
    '/file.pdf': (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.4'); },
    '/gone': (_req, res) => { res.writeHead(410); res.end('gone'); },
  });
  const tools = webTools({ search: false, allowPrivate: true, maxChars: 1000, maxFetchBytes: 4000 });
  const page = await call(tools, 'webFetch', { url: `${base}/page` });
  assert.equal(page.title, 'Gene & Protein');
  assert.match(page.text, /Tumor suppressor/);
  assert.equal(page.nextOffset, undefined);
  assert.equal((await call(tools, 'webFetch', { url: `${base}/gz` })).text, 'compressed text');
  assert.equal((await call(tools, 'webFetch', { url: `${base}/data.json` })).text, '{"gene":"TP53"}');

  const first = await call(tools, 'webFetch', { url: `${base}/long` });
  assert.equal(first.text.length, 1000);
  assert.equal(first.totalChars, 2500);
  assert.equal(first.nextOffset, 1000);
  assert.equal((await call(tools, 'webFetch', { url: `${base}/long`, offset: 2000 })).text.length, 500);

  const big = await call(tools, 'webFetch', { url: `${base}/big` });
  assert.equal(big.totalChars, 4000);
  assert.match(big.note, /larger than the fetch limit/);

  assert.equal((await call(tools, 'webFetch', { url: `${base}/hop` })).url, `${base}/page`);
  await assert.rejects(call(tools, 'webFetch', { url: `${base}/loop` }), /Too many redirects/);
  await assert.rejects(call(tools, 'webFetch', { url: `${base}/file.pdf` }), /only text pages can be read/);
  await assert.rejects(call(tools, 'webFetch', { url: `${base}/gone` }), /HTTP 410/);
});

test('every redirect hop is checked again', async t => {
  // A public→private redirect needs a public first hop, which a local fixture cannot provide.
  // The same per-hop loop is exercised here with targets that fail the protocol and credential checks.
  const { base } = await site(t, {
    '/to-file': (_req, res) => { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); },
    '/to-creds': (_req, res) => { res.writeHead(302, { location: 'http://user:pw@example.org/' }); res.end(); },
  });
  const tools = webTools({ search: false, allowPrivate: true });
  await assert.rejects(call(tools, 'webFetch', { url: `${base}/to-file` }), /Only http and https/);
  await assert.rejects(call(tools, 'webFetch', { url: `${base}/to-creds` }), /embedded credentials/);
});

test('webSearch through Tavily: key from env, request shape, results, errors', async t => {
  const { base, requests } = await site(t, {
    '/search': (_req, res, body) => {
      const { query } = JSON.parse(body);
      if (query === 'fail') { res.writeHead(401); res.end('bad key'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'TP53 - Wikipedia', url: 'https://en.wikipedia.org/wiki/P53', content: 'Tumor protein p53', published_date: '2024-01-01' }, { title: 'no url' }] }));
    },
  });
  const tools = webTools({ search: tavily({ baseUrl: base, env: { TAVILY_API_KEY: 'fixture-key' } }) });
  assert.deepEqual(Object.keys(tools).sort(), ['webFetch', 'webSearch']);
  const result = await call(tools, 'webSearch', { query: 'TP53 function' });
  assert.deepEqual(result, { provider: 'tavily', query: 'TP53 function', results: [{ title: 'TP53 - Wikipedia', url: 'https://en.wikipedia.org/wiki/P53', snippet: 'Tumor protein p53', publishedDate: '2024-01-01' }] });
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-key');
  assert.deepEqual(JSON.parse(requests[0].body), { query: 'TP53 function', max_results: 5, search_depth: 'basic' });
  await assert.rejects(call(tools, 'webSearch', { query: 'fail' }), /Tavily search failed: 401/);
  const keyless = webTools({ search: tavily({ baseUrl: base, env: {} }) });
  await assert.rejects(call(keyless, 'webSearch', { query: 'x' }), /TAVILY_API_KEY/);
});

test('web tools run inside a Core agent turn', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-web-'));
  await cp(path.join(repository, 'examples/sequence-summary'), root, { recursive: true, filter: source => !/(?:^|\/)(?:runs|\.lab-agent|__pycache__)(?:\/|$)/.test(source) });
  const { base } = await site(t, { '/page': (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); } });
  const fixture = await startModelServer({ plan: [{ name: 'webFetch', args: { url: `${base}/page` } }] });
  const model = modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const agent = await createAgent({ root, model, tools: webTools({ search: false, allowPrivate: true }) });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const { session } = await agent.chat('[chat-only] read the page');
  const part = session.messages.flatMap(message => message.parts).find(item => item.type === 'tool-webFetch');
  assert.equal(part.state, 'output-available');
  assert.match(part.output.text, /BRCA1/);
});

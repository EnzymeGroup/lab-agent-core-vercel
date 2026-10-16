import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

test('official terminal UI uses shared HTTP session path in a real pseudo-terminal', { skip: process.platform === 'win32' }, async t => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-tui-'));
  const fixture = await startModelServer({ plan: [] });
  t.after(async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); });
  await cp(path.join(repository, 'examples/sequence-summary'), root, { recursive: true, filter: source => !/(?:^|\/)(?:runs|\.lab-agent)(?:\/|$)/.test(source) });
  const config = path.join(root, 'agent.config.ts');
  await writeFile(config, (await readFile(config, 'utf8')).replace("'lab-agent-core-vercel'", JSON.stringify(pathToFileURL(path.join(repository, 'packages/core/dist/index.js')).href)));
  const result = await runCommand('python3', [path.join(repository, 'scripts/tui-smoke.py'), process.execPath, path.join(repository, 'packages/core/dist/cli.js'), 'chat', '--root', root], {
    cwd: repository, timeoutMs: 20_000, env: { LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'deterministic-demo', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url },
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).completed, true);
  assert.equal(fixture.requests.length, 1);
  const [name] = await readdir(path.join(root, '.lab-agent/sessions'));
  const session = JSON.parse(await readFile(path.join(root, '.lab-agent/sessions', name), 'utf8'));
  assert.equal(session.state, 'idle'); assert.equal(session.messages[0].role, 'user'); assert.equal(session.messages.at(-1).role, 'assistant');
  assert.ok(session.messages.at(-1).parts.some(part => part.type === 'text' && part.text.includes('Deterministic demo finished')));
});

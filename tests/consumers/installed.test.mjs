import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelServer } from '../fixtures/model-server.mjs';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../..', import.meta.url));
async function command(file, args, options) {
  try { return { ...(await exec(file, args, { maxBuffer: 8_000_000, ...options })), code: 0 }; }
  catch (error) { return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }; }
}

test('npm-packed package runs two Python applications outside the repository', { timeout: 180_000 }, async t => {
  const external = await mkdtemp(path.join(tmpdir(), 'lab-agent-consumer-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const fixture = await startModelServer();
  t.after(() => fixture.close());
  const packed = await command('npm', ['pack', '--workspace', 'lab-agent-core-vercel', '--json', '--pack-destination', external], { cwd: repository });
  assert.equal(packed.code, 0, packed.stderr);
  const packageInfo = JSON.parse(packed.stdout)[0];
  const tarball = path.join(external, packageInfo.filename);
  await writeFile(path.join(external, 'package.json'), JSON.stringify({ name: 'isolated-lab-agent-consumer', private: true, type: 'module' }));
  const installed = await command('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: external });
  assert.equal(installed.code, 0, installed.stderr);
  const modulePath = path.join(external, 'node_modules/lab-agent-core-vercel');
  assert.equal((await lstat(modulePath)).isSymbolicLink(), false);
  assert.ok(!(await realpath(modulePath)).startsWith(repository));
  const bin = path.join(external, 'node_modules/.bin/lab-agent');
  const env = { ...process.env, LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'deterministic-demo', LAB_AGENT_API_KEY: 'local-fixture-only', LAB_AGENT_BASE_URL: fixture.url, LAB_AGENT_CLI: bin };
  const projects = [];
  for (const name of ['sequence-summary', 'table-quality']) {
    const project = path.join(external, name);
    projects.push(project);
    await cp(path.join(repository, 'examples', name), project, { recursive: true,
      filter: file => !/(?:^|\/)(?:runs|\.lab-agent|node_modules|__pycache__)(?:\/|$)/u.test(file) });
    const result = await command('python3', ['workflows/run.py'], { cwd: project, env });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const run = JSON.parse(result.stdout);
    assert.equal(run.execution, 'completed');
    assert.equal(run.delivery, 'passed');
    assert.equal(run.artifacts.length, 2);
    const inspected = await command(bin, ['inspect', '--root', project, '--json'], { cwd: external, env });
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.match(inspected.stdout, /runPython/);
    assert.match(inspected.stdout, new RegExp(name));
    const sessions = await command(bin, ['sessions', '--root', project, '--json'], { cwd: external, env });
    assert.equal(sessions.code, 0, sessions.stderr);
    assert.match(sessions.stdout, new RegExp(run.session.id));
    const artifact = path.join(run.directory, 'output', name === 'sequence-summary' ? 'summary.json' : 'profile.json');
    const data = JSON.parse(await readFile(artifact, 'utf8'));
    if (data.records) data.records[0].length += 99;
    else data.row_count += 99;
    await writeFile(artifact, JSON.stringify(data));
    const checked = await command(bin, ['check', run.id, '--root', project, '--json'], { cwd: external, env });
    assert.equal(checked.code, 1, checked.stderr || checked.stdout);
    assert.equal(JSON.parse(checked.stdout).delivery, 'failed');
  }
  // Import, session continuation and static UI all resolve through the install.
  await cp(path.join(repository, 'examples/advanced'), path.join(external, 'advanced'), { recursive: true });
  await writeFile(path.join(external, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { createAgent, loadAgentConfig, createHttpServer } from 'lab-agent-core-vercel';
    import { delegatedAnswer } from './advanced/delegation.ts';
    import { analyzeThenReview } from './advanced/two-agent-workflow.ts';
    const delegated = await delegatedAnswer('[tool:review] Review the proposed analysis.');
    assert.ok(delegated.text);
    const composed = await analyzeThenReview('Describe source-data limitations.');
    assert.ok(composed.analysis && composed.review);
    await assert.rejects(analyzeThenReview('Abort before any inference', AbortSignal.abort()));
    const agent = await createAgent(await loadAgentConfig(process.argv[2]));
    const { sessions: existing } = await agent.sessions.list();
    assert.ok(existing.length);
    const id = existing[0].id;
    const before = await agent.sessions.load(id);
    await agent.chat('[chat-only] Continue the existing session.', { sessionId: id });
    const after = await agent.sessions.load(id);
    assert.ok(after.messages.length > before.messages.length);
    assert.ok(JSON.stringify(after.messages).includes('runPython'));
    const server = await createHttpServer(agent, { port: 0 });
    try {
      const page = await fetch(server.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/);
      const bootstrap = await fetch(new URL('/api/bootstrap', server.url));
      assert.equal(bootstrap.status, 200);
      const { token } = await bootstrap.json();
      const state = await fetch(new URL('/api/state', server.url), { headers: { authorization: 'Bearer ' + token } });
      assert.equal(state.status, 200);
      assert.ok((await state.json()).sessions.length);
    } finally { await server.close(); await agent.close(); }
  `);
  const verified = await command('node', ['verify.mjs', projects[0]], { cwd: external, env });
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  assert.ok(fixture.requests.some(request => request.body?.stream));
  assert.ok(fixture.requests.some(request => request.body?.messages?.some(message => message.role === 'tool')));
  await mkdir(path.join(external, 'scaffold-parent'));
  const scaffold = path.join(external, 'scaffold-parent/my-agent');
  const initialized = await command(bin, ['init', scaffold], { cwd: external, env });
  assert.equal(initialized.code, 0, initialized.stderr);
  await readFile(path.join(scaffold, '.agents/skills/sequence-summary/SKILL.md'), 'utf8');
  assert.ok(packageInfo.files.some(file => file.path === 'workbench/index.html'));
  assert.ok(packageInfo.files.some(file => file.path === 'templates/python/agent.config.ts'));
  assert.ok(packageInfo.files.some(file => file.path === 'docs/GUIDE.md'));
});

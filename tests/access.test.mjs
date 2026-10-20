import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, createWorkspace, createTools, discoverSkills, loadSkill, runWithExecutionContext } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';
import { fixtureModel } from './fixtures/project.mjs';

const options = { toolCallId: 'access-test', messages: [], context: {} };
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, file, text = 'fixture') {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
const task = (root, callback, extra = {}) => runWithExecutionContext({ runId: 'current', outputDirectory: path.join(root, 'runs/current/output'), ...extra }, callback);

test('analysis read/list hides sensitive files, Core evidence and canonical aliases', async t => {
  const root = await temporary(t);
  const denied = ['.env', '.env.local', '.env.example', '.envrc', 'production.env', '.lab-agent/sessions/private.json', '.git/config', 'keys/service.pem', 'id_rsa', 'credentials.json', 'private-key.txt', 'runs/old/run.json', 'runs/old/checks/check.json'];
  for (const file of denied) await put(root, file, `secret ${file}`);
  await put(root, 'data/measured.csv', 'x,y\n1,2\n');
  await put(root, 'runs/old/output/report.txt', 'previous public result');
  await symlink(path.join(root, '.env.local'), path.join(root, 'innocent.txt'));
  await symlink(path.join(root, '.git'), path.join(root, 'repository-alias'));
  await symlink(path.join(root, '.lab-agent'), path.join(root, 'session-alias'));
  await link(path.join(root, '.env'), path.join(root, 'hardlink-alias.txt'));
  const workspace = await createWorkspace(root);
  for (const file of [...denied, 'innocent.txt', 'repository-alias/config', 'session-alias/sessions/private.json', 'hardlink-alias.txt']) {
    await assert.rejects(workspace.read(file), /sensitive|metadata|hard-linked/i, file);
  }
  assert.deepEqual((await workspace.list('.')).map(entry => entry.name), ['data', 'runs']);
  assert.deepEqual((await workspace.list('runs/old')).map(entry => entry.name), ['output']);
  assert.equal(await workspace.read('runs/old/output/report.txt'), 'previous public result');
  assert.equal(await workspace.read('data/measured.csv'), 'x,y\n1,2\n');
  assert.equal(await workspace.resolve('.env', { internal: true }), path.join(root, '.env'));
  await assert.rejects(workspace.resolve('../outside', { internal: true }), /escapes/);
});

test('readRoots scopes files and list navigation using both configured and canonical paths', async t => {
  const root = await temporary(t);
  await put(root, 'data/allowed.csv', 'measured');
  await put(root, 'data/other.csv', 'other');
  await put(root, 'src/source.py', 'source');
  await symlink(path.join(root, 'src'), path.join(root, 'data/source-alias'));
  await symlink(path.join(root, 'data'), path.join(root, 'outside-alias'));
  const workspace = await createWorkspace(root, { readRoots: ['data/allowed.csv'] });
  assert.deepEqual((await workspace.list()).map(entry => entry.name), ['data']);
  assert.deepEqual((await workspace.list('data')).map(entry => entry.name), ['allowed.csv']);
  assert.equal(await workspace.read('data/allowed.csv'), 'measured');
  for (const file of ['data/other.csv', 'src/source.py', 'data/source-alias/source.py', 'outside-alias/allowed.csv']) {
    await assert.rejects(workspace.read(file), /readRoots/);
  }
  await assert.rejects(workspace.list('src'), /readRoots/);
  assert.deepEqual(await (await createWorkspace(root, { readRoots: [] })).list(), []);
  const aliasedRoot = await createWorkspace(root, { readRoots: ['outside-alias'] });
  assert.equal(await aliasedRoot.read('outside-alias/allowed.csv'), 'measured');
  await assert.rejects(aliasedRoot.read('data/allowed.csv'), /readRoots/);
});

test('analysis writes require the exact active task output and protect inputs, checker and history', async t => {
  const root = await temporary(t);
  const workspace = await createWorkspace(root);
  await put(root, 'data/input.csv', 'original input');
  await put(root, 'scripts/check.py', 'original checker');
  await put(root, 'runs/old/output/result.txt', 'original history');
  await assert.rejects(workspace.write('runs/current/output/report.txt', 'no task'), /active task/);
  await runWithExecutionContext({ runId: 'current' }, async () => {
    await assert.rejects(workspace.write('runs/current/output/report.txt', 'no output context'), /active task/);
  });
  await task(root, async () => {
    await workspace.write('runs/current/output/nested/report.txt', 'current result');
    for (const file of ['data/input.csv', 'scripts/check.py', 'runs/old/output/result.txt', 'runs/current/run.json', '.lab-agent/operation.lock']) {
      await assert.rejects(workspace.write(file, 'changed'), /denied|metadata|current.*output|sensitive/i, file);
    }
  });
  await task(root, async () => {
    await assert.rejects(workspace.write('runs/old/output/result.txt', 'forged context'), /exact run output/);
  }, { outputDirectory: path.join(root, 'runs/old/output') });
  assert.equal(await readFile(path.join(root, 'data/input.csv'), 'utf8'), 'original input');
  assert.equal(await readFile(path.join(root, 'scripts/check.py'), 'utf8'), 'original checker');
  assert.equal(await readFile(path.join(root, 'runs/old/output/result.txt'), 'utf8'), 'original history');
  assert.equal(await workspace.read('runs/current/output/nested/report.txt'), 'current result');
});

test('output directory symlink redirection does not grant current-task write authority', async t => {
  const root = await temporary(t);
  await put(root, 'runs/old/output/result.txt', 'history');
  await mkdir(path.join(root, 'runs/current'));
  await symlink(path.join(root, 'runs/old/output'), path.join(root, 'runs/current/output'));
  const workspace = await createWorkspace(root);
  await task(root, async () => {
    await assert.rejects(workspace.write('runs/current/output/result.txt', 'corrupt'), /exact run output/);
  });
  assert.equal(await readFile(path.join(root, 'runs/old/output/result.txt'), 'utf8'), 'history');
});

test('development permits explicit edit roots during tasks while protecting historical outputs', async t => {
  const root = await temporary(t);
  await put(root, 'src/module.py', 'before');
  await put(root, 'data/input.csv', 'data');
  await put(root, 'runs/old/output/result.txt', 'history');
  const workspace = await createWorkspace(root, { mode: 'development', writeRoots: ['src'] });
  await assert.rejects(workspace.write('src/module.py', 'chat edit'), /active task/);
  await task(root, async () => {
    await workspace.write('src/module.py', 'approved development edit');
    await workspace.write('runs/current/output/report.txt', 'deliverable');
    await assert.rejects(workspace.write('data/input.csv', 'changed'), /Write denied/);
  });
  assert.equal(await workspace.read('src/module.py'), 'approved development edit');
  const broad = await createWorkspace(root, { mode: 'development', writeRoots: ['.'] });
  await task(root, async () => {
    await assert.rejects(broad.write('runs/old/output/result.txt', 'changed'), /current.*output/);
    await assert.rejects(broad.write('.env', 'secret'), /Sensitive/);
    await assert.rejects(broad.write('runs/current/check.json', '{}'), /metadata/);
  });
  const noRoots = await createWorkspace(root, { mode: 'development' });
  await task(root, () => assert.rejects(noRoots.write('src/new.py', 'no implicit root'), /Write denied/));
});

test('registered Skill lookup bypasses readRoots while retaining sensitive and hardlink denial', async t => {
  const root = await temporary(t);
  const body = '---\nname: evidence\ndescription: Inspect measured data.\n---\nFull registered instructions.';
  await put(root, '.agents/skills/evidence/SKILL.md', body);
  await put(root, '.env', 'hidden credential');
  const workspace = await createWorkspace(root, { readRoots: ['data'] });
  const skills = await discoverSkills(workspace);
  assert.equal(skills.length, 1);
  await assert.rejects(workspace.read(skills[0].path), /readRoots/);
  assert.ok((await loadSkill(workspace, skills, 'evidence')).endsWith(body));
  await assert.rejects(loadSkill(workspace, [{ name: 'forged', description: 'forged', path: '.env' }], 'forged'), /Sensitive/);
  await link(path.join(root, '.env'), path.join(root, '.agents/skills/evidence/SKILL-alias.md'));
  await assert.rejects(loadSkill(workspace, [{ name: 'alias', description: 'alias', path: '.agents/skills/evidence/SKILL-alias.md' }], 'alias'), /Hard-linked/);
});

test('model tools expose no policy bypass and registered Python receives isolated project env', async t => {
  const root = await temporary(t);
  await put(root, 'scripts/read_env.py', 'import os,json\nprint(json.dumps({"value":os.getenv("LAB_PROJECT_ISOLATED"),"root":os.getenv("AGENT_ROOT")}))\n');
  await put(root, '.env', 'secret');
  const workspace = await createWorkspace(root, { readRoots: ['data'] });
  const tools = createTools(workspace, { root, model: 'openai:fixture', env: { LAB_PROJECT_ISOLATED: 'project-value', AGENT_ROOT: 'forged' }, python: { scripts: { env: { path: 'scripts/read_env.py', description: 'Trusted env probe' } } } });
  await assert.rejects(tools.readFile.execute({ path: '.env', internal: true }, options), /Sensitive/);
  await assert.rejects(tools.writeFile.execute({ path: 'data/changed.csv', content: 'change' }, options), /active task/);
  const result = await tools.runPython.execute({ script: 'env', args: [] }, options);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { value: 'project-value', root });
  assert.equal(process.env.LAB_PROJECT_ISOLATED, undefined);
});

test('noncooperative native tool cancellation retains ownership until its actual settlement', { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-native-cancel-'));
  const fixture = await startModelServer({ plan: [{ name: 'noncooperative', args: {} }] });
  let release;
  let markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const watchdog = setTimeout(() => release(), 2000);
  let agent;
  let turn;
  try {
    agent = await createAgent({ root,
      model: fixtureModel(fixture.url, 'native-cancel-fixture'),
      tools: { noncooperative: tool({ inputSchema: z.object({}), execute: async () => { markStarted(); await gate; await put(root, 'native-settled.txt', 'settled'); return 'finished'; } }) },
    });
    turn = await agent.streamTurn({ message: 'Run the bounded noncooperative native tool.', mode: 'task' });
    await started;
    let completed = false;
    void turn.completed.then(() => { completed = true; });
    turn.cancel();
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(completed, false, 'Cancellation must not falsely complete while trusted tool code is still running.');
    assert.ok(await readFile(path.join(root, '.lab-agent/operation.lock'), 'utf8'));
    assert.equal((await agent.inspect()).busy, true);
    await assert.rejects(agent.runTask('A second operation must wait.'), /using this project|in use|operation/i);
    release();
    const result = await turn.completed;
    assert.equal(result.run.execution, 'aborted');
    assert.equal(await readFile(path.join(root, 'native-settled.txt'), 'utf8'), 'settled');
    await assert.rejects(readFile(path.join(root, '.lab-agent/operation.lock')), { code: 'ENOENT' });
  } finally {
    release(); clearTimeout(watchdog);
    if (turn) { await turn.completed.catch(() => {}); await turn.stream.cancel(); }
    await agent?.close(); await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent, createRunStore, createRequestHandler, modelFromEnv, checkRun, runCommand } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

async function setup(t, extra = {}, fixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-review-'));
  const fixture = await startModelServer({ plan: [], text: 'Complete native response.', ...fixtureOptions });
  t.after(async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const model = modelFromEnv({ LAB_AGENT_MODEL: 'review-fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const config = { root, model, ...extra };
  return { root, fixture, config };
}

test('caller cancellation during asynchronous acceptance reaches the native SDK', async t => {
  const { config, fixture } = await setup(t);
  const agent = await createAgent(config);
  t.after(() => agent.close());
  const controller = new AbortController();
  const accepted = agent.streamTurn({ message: 'Do not perform work after cancellation.', mode: 'task', signal: controller.signal });
  controller.abort(new DOMException('Caller canceled during acceptance.', 'AbortError'));
  let turn;
  try { turn = await accepted; }
  catch (error) { assert.match(error.message, /cancel|abort/i); return; }
  const result = await turn.completed;
  await turn.stream.cancel();
  assert.equal(result.run.execution, 'aborted');
  assert.equal(fixture.requests.length, 0, 'No model request may start after the caller was already canceled.');
});

test('invalid checker report filesystem type persists failed delivery after a previously passed check', async t => {
  const { config, fixture } = await setup(t, {
    validation: { command: [process.execPath, '-e', 'require("node:fs").mkdirSync(process.env.AGENT_CHECK_FILE)'] },
  });
  const store = createRunStore(config);
  const run = await store.create('Existing measured task', 'test-session');
  run.execution = 'completed';
  run.delivery = 'passed';
  await store.save(run);
  const checked = await checkRun(config, run.id);
  assert.equal(checked.delivery, 'failed');
  assert.equal((await store.load(run.id)).delivery, 'failed');
  assert.equal((await store.report(run.id)).status, 'failed');
  await assert.rejects(readFile(path.join(config.root, '.lab-agent/operation.lock')), { code: 'ENOENT' });
  assert.equal(fixture.requests.length, 0, 'Independent delivery checks must not make model requests.');
});

test('client reader cancellation preserves independently persisted accepted execution', async t => {
  const { config } = await setup(t);
  const agent = await createAgent(config);
  t.after(() => agent.close());
  const turn = await agent.streamTurn({ message: 'Complete after UI disconnect.', mode: 'task' });
  const canceledReader = turn.stream.cancel();
  const result = await turn.completed;
  await canceledReader;
  assert.equal(result.run.execution, 'completed');
  assert.equal(result.session.state, 'idle');
  const stored = await agent.sessions.load(turn.sessionId);
  assert.ok(stored.messages.some(message => message.role === 'assistant' && message.parts.some(part => part.type === 'text' && part.text.includes('Complete native response.'))));
});

test('invalid FIFO checker report cannot hang delivery after its subprocess exits', { skip: process.platform === 'win32' }, async t => {
  const { config } = await setup(t);
  const store = createRunStore(config);
  const run = await store.create('FIFO report regression', 'test-session');
  run.execution = 'completed';
  await store.save(run);
  const moduleURL = new URL('../packages/core/dist/index.js', import.meta.url).href;
  const script = `
    import { checkRun } from ${JSON.stringify(moduleURL)};
    const config = { root: process.argv[1], model: 'openai:no-inference', validation: { command: [process.execPath, '-e', 'require("node:child_process").execFileSync("mkfifo",[process.env.AGENT_CHECK_FILE])'] } };
    const run = await checkRun(config, process.argv[2]);
    console.log(JSON.stringify({ delivery: run.delivery }));
  `;
  const result = await runCommand(process.execPath, ['--input-type=module', '-e', script, config.root, run.id], { cwd: config.root, timeoutMs: 3000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).delivery, 'failed');
});

test('checker report ceiling counts UTF-8 bytes before accepting a valid JSON report', async t => {
  const { config } = await setup(t, {
    validation: { command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.AGENT_CHECK_FILE,JSON.stringify({status:"passed",checks:[],issues:["汉".repeat(400000)]}))'] },
  });
  const store = createRunStore(config);
  const run = await store.create('Oversized report regression', 'test-session');
  run.execution = 'completed';
  await store.save(run);
  const checked = await checkRun(config, run.id);
  assert.equal(checked.delivery, 'failed');
  assert.match((await store.report(run.id)).issues.join(' '), /MiB|bytes|exceed/i);
});

test('stale lock reclamation cannot unlink another contender’s newly acquired lock', async t => {
  const { config } = await setup(t);
  const moduleURL = new URL('../packages/core/dist/storage.js', import.meta.url).href;
  // Pause only one real unlink to deterministically exercise a valid concurrent
  // schedule. A second acquisition still runs the actual filesystem algorithm.
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {hostname} from 'node:os';
    import {join} from 'node:path';
    import {acquireOperation,BusyError} from ${JSON.stringify(moduleURL)};
    const root=process.argv[1];
    const lock=join(root,'.lab-agent/operation.lock');
    await fs.mkdir(join(root,'.lab-agent'),{recursive:true});
    await fs.writeFile(lock,JSON.stringify({id:'dead-owner-for-review',pid:1073741823,host:hostname(),startedAt:new Date().toISOString()}));
    const original=fs.rm;
    let resume,reached;
    const wait=new Promise(resolve=>resume=resolve);
    const paused=new Promise(resolve=>reached=resolve);
    let firstUnlink=true;
    fs.rm=async function(file,...args){if(file===lock&&firstUnlink){firstUnlink=false;reached();await wait;}return original(file,...args)};
    syncBuiltinESMExports();
    let firstRelease,secondRelease;
    try {
      const first=acquireOperation(root);
      await paused;
      try {secondRelease=await acquireOperation(root)} catch(error) {assert.ok(error instanceof BusyError,error.message)}
      resume();
      try {firstRelease=await first} catch(error) {assert.ok(error instanceof BusyError,error.message)}
      console.log(JSON.stringify({acquisitions:Number(Boolean(firstRelease))+Number(Boolean(secondRelease))}));
    } finally {
      resume();
      if(firstRelease)await firstRelease();if(secondRelease)await secondRelease();
      fs.rm=original;syncBuiltinESMExports();
    }
  `;
  const result = await runCommand(process.execPath, ['--input-type=module', '-e', script, config.root], { cwd: config.root, timeoutMs: 3000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).acquisitions, 1, 'Exactly one contender may own the project operation lock.');
});

test('artifact integrity failure during recheck clears previously passed delivery', async t => {
  const { config } = await setup(t, {
    validation: { command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.AGENT_CHECK_FILE,JSON.stringify({status:"passed",checks:[],issues:[]}))'] },
  });
  const store = createRunStore(config);
  const run = await store.create('Existing passed output', 'test-session');
  run.execution = 'completed';
  run.delivery = 'passed';
  await store.save(run);
  await symlink(config.root, path.join(run.directory, 'output/unsafe-link'));
  const checked = await checkRun(config, run.id);
  assert.equal(checked.delivery, 'failed');
  assert.equal((await store.load(run.id)).delivery, 'failed');
  assert.match((await store.report(run.id)).issues.join(' '), /symlink/i);
});

async function slowCheck(t) {
  const context = await setup(t, {
    validation: { command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.AGENT_RUN_DIR+"/checker-started","yes");process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], timeoutMs: 2500 },
  });
  const store = createRunStore(context.config);
  const run = await store.create('Cancel independent delivery check', 'test-session');
  run.execution = 'completed';
  await store.save(run);
  const agent = await createAgent(context.config);
  const checking = agent.runs.check(run.id);
  t.after(async () => { await agent.close(); await checking.catch(() => {}); });
  const deadline = Date.now() + 1000;
  for (;;) {
    try { await readFile(path.join(run.directory, 'checker-started')); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return { ...context, agent, checking, run };
}

test('explicit cancellation also reaches an independent recheck subprocess', async t => {
  const { agent, checking, run } = await slowCheck(t);
  assert.equal(agent.cancel(), true);
  assert.equal((await checking).delivery, 'failed');
  assert.match((await agent.runs.report(run.id)).issues.join(' '), /cancel/i);
});

test('closing during an independent check waits for subprocess cleanup and lock release', async t => {
  const { config, agent, checking } = await slowCheck(t);
  await agent.close();
  await assert.rejects(readFile(path.join(config.root, '.lab-agent/operation.lock')), { code: 'ENOENT' });
  assert.equal((await checking).delivery, 'failed');
});

test('aborted task keeps its operation lock until registered Python has finished process cleanup', async t => {
  const { config } = await setup(t, {
    python: { scripts: { slow: { path: 'slow.py', description: 'Slow cleanup regression' } } },
  }, { plan: [{ name: 'runPython', args: { script: 'slow', args: [] } }] });
  await writeFile(path.join(config.root, 'slow.py'), 'import signal,time,os\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nPath("python-started").write_text(str(os.getpid()))\nwhile True: time.sleep(0.01)\n');
  const agent = await createAgent(config);
  t.after(() => agent.close());
  const turn = await agent.streamTurn({ message: 'Execute registered slow cleanup script.', mode: 'task' });
  let pid;
  const deadline = Date.now() + 1500;
  for (;;) {
    try { pid = Number(await readFile(path.join(config.root, 'python-started'), 'utf8')); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  turn.cancel();
  const result = await turn.completed;
  await turn.stream.cancel();
  assert.equal(result.run.execution, 'aborted');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Registered process must be gone when task completion releases the project lock.');
  await assert.rejects(readFile(path.join(config.root, '.lab-agent/operation.lock')), { code: 'ENOENT' });
});

test('HTTP reports persistent storage execution failures as server errors', async t => {
  const { config } = await setup(t);
  const agent = await createAgent(config);
  t.after(() => agent.close());
  await writeFile(path.join(config.root, '.lab-agent/operation.lock'), 'invalid persisted lock JSON');
  const origin = 'http://127.0.0.1:8787';
  const token = 'local-review-token-with-enough-characters';
  const handler = createRequestHandler(agent, { origin, token, assets: config.root });
  const response = await handler(new Request(`${origin}/api/state`, { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 500, 'Corrupt server-owned metadata is an execution/configuration failure.');
  assert.equal(typeof (await response.json()).error.message, 'string');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkRun, createAgent, createRunStore } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';
import { copyExample, fixtureModel } from './fixtures/project.mjs';

async function setup(t, extra = {}) {
  const root = await copyExample('lab-provenance-');
  const fixture = await startModelServer();
  const model = fixtureModel(fixture.url, 'provenance-fixture');
  const config = { root, model, python: { scripts: { summarize: { path: 'tools/summarize.py', description: 'Summarize FASTA' } } },
    validation: { command: ['python3', 'tools/validate.py'] }, ...extra };
  const agent = await createAgent(config);
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  return { root, fixture, agent, config };
}

test('versioned runs preserve first artifact hashes and original delivery across tampering and repeated rechecks', async t => {
  const { agent, fixture } = await setup(t);
  const run = await agent.runTask('Summarize the input FASTA.');
  assert.equal(run.schemaVersion, 2);
  assert.equal(run.provenance.coreVersion, '0.1.0-rc.3');
  assert.match(run.provenance.aiSdkVersion, /^7\./);
  assert.equal(run.provenance.inputs[0].path, 'data/input.fasta');
  assert.ok(run.provenance.code.some(file => file.path === 'tools/validate.py'));
  assert.equal(run.provenance.artifacts.length, 2);
  assert.equal(run.originalDelivery.delivery, 'passed');
  assert.equal(run.originalDelivery.kind, 'initial');
  const evidence = path.join(run.directory, run.originalDelivery.report);
  const initial = await readFile(evidence, 'utf8');
  const baseline = JSON.stringify(run.provenance);
  const original = JSON.stringify(run.originalDelivery);
  const artifact = path.join(run.directory, 'output/summary.json');
  const data = await readFile(artifact, 'utf8');
  await writeFile(artifact, '{}');
  const requests = fixture.requests.length;
  const changed = await agent.runs.check(run.id);
  assert.equal(changed.delivery, 'failed');
  assert.deepEqual(changed.checks.at(-1).artifactChanges, ['output/summary.json']);
  assert.equal(JSON.stringify(changed.originalDelivery), original);
  assert.equal(JSON.stringify(changed.provenance), baseline);
  assert.equal(await readFile(evidence, 'utf8'), initial);
  await writeFile(artifact, data);
  const restored = await agent.runs.check(run.id);
  assert.equal(restored.delivery, 'passed');
  assert.equal(restored.checks.length, 3);
  assert.deepEqual(restored.checks.at(-1).artifactChanges, []);
  assert.equal(fixture.requests.length, requests);
});

test('changed input, checker source and replacement checker command cannot overwrite the initial passed evidence', async t => {
  const { agent, root, config } = await setup(t);
  const run = await agent.runTask('Summarize FASTA.');
  const input = path.join(root, 'data/input.fasta');
  const source = await readFile(input, 'utf8');
  await writeFile(input, `${source}\n>extra\nAAAA\n`);
  const changedInput = await agent.runs.check(run.id);
  assert.equal(changedInput.delivery, 'failed');
  assert.deepEqual(changedInput.checks.at(-1).inputChanges, ['data/input.fasta']);
  assert.equal(changedInput.originalDelivery.delivery, 'passed');
  await writeFile(input, source);
  const validator = path.join(root, 'tools/validate.py');
  const validationSource = await readFile(validator, 'utf8');
  await writeFile(validator, `${validationSource}\n# changed validator\n`);
  const changedCode = await agent.runs.check(run.id);
  assert.equal(changedCode.delivery, 'failed');
  assert.ok(changedCode.checks.at(-1).codeChanges.includes('tools/validate.py'));
  await writeFile(validator, validationSource);
  // The Agent holds a shallow config copy, so mutating this trusted test-only
  // command exercises an in-memory checker replacement as well as file edits.
  config.validation.command.splice(0, config.validation.command.length, process.execPath, '-e', 'console.log("fake validator")', 'tools/validate.py');
  const changedCommand = await agent.runs.check(run.id);
  assert.equal(changedCommand.delivery, 'failed');
  assert.deepEqual(changedCommand.checks.at(-1).codeChanges, ['validation configuration']);
  assert.equal(changedCommand.originalDelivery.delivery, 'passed');
});

test('legacy run JSON stays readable and recheck never invents initial provenance', async t => {
  const { agent } = await setup(t);
  const run = await agent.runTask('Summarize FASTA.');
  for (const field of ['schemaVersion', 'provenance', 'checks', 'originalDelivery']) delete run[field];
  await agent.runs.save(run);
  const checked = await agent.runs.check(run.id);
  assert.equal(checked.delivery, 'passed');
  assert.equal(checked.provenance, undefined);
  assert.equal(checked.originalDelivery, undefined);
  assert.equal(checked.checks[0].kind, 'recheck');
});

test('explicit code fingerprint registrations fail on missing files or directories', async t => {
  const { config } = await setup(t);
  for (const file of ['missing.py', 'tools']) {
    const store = createRunStore({ ...config, provenance: { code: [file] } });
    await assert.rejects(store.create('Do not silently omit registered code', 'test-session'), /provenance\.code.*regular file/);
  }
});

test('interrupted recheck recovery marks latest delivery failed while preserving original acceptance', async t => {
  const { agent, config } = await setup(t);
  const run = await agent.runTask('Summarize FASTA.');
  const original = JSON.stringify(run.originalDelivery);
  run.delivery = 'not_checked';
  run.pendingCheck = { id: 'interrupted-check-for-test', kind: 'recheck', startedAt: new Date().toISOString() };
  await agent.runs.save(run);
  await agent.recover();
  const recovered = await agent.runs.load(run.id);
  assert.equal(recovered.delivery, 'failed');
  assert.equal(recovered.execution, 'completed');
  assert.equal(recovered.pendingCheck, undefined);
  assert.equal(JSON.stringify(recovered.originalDelivery), original);
  assert.match((await agent.runs.report(run.id)).issues.join(' '), /not replayed/);
  assert.ok(await readFile(path.join(config.root, 'runs', run.id, recovered.checks.at(-1).report)));
  recovered.pendingCheck = { id: 'interrupted-direct-check', kind: 'recheck', startedAt: new Date().toISOString() };
  await agent.runs.save(recovered);
  const checkedDirectly = await checkRun(config, run.id);
  assert.equal(checkedDirectly.delivery, 'passed');
  assert.equal(checkedDirectly.checks.at(-2).id, 'interrupted-direct-check');
  assert.equal(checkedDirectly.checks.at(-2).delivery, 'failed');
  assert.equal(JSON.stringify(checkedDirectly.originalDelivery), original);
});

test('checker cannot rewrite outputs and leave a passed verdict against old hashes', async t => {
  const { agent, config } = await setup(t);
  for (const ending of [
    'fs.writeFileSync(process.env.AGENT_CHECK_FILE,JSON.stringify({status:"passed",checks:[],issues:[]}));',
    'process.exit(7);',
    'fs.writeFileSync(process.env.AGENT_CHECK_FILE,"invalid JSON");',
  ]) {
    config.validation.command.splice(0, config.validation.command.length, process.execPath, '-e',
      'const fs=require("node:fs");fs.unlinkSync(process.env.AGENT_OUTPUT_DIR+"/report.md");fs.writeFileSync(process.env.AGENT_OUTPUT_DIR+"/extra.txt","changed by validator");' + ending);
    const run = await agent.runTask('Summarize FASTA.');
    assert.equal(run.delivery, 'failed');
    assert.equal(run.originalDelivery.delivery, 'failed');
    assert.match((await agent.runs.report(run.id)).issues.join(' '), /changed during validation/);
    assert.ok(run.artifacts.includes('output/extra.txt'));
    assert.ok(!run.artifacts.includes('output/report.md'));
    assert.ok(run.checks.at(-1).artifactHashes.some(file => file.path === 'output/extra.txt'));
  }
});

test('checker command baseline survives a crash gap before any initial check observation', async t => {
  const { agent, config } = await setup(t);
  const run = await agent.runTask('Summarize FASTA.');
  delete run.originalDelivery; delete run.checks;
  await agent.runs.save(run);
  config.validation.command.splice(0, config.validation.command.length, process.execPath, '-e', 'console.log("replacement")', 'tools/validate.py');
  const checked = await agent.runs.check(run.id);
  assert.equal(checked.delivery, 'failed');
  assert.deepEqual(checked.checks.at(-1).codeChanges, ['validation configuration']);
  assert.equal(checked.originalDelivery, undefined);
});

test('an actually killed recheck worker leaves no stale passed verdict and recovers without replay', { skip: process.platform === 'win32' }, async t => {
  const checkerSource = 'const fs=require("node:fs");if(fs.existsSync("enable-slow-check")){fs.writeFileSync("checker.pid",String(process.pid));setInterval(()=>{},1000)}else{fs.writeFileSync(process.env.AGENT_CHECK_FILE,JSON.stringify({status:"passed",checks:[],issues:[]}))}';
  const { agent, root, config } = await setup(t, { validation: { command: [process.execPath, '-e', checkerSource] } });
  const run = await agent.runTask('Summarize FASTA.');
  assert.equal(run.delivery, 'passed');
  const original = JSON.stringify(run.originalDelivery);
  await writeFile(path.join(root, 'enable-slow-check'), '1');
  const childConfig = { root, model: 'openai:no-inference', python: config.python, validation: config.validation };
  const source = `import{checkRun}from${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};await checkRun(${JSON.stringify(childConfig)},${JSON.stringify(run.id)});`;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, stdio: 'ignore' });
  let checkerPid;
  t.after(() => { worker.kill('SIGKILL'); if (checkerPid) { try { process.kill(-checkerPid, 'SIGKILL'); } catch {} } });
  const closed = new Promise(resolve => worker.once('close', resolve));
  const deadline = Date.now() + 5000;
  for (;;) {
    try { checkerPid = Number(await readFile(path.join(root, 'checker.pid'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  const during = await agent.runs.load(run.id);
  assert.equal(during.delivery, 'not_checked');
  assert.ok(during.pendingCheck);
  worker.kill('SIGKILL'); await closed;
  // Trusted subprocesses are not an OS sandbox: explicitly clean the orphan
  // created by this crash injection before testing metadata recovery.
  process.kill(-checkerPid, 'SIGKILL');
  await agent.recover();
  const recovered = await agent.runs.load(run.id);
  assert.equal(recovered.delivery, 'failed');
  assert.equal(JSON.stringify(recovered.originalDelivery), original);
  assert.equal(recovered.pendingCheck, undefined);
});

test('native prepareStep projection leaves durable messages intact and explicit workflow links survive reload', async t => {
  let calls = 0;
  const { agent, fixture } = await setup(t, { prepareStep(options) {
    calls++;
    return { messages: options.messages.map(message => message.role === 'user'
      ? { ...message, content: typeof message.content === 'string' ? `${message.content}\nPINNED_SCIENTIFIC_CONSTRAINT`
        : [...message.content, { type: 'text', text: 'PINNED_SCIENTIFIC_CONSTRAINT' }] } : message) };
  } });
  const first = await agent.runTask('Summarize FASTA.', { workflowId: 'research-1' });
  const second = await agent.runTask('Summarize FASTA again.', { workflowId: 'research-1', parentRunId: first.id });
  assert.ok(calls >= 6);
  assert.equal((await agent.runs.load(second.id)).parentRunId, first.id);
  assert.equal(second.workflowId, 'research-1');
  assert.ok(fixture.requests.some(request => JSON.stringify(request.body.messages).includes('PINNED_SCIENTIFIC_CONSTRAINT')));
  assert.ok(!(JSON.stringify((await agent.sessions.load(first.session.id)).messages).includes('PINNED_SCIENTIFIC_CONSTRAINT')));
});

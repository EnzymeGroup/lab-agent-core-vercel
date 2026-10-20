import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { checkRun, createRunStore, modelFromEnv, runCommand } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-checker-'));
  const fixture = await startModelServer({ plan: [] });
  t.after(async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const model = modelFromEnv({ LAB_AGENT_MODEL: 'fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const config = { root, model, validation: { command: [process.execPath, 'checker.mjs'], timeoutMs: 3000 } };
  const store = createRunStore(config);
  const run = await store.create('Existing outputs', 'recorded-session');
  // Exercise legacy checker semantics independently of the new source-change
  // gate. These synthetic records intentionally predate their checker files.
  delete run.schemaVersion; delete run.provenance;
  run.execution = 'completed'; await store.save(run);
  const checker = async source => writeFile(path.join(root, 'checker.mjs'), source);
  return { root, config, fixture, run, checker };
}
const report = status => `import{writeFileSync}from'node:fs'; writeFileSync(process.env.AGENT_CHECK_FILE,JSON.stringify({status:${JSON.stringify(status)},checks:[{name:'domain',status:${JSON.stringify(status)}}],issues:[]})); console.log(process.env.AGENT_RUN_ID);`;

test('passed and partial check reports are independent from execution, and CLI returns partial exit code 2', async t => {
  const { root, config, fixture, run, checker } = await setup(t);
  await checker(report('passed')); assert.equal((await checkRun(config, run.id)).delivery, 'passed');
  await checker(report('partial')); const partial = await checkRun(config, run.id);
  assert.equal(partial.execution, 'completed'); assert.equal(partial.delivery, 'partial');
  const entry = pathToFileURL(fileURLToPath(new URL('../packages/core/dist/index.js', import.meta.url))).href;
  await writeFile(path.join(root, 'agent.config.ts'), `import{defineAgent,modelFromEnv}from${JSON.stringify(entry)};export default defineAgent({root:${JSON.stringify(root)},model:modelFromEnv({LAB_AGENT_MODEL:'fixture',LAB_AGENT_API_KEY:'fixture-only',LAB_AGENT_BASE_URL:${JSON.stringify(fixture.url)}}),validation:{command:[${JSON.stringify(process.execPath)},'checker.mjs']}});`);
  const cli = fileURLToPath(new URL('../packages/core/dist/cli/main.js', import.meta.url));
  const result = await runCommand(process.execPath, [cli, 'check', run.id, '--root', root, '--json'], { cwd: root });
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).delivery, 'partial'); assert.equal(fixture.requests.length, 0);
  assert.match(await readFile(path.join(run.directory, 'validation.log'), 'utf8'), new RegExp(run.id));
});

test('nonzero, missing and malformed checker reports replace a previously passed result with failed delivery', async t => {
  const { config, fixture, run, checker } = await setup(t);
  for (const source of [`${report('passed')}process.exit(7);`, 'console.error("missing report");', "import{writeFileSync}from'node:fs';writeFileSync(process.env.AGENT_CHECK_FILE,'not JSON');"]) {
    await checker(report('passed')); assert.equal((await checkRun(config, run.id)).delivery, 'passed');
    await checker(source); const failed = await checkRun(config, run.id);
    assert.equal(failed.delivery, 'failed'); assert.equal(failed.execution, 'completed');
    assert.equal(JSON.parse(await readFile(path.join(run.directory, 'check.json'), 'utf8')).status, 'failed');
  }
  assert.equal(fixture.requests.length, 0);
});

test('checker timeout preserves bounded diagnostics and releases its operation lock', async t => {
  const { root, config, run, checker } = await setup(t);
  await checker("console.log('diagnostic-before-timeout');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
  const result = await checkRun({ ...config, validation: { ...config.validation, timeoutMs: 100 } }, run.id);
  assert.equal(result.delivery, 'failed');
  assert.match(await readFile(path.join(run.directory, 'validation.log'), 'utf8'), /diagnostic-before-timeout/);
  await assert.rejects(readFile(path.join(root, '.lab-agent/operation.lock')));
});

test('CLI recheck cancellation reaches its subprocess without initializing unavailable MCP', { skip: process.platform === 'win32' }, async t => {
  const { root, run, fixture, checker } = await setup(t);
  await checker('import{writeFileSync}from"node:fs";writeFileSync("checker.pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);');
  const entry = pathToFileURL(fileURLToPath(new URL('../packages/core/dist/index.js', import.meta.url))).href;
  await writeFile(path.join(root, 'agent.config.ts'), `import{defineAgent,modelFromEnv}from${JSON.stringify(entry)};export default defineAgent({root:${JSON.stringify(root)},model:modelFromEnv({LAB_AGENT_MODEL:'fixture',LAB_AGENT_API_KEY:'fixture-only',LAB_AGENT_BASE_URL:${JSON.stringify(fixture.url)}}),validation:{command:[${JSON.stringify(process.execPath)},'checker.mjs'],timeoutMs:10000},mcp:{unavailable:{transport:'http',url:'http://127.0.0.1:1/mcp'}}});`);
  const cli = fileURLToPath(new URL('../packages/core/dist/cli/main.js', import.meta.url));
  const worker = spawn(process.execPath, [cli, 'check', run.id, '--root', root, '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let pid;
  worker.stdout.on('data', chunk => { stdout += chunk; }); worker.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => worker.once('close', resolve));
  t.after(() => { worker.kill('SIGKILL'); if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { pid = Number(await readFile(path.join(root, 'checker.pid'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw new Error(`${error.message}; ${stderr}`); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  worker.kill('SIGINT');
  assert.equal(await closed, 1, stderr);
  assert.equal(JSON.parse(stdout).delivery, 'failed');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(path.join(root, '.lab-agent/operation.lock')), { code: 'ENOENT' });
  assert.equal(fixture.requests.length, 0);
});

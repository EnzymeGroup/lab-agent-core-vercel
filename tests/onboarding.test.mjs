import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startModelServer } from './fixtures/model-server.mjs';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const core = pathToFileURL(path.join(repository, 'packages/core/dist/index.js')).href;
const cli = path.join(repository, 'packages/core/dist/cli/main.js');
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^LAB_AGENT_|^(OPENAI|ANTHROPIC)_(API_KEY|BASE_URL)$/u.test(key)));
async function command(file, args, options = {}) {
  try { return { ...(await exec(file, args, { maxBuffer: 4_000_000, ...options })), code: 0 }; }
  catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
async function temporary(t) { const root = await mkdtemp(path.join(tmpdir(), 'lab-onboarding-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('factory and legacy object configs isolate concurrent project dotenv without process mutation', async t => {
  const root = await temporary(t);
  const projects = [path.join(root, 'a'), path.join(root, 'b')];
  for (const [index, project] of projects.entries()) {
    await mkdir(project);
    await writeFile(path.join(project, '.env'), `LAB_AGENT_MODEL=project-${index}\nLAB_AGENT_API_KEY=private-project-key-${index}\nPROJECT_NOTE=note-${index}\n`);
    const body = index === 0
      ? `export default defineAgent(async ({ root, env }) => { await new Promise(r => setTimeout(r, 20)); return { root, model: modelFromEnv(), instructions: { text: env.PROJECT_NOTE } }; });`
      : `await new Promise(r => setTimeout(r, 10)); export default defineAgent({ root: ${JSON.stringify(project)}, model: modelFromEnv(), instructions: { text: 'legacy object' } });`;
    await writeFile(path.join(project, 'agent.config.ts'), `import { defineAgent, modelFromEnv } from ${JSON.stringify(core)};\n${body}\n`);
  }
  const result = await command(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { loadAgentConfig } from ${JSON.stringify(core)};
    const snapshot=JSON.stringify(process.env);
    const configs=await Promise.all(${JSON.stringify(projects)}.map(root=>loadAgentConfig(root)));
    assert.equal(configs[0].model.modelId,'project-0');assert.equal(configs[1].model.modelId,'project-1');
    assert.equal(configs[0].instructions.text,'note-0');assert.equal(configs[1].env.PROJECT_NOTE,'note-1');
    assert.equal(JSON.stringify(process.env),snapshot);
    assert.deepEqual(configs[0].provenance.code,['agent.config.ts']);
  `], { env: cleanEnv() });
  assert.equal(result.code, 0, result.stderr);
});

test('static inspection never starts MCP or inference; doctor exposes unavailable required/optional MCP and explicit probe', async t => {
  const root = await temporary(t);
  const fixture = await startModelServer(); t.after(() => fixture.close());
  const marker = path.join(root, 'mcp-started');
  await writeFile(path.join(root, '.env'), `LAB_AGENT_MODEL=doctor-fixture\nLAB_AGENT_API_KEY=scoped-super-private-key\nLAB_AGENT_BASE_URL=${fixture.url}\n`);
  await writeFile(path.join(root, 'agent.config.ts'), `import { defineAgent, modelFromEnv } from ${JSON.stringify(core)};
    export default defineAgent(({root,env})=>({root, model:modelFromEnv(env),
      python:{command:'python3',scripts:{missing:{path:'tools/missing.py',description:'Missing script must be diagnosed, never executed.'}}}, mcp:{
        optional:{optional:true,transport:'stdio',command:${JSON.stringify(process.execPath)},args:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(1)`)}]},
        required:{transport:'http',url:'http://127.0.0.1:1/mcp'}
      }}));`);
  for (const verb of ['inspect', 'models']) {
    const inspected = await command(process.execPath, [cli, verb, '--root', root, '--json'], { env: cleanEnv() });
    assert.equal(inspected.code, 0, inspected.stderr || inspected.stdout);
    assert.doesNotMatch(inspected.stdout, /scoped-super-private-key/);
    if (verb === 'inspect') {
      const data = JSON.parse(inspected.stdout);
      assert.ok(data.mcp.every(server => server.status === 'configured'));
      assert.equal(data.toolDetails.find(tool => tool.name === 'readFile').inputSchema.properties.path.type, 'string');
    }
  }
  await assert.rejects(access(marker));
  assert.equal(fixture.requests.length, 0);
  const diagnosed = await command(process.execPath, [cli, 'doctor', '--root', root, '--json'], { env: cleanEnv() });
  assert.equal(diagnosed.code, 1, diagnosed.stderr || diagnosed.stdout);
  const report = JSON.parse(diagnosed.stdout);
  assert.equal(report.status, 'failed');
  assert.equal(report.mcp.length, 2);
  assert.ok(report.mcp.every(server => server.status === 'unavailable'));
  assert.equal(report.checks.find(check => check.name === 'mcp:optional').status, 'warning');
  assert.equal(report.checks.find(check => check.name === 'python').status, 'passed');
  assert.equal(report.checks.find(check => check.name === 'python-script:missing').status, 'failed');
  assert.equal(fixture.requests.length, 0);
  await access(marker);
  const probed = await command(process.execPath, [cli, 'doctor', '--probe-model', '--root', root, '--json'], { env: cleanEnv() });
  assert.equal(JSON.parse(probed.stdout).checks.find(check => check.name === 'model').status, 'passed');
  assert.equal(fixture.requests.length, 1);
});

test('doctor reports config errors and redacts scoped dotenv credentials', async t => {
  const root = await temporary(t);
  const secret = 'scoped-credential-must-not-appear';
  await writeFile(path.join(root, '.env'), `LAB_AGENT_API_KEY=${secret}\n`);
  await writeFile(path.join(root, 'agent.config.ts'), `export default ({env})=>{throw new Error('config rejection '+env.LAB_AGENT_API_KEY)};`);
  const result = await command(process.execPath, [cli, 'doctor', '--root', root, '--json'], { env: cleanEnv() });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).checks.find(check => check.name === 'config').status, 'failed');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.match(result.stdout, /redacted/);
});

test('installed basic and python templates bootstrap from one current tarball', { timeout: 180_000 }, async t => {
  const root = await temporary(t);
  const packed = await command('npm', ['pack', '--workspace', 'lab-agent-core-vercel', '--json', '--pack-destination', root], { cwd: repository });
  assert.equal(packed.code, 0, packed.stderr);
  const info = JSON.parse(packed.stdout)[0];
  const tarball = path.join(root, info.filename);
  await writeFile(path.join(root, 'package.json'), '{"name":"installed-onboarding-test","private":true,"type":"module"}');
  const installed = await command('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: root });
  assert.equal(installed.code, 0, installed.stderr);
  const fixture = await startModelServer(); t.after(() => fixture.close());
  const bin = path.join(root, 'node_modules/.bin/lab-agent');
  const create = path.join(root, 'node_modules/.bin/create-lab-agent');
  const env = { ...cleanEnv(), LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'onboarding-fixture', LAB_AGENT_API_KEY: 'local-fixture-only', LAB_AGENT_BASE_URL: fixture.url };
  for (const template of ['basic', 'python']) {
    const project = path.join(root, template);
    const created = await command(create, [project, '--template', template], { cwd: root, env });
    assert.equal(created.code, 0, created.stderr);
    const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['lab-agent-core-vercel'], info.version);
    const inspected = await command(bin, ['inspect', '--root', project, '--json'], { cwd: root, env });
    assert.equal(inspected.code, 0, inspected.stderr || inspected.stdout);
    const data = JSON.parse(inspected.stdout);
    assert.equal(data.tools.includes('runPython'), template !== 'basic');
    const task = template === 'basic' ? '[tool:countText] Count the supplied text.' : 'Summarize the supplied FASTA.';
    const ran = await command(bin, ['run', task, '--root', project, '--json'], { cwd: root, env });
    assert.equal(ran.code, 0, ran.stderr || ran.stdout);
    const record = JSON.parse(ran.stdout);
    assert.equal(record.execution, 'completed');
    assert.equal(record.delivery, template === 'basic' ? 'not_checked' : 'passed');
  }
  const rejected = await command(create, [path.join(root, 'unknown'), '--template', 'unknown'], { cwd: root, env });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Unknown template/);
  // Package remains an independent AI SDK implementation.
  const manifest = JSON.parse(await readFile(path.join(root, 'node_modules/lab-agent-core-vercel/package.json'), 'utf8'));
  assert.ok(!Object.keys(manifest.dependencies).some(name => /pi-coding|pi-agent|pi-ai|pi-web/.test(name)));
});

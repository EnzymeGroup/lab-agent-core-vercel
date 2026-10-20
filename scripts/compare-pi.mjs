/** Optional engineering comparison against an existing, already-built Pi Core.
 * No Pi dependency is installed or added to this package. No old source changes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startModelServer } from '../tests/fixtures/model-server.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };

async function runWorker(input, checkpoint) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', JSON.stringify(input)], { cwd: input.root, env: { ...process.env, PI_CODING_AGENT_DIR: input.agentDir, PI_WEB_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = '';
    child.stdout.on('data', data => { diagnostics += data; });
    child.stderr.on('data', data => { diagnostics += data; });
    child.on('message', message => {
      if (message.phase === 'before-recheck') { checkpoint(); child.send({ acknowledged: true }); }
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 90_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Comparison worker failed (${code}): ${diagnostics}`)); });
  });
}

async function runningDirectory(root) {
  const candidates = [];
  for (const id of await readdir(path.join(root, 'runs'))) {
    const directory = path.join(root, 'runs', id);
    if ((await json(path.join(directory, 'run.json'))).execution === 'running') candidates.push(directory);
  }
  assert.equal(candidates.length, 1, 'a tool must belong to exactly one active task');
  return candidates[0];
}

async function worker(input) {
  const { framework, root, app, script, baseURL, agentDir, piRoot, destination } = input;
  const validation = { command: ['python3', 'tools/validate.py'], timeoutMs: 30_000 };
  let agent;
  let run;
  let recheck;
  let sessionFile;
  let activeTools;
  let close;
  if (framework === 'vercel') {
    const core = await import(pathToFileURL(path.join(repository, 'packages/core/dist/index.js')).href);
    agent = await core.createAgent({ root,
      model: core.modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'deterministic-comparison', LAB_AGENT_API_KEY: 'local-fixture-only', LAB_AGENT_BASE_URL: baseURL }),
      python: { scripts: { [script]: { path: `tools/${script}.py`, description: 'Run the fixed source-preserving analysis.', timeoutMs: 30_000 } } },
      validation, limits: { maxSteps: 3, timeoutMs: 60_000 },
    });
    // Comparator-only least privilege: the SDK exposes this native tool map.
    for (const name of Object.keys(agent.native.tools)) if (!['loadSkill', 'runPython'].includes(name)) delete agent.native.tools[name];
    activeTools = Object.keys(agent.native.tools).sort();
    close = () => agent.close();
    recheck = id => agent.runs.check(id);
    try { run = await agent.runTask(input.task); }
    catch (error) { await close(); throw error; }
    sessionFile = path.join(root, '.lab-agent/sessions', `${run.session.id}.json`);
  } else {
    assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir, 'Pi process config must be isolated before imports');
    const sdk = await import(pathToFileURL(path.join(piRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
    const { Type } = await import(pathToFileURL(path.join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
    const pi = await import(pathToFileURL(path.join(piRoot, 'dist/index.js')).href);
    const { runCommand } = await import(pathToFileURL(path.join(repository, 'packages/core/dist/workspace/process.js')).href);
    await mkdir(agentDir, { recursive: true });
    await save(path.join(agentDir, 'models.json'), { providers: { fixture: { baseUrl: baseURL, api: 'openai-completions', apiKey: 'local-fixture-only', models: [{ id: 'deterministic-comparison', name: 'Deterministic engineering comparison', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
    await save(path.join(agentDir, 'settings.json'), { defaultProvider: 'fixture', defaultModel: 'deterministic-comparison', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false }, extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool-search'] });
    new sdk.ProjectTrustStore(agentDir).set(root, true);
    const customTools = [{ name: 'loadSkill', label: 'Load skill', description: 'Load the named project Skill.', parameters: Type.Object({ name: Type.String() }),
      async execute(_id, { name }) {
        assert.equal(name, app, 'only this named fixed Skill is allowed');
        return { content: [{ type: 'text', text: await readFile(path.join(root, '.agents/skills', app, 'SKILL.md'), 'utf8') }], details: {} };
      },
    }, { name: 'runPython', label: 'Run registered Python', description: 'Run the fixed source-preserving analysis.', parameters: Type.Object({ script: Type.String(), args: Type.Array(Type.String(), { maxItems: 256 }) }),
      async execute(_id, parameters, signal) {
        assert.equal(parameters.script, script, 'only the named fixed Python script is allowed');
        assert.ok(parameters.args.length <= 256 && parameters.args.every(value => typeof value === 'string' && !value.includes('\0')) && parameters.args.reduce((total, value) => total + Buffer.byteLength(value), 0) <= 65_536, 'registered argv must satisfy the same bounds as Core');
        const directory = await runningDirectory(root);
        // Use the same shell-free subprocess runner as the new Core; this test
        // compares runtime/delivery integration, not different shell policies.
        const result = await runCommand('python3', [path.join(root, 'tools', `${script}.py`), ...parameters.args], {
          cwd: root, timeoutMs: 30_000, maxOutputBytes: 1_048_576, signal,
          env: { AGENT_ROOT: root, AGENT_RUN_DIR: directory, AGENT_OUTPUT_DIR: path.join(directory, 'output'), AGENT_RUN_ID: path.basename(directory) },
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    }];
    agent = await pi.createAgent({ root, validation }, { agentDir, tools: ['loadSkill', 'runPython'], customTools, sessionManager: sdk.SessionManager.create(root, path.join(agentDir, 'sessions')) });
    activeTools = agent.session.getActiveToolNames().sort();
    close = () => agent.dispose();
    recheck = () => pi.checkRun({ root, validation }, run.directory);
    // Native Pi has no matching SDK maxSteps option. The same external model
    // protocol fixes exactly three requests; a turn guard enforces the same cap.
    let turns = 0;
    agent.session.subscribe(event => { if (event.type === 'turn_start' && ++turns > 3) void agent.session.abort(); });
    const deadline = setTimeout(() => { void agent.session.abort(); }, 60_000);
    try { run = await agent.run(input.task); }
    catch (error) { await close(); throw error; }
    finally { clearTimeout(deadline); }
    sessionFile = run.session.file;
  }
  try {
    assert.deepEqual(activeTools, ['loadSkill', 'runPython']);
    assert.equal(run.execution, 'completed');
    assert.equal(run.delivery, 'passed');
    await mkdir(destination, { recursive: true });
    await save(path.join(destination, 'run.before.json'), run);
    await cp(path.join(run.directory, 'output'), path.join(destination, 'output'), { recursive: true });
    await cp(path.join(run.directory, 'check.json'), path.join(destination, 'check.before.json'));
    await cp(path.join(run.directory, 'validation.log'), path.join(destination, 'validation.before.log'));
    await cp(sessionFile, path.join(destination, framework === 'pi' ? 'session.jsonl' : 'session.json'));
    const artifactHashes = {};
    for (const name of await readdir(path.join(run.directory, 'output'))) artifactHashes[name] = hash(await readFile(path.join(run.directory, 'output', name)));
    // Parent snapshots the actual HTTP request count and acknowledges before
    // checker-only work proceeds. Thus zero recheck inference is measured.
    if (process.send) await new Promise(resolve => { process.once('message', resolve); process.send({ phase: 'before-recheck' }); });
    const artifact = path.join(run.directory, 'output', app === 'sequence-summary' ? 'summary.json' : 'profile.json');
    const tampered = await json(artifact);
    if (tampered.records) tampered.records[0].length += 99;
    else tampered.row_count += 99;
    await writeFile(artifact, JSON.stringify(tampered));
    const checked = await recheck(run.id);
    assert.equal(checked.execution, 'completed');
    assert.equal(checked.delivery, 'failed');
    await save(path.join(destination, 'run.after-tamper.json'), checked);
    await cp(path.join(run.directory, 'check.json'), path.join(destination, 'check.after-tamper.json'));
    await cp(path.join(run.directory, 'validation.log'), path.join(destination, 'validation.after-tamper.log'));
    const summary = { framework, app, activeTools, execution: run.execution, delivery: run.delivery, tamperedDelivery: checked.delivery, artifacts: run.artifacts, artifactHashes, recordCount: app === 'sequence-summary' ? tampered.records.length : tampered.rows.length };
    await save(path.join(destination, 'summary.json'), summary);
  } finally { await close(); }
}

async function compare() {
  const piRoot = path.resolve(arg('--pi-root', path.join(repository, '../lab-agent-core')));
  const destination = path.resolve(arg('--output', path.join(repository, '.artifacts/comparison')));
  await access(path.join(piRoot, 'dist/index.js'));
  await access(path.join(repository, 'packages/core/dist/index.js'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'lab-agent-comparison-'));
  const results = [];
  const startedAt = new Date().toISOString();
  await save(path.join(destination, 'results.json'), { status: 'running', startedAt });
  try {
    for (const [app, script] of [['sequence-summary', 'summarize'], ['table-quality', 'analyze']]) {
      const fixture = await startModelServer({ plan: [{ name: 'loadSkill', args: { name: app } }, { name: 'runPython', args: { script, args: [] } }] });
      try {
        for (const framework of ['vercel', 'pi']) {
          const root = path.join(scratch, framework, app);
          const output = path.join(destination, app, framework);
          await cp(path.join(repository, 'examples', app), root, { recursive: true });
          const agentDir = path.join(scratch, 'isolated-pi-agent', app);
          const task = `Load ${app} then execute the registered ${script} script. Preserve all source identifiers and missingness; deliver source-derived JSON and Markdown.`;
          const start = fixture.requests.length;
          const input = { framework, root, app, script, baseURL: fixture.url, agentDir, piRoot, destination: output, task };
          let beforeRecheck;
          await runWorker(input, () => { beforeRecheck = fixture.requests.length - start; });
          const requests = fixture.requests.slice(start);
          assert.equal(requests.length, 3, `${framework}/${app}: exactly three requests including recheck`);
          assert.equal(beforeRecheck, 3, `${framework}/${app}: exactly three model calls before recheck`);
          assert.equal(requests.length - beforeRecheck, 0, `${framework}/${app}: recheck performs no model calls`);
          const requestSummary = requests.map(record => ({ model: record.body.model, stream: record.body.stream, offeredTools: record.body.tools.map(tool => tool.function.name).sort(), observedToolResults: record.body.messages.filter(message => message.role === 'tool').map(message => ({ tool_call_id: message.tool_call_id, content: message.content })) }));
          for (const request of requestSummary) assert.deepEqual(request.offeredTools, ['loadSkill', 'runPython']);
          await save(path.join(output, 'requests.json'), requests.map(record => record.body));
          const summary = { ...await json(path.join(output, 'summary.json')), modelRequests: requests.length, recheckModelRequests: 0, requestSummary };
          results.push(summary);
        }
        const pair = results.filter(result => result.app === app);
        assert.deepEqual(pair[0].artifactHashes, pair[1].artifactHashes, `${app}: byte-identical computed deliverables`);
      } finally { await fixture.close(); }
    }
    const inputHashes = {};
    for (const [app, script] of [['sequence-summary', 'summarize'], ['table-quality', 'analyze']]) {
      for (const file of [`data/input.${app === 'sequence-summary' ? 'fasta' : 'csv'}`, `tools/${script}.py`, 'tools/validate.py', 'AGENTS.md', `.agents/skills/${app}/SKILL.md`]) {
        inputHashes[`${app}/${file}`] = hash(await readFile(path.join(repository, 'examples', app, file)));
        const archived = path.join(destination, 'source', app, file);
        await mkdir(path.dirname(archived), { recursive: true });
        await cp(path.join(repository, 'examples', app, file), archived);
      }
    }
    const implementationHashes = {};
    for (const [label, file] of [['comparison', path.join(repository, 'scripts/compare-pi.mjs')], ['fixture', path.join(repository, 'tests/fixtures/model-server.mjs')], ['new-agent', path.join(repository, 'packages/core/dist/agent/turn.js')], ['new-delivery', path.join(repository, 'packages/core/dist/runs/check.js')], ['shared-process', path.join(repository, 'packages/core/dist/workspace/process.js')], ['pi-agent', path.join(piRoot, 'dist/agent.js')], ['pi-delivery', path.join(piRoot, 'dist/delivery.js')]]) implementationHashes[label] = hash(await readFile(file));
    const report = { status: 'passed', startedAt, finishedAt: new Date().toISOString(), node: process.version, piRoot, versions: { vercelCore: (await json(path.join(repository, 'packages/core/package.json'))).version, ai: (await json(path.join(repository, 'node_modules/ai/package.json'))).version, piCore: (await json(path.join(piRoot, 'package.json'))).version, piSdk: (await json(path.join(piRoot, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version }, protocol: { scenarios: 4, modelRequestsPerTask: 3, activeTools: ['loadSkill', 'runPython'], maxTaskMs: 60_000, pythonTimeoutMs: 30_000, checkerTimeoutMs: 30_000, fixture: 'Same deterministic Chat Completions HTTP fixture and fixed loadSkill → runPython → final plan. No live inference.', scope: 'Matched task integration and independently checked artifacts. Comparator-only Pi fixed-tool adapters and new native-tool narrowing; no stock-default or reasoning-quality benchmark.' }, inputHashes, implementationHashes, results };
    await save(path.join(destination, 'results.json'), report);
    await writeFile(path.join(destination, 'README.md'), '# Matched deterministic engineering comparison\n\nAll four framework/application scenarios passed execution and independent delivery checks. Each made exactly three streamed HTTP model requests with only loadSkill/runPython advertised. Tampered computed values failed recheck with zero additional model requests. Both applications produced byte-identical JSON and Markdown across frameworks.\n\nSee results.json, per-scenario requests/session/run/check records and output files. Temporary project paths in archived records are historical; temporary roots and isolated Pi trust/config were deleted after capture. No live model reasoning, timing superiority or human usability claim is established.\n');
    console.log(JSON.stringify({ status: report.status, scenarios: results.length, modelRequests: results.reduce((sum, result) => sum + result.modelRequests, 0), output: destination }));
  } catch (error) {
    await save(path.join(destination, 'results.json'), { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: error.message, results });
    throw error;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv.includes('--worker')) { await worker(JSON.parse(arg('--worker'))); if (process.connected) process.disconnect(); }
else await compare();

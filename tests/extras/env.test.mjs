import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, modelFromEnv } from '../../packages/core/dist/index.js';
import { envTools } from '../../packages/extras/dist/env.js';
import { startModelServer } from '../fixtures/model-server.mjs';

// lab-agent-extras/env with stand-in conda and python executables. Not live model inference.
const repository = fileURLToPath(new URL('../../', import.meta.url));

const call = (tools, input = {}) => tools.captureEnvironment.execute(tools.captureEnvironment.inputSchema.parse(input), { toolCallId: 'test', messages: [] });

async function fakes(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lab-agent-fake-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const make = async (name, body) => {
    const file = path.join(dir, name);
    await writeFile(file, `#!${process.execPath}\nconst args = process.argv.slice(2);\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, args }) + '\\n');\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  return {
    conda: await make('conda', `if (args.includes('missing')) { console.error('EnvironmentLocationNotFound: missing'); process.exit(1); }\nprocess.stdout.write('name: bio\\nchannels:\\n  - conda-forge\\ndependencies:\\n  - samtools=1.20\\n');`),
    python: await make('python3', `if (args[0] === '--version') console.log('Python 3.11.9');\nelse if (args.join(' ') === '-m pip freeze --all') process.stdout.write('numpy==1.26.4\\npandas==2.2.2\\n');\nelse process.exit(2);`),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('outside a task: conda and pip are captured and returned, nothing is saved', async t => {
  const fake = await fakes(t);
  const tools = envTools({ root: tmpdir(), conda: fake.conda, python: fake.python, env: { CONDA_PREFIX: '/opt/conda/envs/bio', CONDA_DEFAULT_ENV: 'bio' } });
  const result = await call(tools);
  assert.equal(result.saved, false);
  assert.deepEqual(result.conda, { env: 'bio' });
  assert.deepEqual(result.files.map(file => file.name), ['conda-environment.yml', 'pip-freeze.txt']);
  assert.match(result.files[0].content, /samtools=1.20/);
  assert.equal(result.files[1].content, '# Python 3.11.9\nnumpy==1.26.4\npandas==2.2.2\n');
  assert.equal(result.files[1].sha256, createHash('sha256').update(result.files[1].content).digest('hex'));
  assert.match(result.notes.at(-1), /Not in a task/);
  assert.deepEqual((await fake.calls())[0], { name: 'conda', args: ['env', 'export', '-p', '/opt/conda/envs/bio'] });
});

test('a named environment, no active environment, and nothing to capture', async t => {
  const fake = await fakes(t);
  const named = envTools({ root: tmpdir(), conda: fake.conda, python: fake.python, env: {} });
  await call(named, { condaEnv: 'bio2' });
  assert.deepEqual((await fake.calls()).find(item => item.name === 'conda').args, ['env', 'export', '-n', 'bio2']);
  assert.throws(() => named.captureEnvironment.inputSchema.parse({ condaEnv: '--prefix' }), 'option-like names are refused');

  const pipOnly = await call(named);
  assert.deepEqual(pipOnly.files.map(file => file.name), ['pip-freeze.txt']);
  assert.match(pipOnly.notes[0], /CONDA_PREFIX is unset/);

  const broken = envTools({ root: tmpdir(), conda: fake.conda, python: path.join(tmpdir(), 'no-such-python-here'), env: {} });
  await assert.rejects(call(broken, { condaEnv: 'missing' }), /Nothing was captured\. conda env export failed \(1\): EnvironmentLocationNotFound/);
});

test('in a Core task the files become run artifacts with hashes', async t => {
  const fake = await fakes(t);
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-env-agent-'));
  await cp(path.join(repository, 'examples/sequence-summary'), root, { recursive: true, filter: source => !/(?:^|\/)(?:runs|\.lab-agent|__pycache__)(?:\/|$)/.test(source) });
  const fixture = await startModelServer({ plan: [{ name: 'captureEnvironment', args: {} }] });
  const model = modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'fixture', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const env = { ...process.env, CONDA_PREFIX: '/opt/conda/envs/bio', CONDA_DEFAULT_ENV: 'bio' };
  const agent = await createAgent({ root, model, env, tools: envTools({ root, env, conda: fake.conda, python: fake.python }) });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });

  const run = await agent.runTask('[chat-only] record the environment');
  assert.equal(run.execution, 'completed');
  assert.deepEqual(run.artifacts, ['output/environment/conda-environment.yml', 'output/environment/pip-freeze.txt']);
  const session = await agent.sessions.load(run.session.id);
  const [part] = session.messages.flatMap(message => message.parts).filter(item => item.type === 'tool-captureEnvironment');
  assert.equal(part.output.saved, true);
  assert.deepEqual(part.output.files.map(file => file.path), [`runs/${run.id}/output/environment/conda-environment.yml`, `runs/${run.id}/output/environment/pip-freeze.txt`]);
  const recorded = new Set(run.provenance.artifacts.map(file => file.sha256));
  assert.ok(part.output.files.every(file => recorded.has(file.sha256)), 'provenance hashes match what the tool wrote');
  assert.equal(run.provenance.environment.conda, 'bio');
});

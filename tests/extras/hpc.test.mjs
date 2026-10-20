import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent } from '../../packages/core/dist/index.js';
import { hpcTools, slurm, localJobs } from '../../packages/extras/dist/hpc.js';
import { startModelServer } from '../fixtures/model-server.mjs';
import { callTool, copyExample, fixtureModel } from '../fixtures/project.mjs';

// lab-agent-extras/hpc. Local jobs are real background processes; Slurm uses stand-in
// sbatch/squeue/sacct/scancel scripts (no cluster is contacted). Not live model inference.

const call = callTool;

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-hpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'jobs-src'), { recursive: true });
  const script = async (name, body) => {
    const file = path.join(root, 'jobs-src', name);
    await writeFile(file, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    await chmod(file, 0o755);
  };
  await script('hello.sh', 'echo "hello $1"\necho "$JOB_ID" > "$JOB_OUTPUT_DIR/result.txt"\nmkdir -p "$JOB_OUTPUT_DIR/sub" && echo nested > "$JOB_OUTPUT_DIR/sub/more.txt"');
  await script('fail.sh', 'echo "bad input" >&2\nexit 3');
  await script('slow.sh', 'sleep 30');
  return root;
}

const JOBS = {
  hello: { script: 'jobs-src/hello.sh', description: 'Greets and writes result.txt.' },
  fail: { script: 'jobs-src/fail.sh', description: 'Always fails with exit code 3.' },
  slow: { script: 'jobs-src/slow.sh', description: 'Sleeps for 30 seconds.' },
};

test('local jobs: submit returns at once; status waits, lists outputs and keeps the record', async t => {
  const root = await project(t);
  const tools = hpcTools({ root, jobs: JOBS });
  assert.deepEqual(Object.keys(tools).sort(), ['cancelJob', 'jobLogs', 'jobStatus', 'submitJob']);

  const started = Date.now();
  const submitted = await call(tools, 'submitJob', { job: 'hello', args: ['world'] });
  assert.ok(Date.now() - started < 3000, 'submit does not wait for the job');
  assert.equal(submitted.scheduler, 'local');
  assert.match(submitted.id, /^[a-z0-9]{8}-[a-z0-9]{6}$/);
  assert.equal(submitted.directory, `jobs/${submitted.id}`);
  assert.equal(submitted.script.path, 'jobs-src/hello.sh');
  assert.match(submitted.script.sha256, /^[a-f0-9]{64}$/);

  const done = await call(tools, 'jobStatus', { jobId: submitted.id, waitSeconds: 20 });
  assert.equal(done.status, 'completed');
  assert.equal(done.exitCode, 0);
  assert.ok(done.finishedAt);
  assert.deepEqual(done.outputs, ['result.txt', 'sub/more.txt']);
  assert.equal((await readFile(path.join(root, done.outputDirectory, 'result.txt'), 'utf8')).trim(), submitted.id);
  assert.match((await call(tools, 'jobLogs', { jobId: submitted.id })).text, /hello world/);

  // A later turn builds new tools; the record on disk is the source of truth.
  const later = hpcTools({ root, jobs: JOBS });
  const listed = await call(later, 'jobStatus', {});
  assert.deepEqual(listed.jobs.map(job => [job.id, job.status]), [[submitted.id, 'completed']]);
  const saved = JSON.parse(await readFile(path.join(root, submitted.directory, 'job.json'), 'utf8'));
  assert.equal(saved.status, 'completed');
});

test('local jobs: failures keep the exit code and stderr; cancel stops a running job', async t => {
  const root = await project(t);
  const tools = hpcTools({ root, jobs: JOBS });
  const failed = await call(tools, 'submitJob', { job: 'fail' });
  const result = await call(tools, 'jobStatus', { jobId: failed.id, waitSeconds: 20 });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  assert.match((await call(tools, 'jobLogs', { jobId: failed.id, stream: 'stderr' })).text, /bad input/);

  const slow = await call(tools, 'submitJob', { job: 'slow' });
  assert.equal((await call(tools, 'jobStatus', { jobId: slow.id })).status, 'running');
  const cancelled = await call(tools, 'cancelJob', { jobId: slow.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.match((await call(tools, 'cancelJob', { jobId: slow.id })).note, /Already cancelled/);
});

test('only registered jobs run; limits and ids are checked', async t => {
  const root = await project(t);
  const tools = hpcTools({ root, jobs: JOBS, maxActive: 1 });
  assert.throws(() => tools.submitJob.inputSchema.parse({ job: 'rm -rf /' }));
  await assert.rejects(call(tools, 'jobStatus', { jobId: '../../etc' }), /Invalid jobId/);
  await assert.rejects(call(tools, 'jobLogs', { jobId: 'aaaaaaaa-bbbbbb' }), /No job/);
  const slow = await call(tools, 'submitJob', { job: 'slow' });
  await assert.rejects(call(tools, 'submitJob', { job: 'hello' }), /limit 1/);
  await call(tools, 'cancelJob', { jobId: slow.id });

  assert.throws(() => hpcTools({ root, jobs: {} }), /at least one/);
  assert.throws(() => hpcTools({ root, jobs: { 'bad name': JOBS.hello } }), /Invalid job name/);
  assert.throws(() => hpcTools({ root, jobs: JOBS, directory: '../outside' }), /Invalid jobs directory/);
  await writeFile(path.join(path.dirname(root), `outside-${path.basename(root)}.sh`), '#!/bin/sh\n');
  const escaping = hpcTools({ root, jobs: { out: { script: `../outside-${path.basename(root)}.sh`, description: 'outside' } } });
  await assert.rejects(call(escaping, 'submitJob', { job: 'out' }), /inside the project/);
  await rm(path.join(path.dirname(root), `outside-${path.basename(root)}.sh`));
});

/** Stand-in Slurm commands: they record argv and answer from a state file. */
async function fakeSlurm(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lab-agent-fake-slurm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state.json');
  await writeFile(state, JSON.stringify({ squeue: 'PENDING', sacct: '' }));
  const make = async (name, body) => {
    const file = path.join(dir, name);
    await writeFile(file, `#!${process.execPath}\nconst fs = require('node:fs');\nconst state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));\nfs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2), jobId: process.env.JOB_ID }) + '\\n');\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  const commands = {
    sbatch: await make('sbatch', `process.stdout.write('4242;cluster\\n');`),
    squeue: await make('squeue', `if (state.squeue) process.stdout.write(state.squeue + '\\n');`),
    sacct: await make('sacct', `if (state.sacct) process.stdout.write(state.sacct + '\\n');`),
    scancel: await make('scancel', `fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ squeue: '', sacct: 'CANCELLED by 1000|0:0' }));`),
  };
  return {
    commands,
    set: value => writeFile(state, JSON.stringify(value)),
    calls: async () => (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('slurm: sbatch argv, scheduler states and sacct exit codes', async t => {
  const root = await project(t);
  const fake = await fakeSlurm(t);
  const jobs = { ...JOBS, hello: { ...JOBS.hello, sbatch: ['--time=00:10:00'] } };
  const tools = hpcTools({ root, jobs, adapter: slurm({ commands: fake.commands, sbatch: ['--account=lab'] }) });
  const submitted = await call(tools, 'submitJob', { job: 'hello', args: ['a b', '--flag'] });
  assert.equal(submitted.scheduler, 'slurm');
  assert.equal(submitted.schedulerId, '4242');
  assert.equal(submitted.status, 'queued');
  const [sbatch] = await fake.calls();
  assert.equal(sbatch.jobId, submitted.id, 'JOB_* reach the job through the environment');
  assert.deepEqual(sbatch.argv.slice(0, 2), ['--parsable', `--job-name=lab-${submitted.id}`]);
  assert.ok(sbatch.argv.includes('--account=lab') && sbatch.argv.includes('--time=00:10:00'));
  assert.ok(sbatch.argv.some(arg => arg.startsWith('--output=') && arg.endsWith(`${submitted.id}/stdout.log`)));
  assert.deepEqual(sbatch.argv.slice(-3).map(arg => path.basename(arg)), ['hello.sh', 'a b', '--flag'], 'arguments stay separate argv entries');

  assert.equal((await call(tools, 'jobStatus', { jobId: submitted.id })).status, 'queued');
  await fake.set({ squeue: 'RUNNING', sacct: '' });
  assert.equal((await call(tools, 'jobStatus', { jobId: submitted.id })).status, 'running');
  await fake.set({ squeue: '', sacct: 'COMPLETED|0:0' });
  const done = await call(tools, 'jobStatus', { jobId: submitted.id });
  assert.deepEqual([done.status, done.exitCode, done.detail], ['completed', 0, 'COMPLETED']);

  await fake.set({ squeue: '', sacct: 'TIMEOUT|0:15' });
  const timedOut = await call(tools, 'submitJob', { job: 'slow' });
  const result = await call(tools, 'jobStatus', { jobId: timedOut.id });
  assert.deepEqual([result.status, result.detail], ['failed', 'TIMEOUT']);

  await fake.set({ squeue: 'RUNNING', sacct: '' });
  const running = await call(tools, 'submitJob', { job: 'slow' });
  assert.equal((await call(tools, 'jobStatus', { jobId: running.id })).status, 'running');
  assert.equal((await call(tools, 'cancelJob', { jobId: running.id })).status, 'cancelled');
  assert.ok((await fake.calls()).some(item => item.name === 'scancel' && item.argv[0] === '4242'));
});

test('hpc tools inside a Core task: the job records the run that started it', async t => {
  const root = await copyExample('lab-agent-extras-hpc-agent-');
  await mkdir(path.join(root, 'jobs-src'));
  await writeFile(path.join(root, 'jobs-src/hello.sh'), '#!/usr/bin/env bash\necho hi > "$JOB_OUTPUT_DIR/out.txt"\n');
  await chmod(path.join(root, 'jobs-src/hello.sh'), 0o755);
  const fixture = await startModelServer({ plan: [{ name: 'submitJob', args: { job: 'hello' } }] });
  const model = fixtureModel(fixture.url);
  const agent = await createAgent({ root, model, tools: hpcTools({ root, jobs: { hello: JOBS.hello }, adapter: localJobs() }), approval: ['submitJob'] });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const paused = await agent.runTask('[chat-only] start the job');
  assert.equal(paused.execution, 'awaiting_approval', 'submitJob can sit behind approval like any tool');
  const { run, session } = await agent.approve(paused.session.id, true);
  const [part] = session.messages.flatMap(message => message.parts).filter(item => item.type === 'tool-submitJob');
  assert.equal(part.state, 'output-available');
  assert.equal(part.output.runId, run.id);
  const tools = hpcTools({ root, jobs: { hello: JOBS.hello } });
  assert.equal((await call(tools, 'jobStatus', { jobId: part.output.id, waitSeconds: 20 })).status, 'completed');
});

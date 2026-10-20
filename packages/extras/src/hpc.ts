import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { atomicJSON, getExecutionContext, runCommand, sha256 } from 'lab-agent-core-vercel';

/**
 * Long-running jobs (Slurm, or local background processes) that outlive a turn.
 * submitJob returns at once with a jobId; a later step or turn checks it with jobStatus.
 * Like runPython, the model can only start job scripts registered in the config and pass
 * arguments; it never sends a shell command. Scripts are trusted code and are not sandboxed.
 *
 * Each job lives in <root>/<directory>/<jobId>/: job.json (record), stdout.log, stderr.log
 * and output/. The model can read that directory with readFile; a later task can bind it as input.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
const TERMINAL = new Set<JobStatus>(['completed', 'failed', 'cancelled']);

export interface JobDefinition {
  /** Project-relative executable script (with a shebang). For Slurm this is the sbatch script. */
  script: string;
  description: string;
  /** Extra scheduler options from the config, e.g. ['--time=02:00:00', '--mem=16G']. Never from the model. */
  sbatch?: string[];
}

export interface JobRecord {
  id: string;
  job: string;
  args: string[];
  scheduler: string;
  schedulerId: string;
  status: JobStatus;
  exitCode?: number;
  /** Raw scheduler state, e.g. "TIMEOUT". */
  detail?: string;
  submittedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Project-relative job directory. */
  directory: string;
  script: { path: string; sha256: string };
  /** The task run that submitted the job, when submitted from a task. */
  runId?: string;
}

export interface SubmitSpec {
  id: string;
  script: string;
  args: string[];
  cwd: string;
  /** Absolute job directory. */
  directory: string;
  env: NodeJS.ProcessEnv;
  options: string[];
  signal?: AbortSignal;
}

/** A scheduler backend. */
export interface JobAdapter {
  name: string;
  submit(spec: SubmitSpec): Promise<{ schedulerId: string; status: JobStatus }>;
  status(record: JobRecord, directory: string, signal?: AbortSignal): Promise<{ status: JobStatus; exitCode?: number; detail?: string }>;
  cancel(record: JobRecord, directory: string, signal?: AbortSignal): Promise<void>;
}

// ─── Slurm ──────────────────────────────────────────────────────────────────

const SLURM_STATES: Record<string, JobStatus> = {
  PENDING: 'queued', CONFIGURING: 'queued', REQUEUED: 'queued', REQUEUE_HOLD: 'queued', RESV_DEL_HOLD: 'queued',
  RUNNING: 'running', COMPLETING: 'running', SUSPENDED: 'running', RESIZING: 'running', STAGE_OUT: 'running',
  COMPLETED: 'completed', CANCELLED: 'cancelled',
  FAILED: 'failed', TIMEOUT: 'failed', OUT_OF_MEMORY: 'failed', NODE_FAIL: 'failed', PREEMPTED: 'failed', BOOT_FAIL: 'failed', DEADLINE: 'failed',
};

export interface SlurmOptions {
  /** Paths or names of the Slurm commands; default sbatch, squeue, sacct, scancel on PATH. */
  commands?: Partial<Record<'sbatch' | 'squeue' | 'sacct' | 'scancel', string>>;
  /** Options added to every sbatch call, e.g. ['--account=lab', '--partition=cpu']. */
  sbatch?: string[];
  timeoutMs?: number;
}

/** Slurm through sbatch/squeue/sacct/scancel, called as argv without a shell. */
export function slurm(options: SlurmOptions = {}): JobAdapter {
  const command = (name: 'sbatch' | 'squeue' | 'sacct' | 'scancel') => options.commands?.[name] ?? name;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    name: 'slurm',
    async submit(spec) {
      const argv = [
        '--parsable', `--job-name=lab-${spec.id}`, `--chdir=${spec.cwd}`,
        `--output=${join(spec.directory, 'stdout.log')}`, `--error=${join(spec.directory, 'stderr.log')}`,
        ...(options.sbatch ?? []), ...spec.options, spec.script, ...spec.args,
      ];
      // sbatch exports the submitting environment by default, so JOB_* reach the job.
      const result = await runCommand(command('sbatch'), argv, { cwd: spec.cwd, env: spec.env, signal: spec.signal, timeoutMs, maxOutputBytes: 65_536 });
      const schedulerId = result.stdout.trim().split(';')[0];
      if (result.code !== 0 || !/^\d+(?:_\d+)?$/u.test(schedulerId)) throw new Error(`sbatch failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
      return { schedulerId, status: 'queued' };
    },
    async status(record, _directory, signal) {
      const run = (name: 'squeue' | 'sacct', argv: string[]) => runCommand(command(name), argv, { cwd: process.cwd(), signal, timeoutMs, maxOutputBytes: 65_536 });
      const queue = await run('squeue', ['-h', '-j', record.schedulerId, '-o', '%T']).catch(() => undefined);
      const live = queue?.code === 0 ? queue.stdout.trim().split('\n')[0]?.trim() : '';
      if (live) return { status: SLURM_STATES[live] ?? 'unknown', detail: live };
      const accounting = await run('sacct', ['-n', '-X', '-P', '-j', record.schedulerId, '-o', 'State,ExitCode']);
      const [state = '', exit = ''] = accounting.stdout.trim().split('\n')[0]?.split('|') ?? [];
      const name = state.split(' ')[0];
      if (!name) return { status: 'unknown', detail: 'Not found in squeue or sacct.' };
      const exitCode = /^\d+/u.test(exit) ? Number(exit.split(':')[0]) : undefined;
      return { status: SLURM_STATES[name] ?? 'unknown', detail: state, ...(exitCode === undefined ? {} : { exitCode }) };
    },
    async cancel(record, _directory, signal) {
      const result = await runCommand(command('scancel'), [record.schedulerId], { cwd: process.cwd(), signal, timeoutMs, maxOutputBytes: 65_536 });
      if (result.code !== 0) throw new Error(`scancel failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    },
  };
}

// ─── Local background processes ─────────────────────────────────────────────

// Runs the job, then records its exit code. Runs detached, so it outlives the agent process.
const WRAPPER = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const [script, ...args] = process.argv.slice(1);
const done = code => { fs.writeFileSync(path.join(process.env.JOB_DIR, 'exit_code'), String(code)); process.exit(0); };
const child = spawn(script, args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); done(127); });
child.on('exit', (code, signal) => done(code ?? 128 + (os.constants.signals[signal] ?? 0)));
process.on('SIGTERM', () => child.kill('SIGTERM'));`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Background processes on this machine, for workstations and tests. Process IDs can be reused after a reboot. */
export function localJobs(): JobAdapter {
  return {
    name: 'local',
    async submit(spec) {
      const stdout = await open(join(spec.directory, 'stdout.log'), 'a');
      const stderr = await open(join(spec.directory, 'stderr.log'), 'a');
      try {
        const child = spawn(process.execPath, ['-e', WRAPPER, spec.script, ...spec.args], { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] });
        await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
        child.unref();
        return { schedulerId: String(child.pid), status: 'running' };
      } finally {
        await stdout.close();
        await stderr.close();
      }
    },
    async status(record, directory) {
      const exit = await readFile(join(directory, 'exit_code'), 'utf8').catch(() => undefined);
      const cancelled = await lstat(join(directory, 'cancelled')).then(() => true, () => false);
      if (exit !== undefined) {
        const exitCode = Number(exit.trim());
        return { status: cancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed', exitCode };
      }
      if (alive(Number(record.schedulerId))) return { status: 'running' };
      return { status: cancelled ? 'cancelled' : 'failed', detail: 'The process ended without recording an exit code.' };
    },
    async cancel(record, directory) {
      await writeFile(join(directory, 'cancelled'), new Date().toISOString());
      try {
        process.kill(-Number(record.schedulerId), 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export interface HpcToolOptions {
  /** Project root (the same as config.root). */
  root: string;
  /** Registered job scripts by name. The model can start only these. */
  jobs: Record<string, JobDefinition>;
  /** Default localJobs(). */
  adapter?: JobAdapter;
  /** Project-relative directory for job records and outputs. Default "jobs". */
  directory?: string;
  /** Jobs not yet finished at the same time. Default 4. */
  maxActive?: number;
  /** Environment for submitted jobs; default process.env. Pass config.env. */
  env?: NodeJS.ProcessEnv;
}

const JOB_ID = /^[a-z0-9]{8}-[a-z0-9]{6}$/u;
const JOB_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_WAIT_SECONDS = 60;

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

async function tail(file: string, lines: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return { text: '', truncated: false };
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const all = buffer.toString('utf8').split('\n');
    if (all.at(-1) === '') all.pop();
    return { text: all.slice(-lines).join('\n'), truncated: start > 0 || all.length > lines };
  } finally {
    await handle.close();
  }
}

async function listOutputs(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listOutputs(directory, path));
    else if (entry.isFile()) files.push(path);
    if (files.length >= 200) break;
  }
  return files.slice(0, 200);
}

export function hpcTools(options: HpcToolOptions): ToolSet {
  const names = Object.keys(options.jobs);
  if (!names.length) throw new Error('hpcTools needs at least one registered job.');
  for (const name of names) {
    if (!JOB_NAME.test(name)) throw new Error(`Invalid job name: ${name}`);
    if (!options.jobs[name].script || !options.jobs[name].description) throw new Error(`jobs.${name} needs a script and a description.`);
  }
  const adapter = options.adapter ?? localJobs();
  const folder = options.directory ?? 'jobs';
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(folder) || folder.split('/').some(part => part === '..' || part === '.')) throw new Error(`Invalid jobs directory: ${folder}`);
  const maxActive = options.maxActive ?? 4;
  const catalog = names.map(name => `${name}: ${options.jobs[name].description}`).join('; ');

  const base = async () => {
    const root = await realpath(resolve(options.root));
    const jobs = resolve(root, folder);
    if (!within(root, jobs)) throw new Error('The jobs directory must be inside the project.');
    return { root, jobs };
  };

  const load = async (id: string): Promise<{ record: JobRecord; directory: string }> => {
    if (!JOB_ID.test(id)) throw new Error(`Invalid jobId: ${id}`);
    const { jobs } = await base();
    const directory = join(jobs, id);
    const file = join(directory, 'job.json');
    const text = await readFile(file, 'utf8').catch(() => { throw new Error(`No job ${id}.`); });
    return { record: JSON.parse(text) as JobRecord, directory };
  };

  /** Ask the scheduler for a job that has not finished yet, and save any change. */
  const refresh = async (id: string, signal?: AbortSignal): Promise<JobRecord> => {
    const { record, directory } = await load(id);
    if (TERMINAL.has(record.status)) return record;
    const next = await adapter.status(record, directory, signal);
    if (next.status === record.status && next.exitCode === record.exitCode && next.detail === record.detail) return record;
    const now = new Date().toISOString();
    const updated: JobRecord = {
      ...record, status: next.status, updatedAt: now,
      ...(next.exitCode === undefined ? {} : { exitCode: next.exitCode }),
      ...(next.detail === undefined ? {} : { detail: next.detail }),
      ...(TERMINAL.has(next.status) ? { finishedAt: now } : {}),
    };
    await atomicJSON((await base()).root, `${record.directory}/job.json`, updated);
    return updated;
  };

  const view = async (record: JobRecord) => {
    const { root } = await base();
    const outputs = TERMINAL.has(record.status) ? await listOutputs(join(root, record.directory, 'output')) : undefined;
    return { ...record, outputDirectory: `${record.directory}/output`, ...(outputs ? { outputs } : {}) };
  };

  const listRecords = async (): Promise<string[]> => {
    const { jobs } = await base();
    return (await readdir(jobs).catch(() => [])).filter(name => JOB_ID.test(name)).sort().reverse();
  };

  return {
    submitJob: tool({
      description: `Start a registered long-running job (${adapter.name}) and return at once with its jobId. It keeps running after this turn ends. Check it later with jobStatus; read its files under outputDirectory when it has completed. Jobs: ${catalog}.`,
      inputSchema: z.object({
        job: z.enum(names as [string, ...string[]]),
        args: z.array(z.string().max(4096)).max(64).default([]).describe('Arguments passed to the job script.'),
      }),
      async execute({ job, args }, { abortSignal }) {
        if (args.some(arg => arg.includes('\0'))) throw new Error('Arguments cannot contain NUL bytes.');
        const { root, jobs } = await base();
        let active = 0;
        // Records are newest first; older ones have long finished.
        for (const id of (await listRecords()).slice(0, 50)) {
          const record = await refresh(id, abortSignal).catch(() => undefined);
          if (record && !TERMINAL.has(record.status)) active++;
        }
        if (active >= maxActive) throw new Error(`${active} jobs are still running (limit ${maxActive}). Wait for one with jobStatus or cancel one.`);

        const definition = options.jobs[job];
        const script = await realpath(resolve(root, definition.script));
        if (!within(root, script)) throw new Error(`jobs.${job}.script must be inside the project.`);
        const scriptHash = sha256(await readFile(script));
        const id = `${Date.now().toString(36).padStart(8, '0').slice(-8)}-${randomUUID().replace(/-/gu, '').slice(0, 6)}`;
        const directory = join(jobs, id);
        await mkdir(join(directory, 'output'), { recursive: true, mode: 0o700 });
        const env = {
          ...(options.env ?? process.env),
          AGENT_ROOT: root, JOB_ID: id, JOB_DIR: directory, JOB_OUTPUT_DIR: join(directory, 'output'),
        };
        const submitted = await adapter.submit({ id, script, args, cwd: root, directory, env, options: definition.sbatch ?? [], signal: abortSignal });
        const now = new Date().toISOString();
        const runId = getExecutionContext()?.runId;
        const record: JobRecord = {
          id, job, args, scheduler: adapter.name, schedulerId: submitted.schedulerId, status: submitted.status,
          submittedAt: now, updatedAt: now, directory: relative(root, directory).split(sep).join('/'),
          script: { path: relative(root, script).split(sep).join('/'), sha256: scriptHash }, ...(runId ? { runId } : {}),
        };
        await atomicJSON(root, `${record.directory}/job.json`, record);
        return { ...await view(record), note: 'Submitted. The job runs in the background; check it with jobStatus.' };
      },
    }),
    jobStatus: tool({
      description: `Status of a job started with submitJob, or of the most recent jobs when jobId is omitted. waitSeconds (≤${MAX_WAIT_SECONDS}) waits for a running job to finish before answering. A completed job lists its output files.`,
      inputSchema: z.object({
        jobId: z.string().max(40).optional(),
        waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
      }),
      async execute({ jobId, waitSeconds }, { abortSignal }) {
        if (!jobId) {
          const recent = [];
          for (const id of (await listRecords()).slice(0, 20)) recent.push(await view(await refresh(id, abortSignal)));
          return { jobs: recent };
        }
        const deadline = Date.now() + waitSeconds * 1000;
        let record = await refresh(jobId, abortSignal);
        while (!TERMINAL.has(record.status) && Date.now() < deadline) {
          await new Promise(accept => setTimeout(accept, Math.min(2000, Math.max(100, deadline - Date.now()))));
          abortSignal?.throwIfAborted();
          record = await refresh(jobId, abortSignal);
        }
        return view(record);
      },
    }),
    jobLogs: tool({
      description: 'The last lines of a job\'s stdout or stderr.',
      inputSchema: z.object({
        jobId: z.string().max(40),
        stream: z.enum(['stdout', 'stderr']).default('stdout'),
        lines: z.number().int().min(1).max(500).default(100),
      }),
      async execute({ jobId, stream, lines }) {
        const { record, directory } = await load(jobId);
        return { jobId, status: record.status, stream, ...await tail(join(directory, `${stream}.log`), lines) };
      },
    }),
    cancelJob: tool({
      description: 'Cancel a job started with submitJob.',
      inputSchema: z.object({ jobId: z.string().max(40) }),
      async execute({ jobId }, { abortSignal }) {
        const current = await refresh(jobId, abortSignal);
        if (TERMINAL.has(current.status)) return { ...await view(current), note: `Already ${current.status}.` };
        const { directory } = await load(jobId);
        await adapter.cancel(current, directory, abortSignal);
        // Give the scheduler a moment to report the cancellation.
        let record = await refresh(jobId, abortSignal);
        for (let attempt = 0; attempt < 10 && !TERMINAL.has(record.status); attempt++) {
          await new Promise(accept => setTimeout(accept, 300));
          record = await refresh(jobId, abortSignal);
        }
        return { ...await view(record), ...(TERMINAL.has(record.status) ? {} : { note: 'Cancellation requested; check again with jobStatus.' }) };
      },
    }),
  };
}

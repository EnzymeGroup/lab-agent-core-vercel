import { spawn } from 'node:child_process';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from 'lab-agent-core-vercel';

/**
 * The scheduler side of lab-agent-extras/hpc: the adapter contract, the job record, and the
 * two adapters (Slurm through its CLI, and local background processes). hpc.ts builds the tools.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export const TERMINAL = new Set<JobStatus>(['completed', 'failed', 'cancelled']);

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


import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { atomicJSON, getExecutionContext, sha256 } from 'lab-agent-core-vercel';
import { TERMINAL, localJobs, type JobAdapter, type JobRecord } from './hpc-adapters.js';

export { slurm, localJobs, type JobAdapter, type JobRecord, type JobStatus, type SlurmOptions, type SubmitSpec } from './hpc-adapters.js';

/**
 * Long-running jobs (Slurm, or local background processes) that outlive a turn.
 * submitJob returns at once with a jobId; a later step or turn checks it with jobStatus.
 * Like runPython, the model can only start job scripts registered in the config and pass
 * arguments; it never sends a shell command. Scripts are trusted code and are not sandboxed.
 *
 * Each job lives in <root>/<directory>/<jobId>/: job.json (record), stdout.log, stderr.log
 * and output/. The model can read that directory with readFile; a later task can bind it as input.
 * The scheduler adapters live in hpc-adapters.ts.
 */

export interface JobDefinition {
  /** Project-relative executable script (with a shebang). For Slurm this is the sbatch script. */
  script: string;
  description: string;
  /** Extra scheduler options from the config, e.g. ['--time=02:00:00', '--mem=16G']. Never from the model. */
  sbatch?: string[];
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

import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentConfig, CheckObservation, CheckReport, RunRecord } from './types.js';
import { acquireOperation, atomicJSON, atomicText, errorMessage, opaqueId, readJSON, storagePath } from './storage.js';
import { runCommand } from './process.js';
import { changedHashes, createProvenance, hashArtifacts, hashCode, verifyRecordedFiles, sha256 } from './provenance.js';

const fileHashSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().nonnegative() });
const observationSchema = z.object({
  id: z.string(), kind: z.enum(['initial', 'recheck']), checkedAt: z.iso.datetime(), delivery: z.enum(['not_checked', 'passed', 'partial', 'failed']),
  report: z.string().nullable(), log: z.string().nullable(), artifactHashes: z.array(fileHashSchema),
  inputChanges: z.array(z.string()), codeChanges: z.array(z.string()), artifactChanges: z.array(z.string()), validationHash: z.string().optional(),
});

const runSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  provenance: z.object({ coreVersion: z.string(), aiSdkVersion: z.string(), inputs: z.array(fileHashSchema), code: z.array(fileHashSchema),
    inputSelection: z.object({ source: z.enum(['turn', 'config', 'default']), paths: z.array(z.string()) }).optional(),
    skills: z.array(fileHashSchema.extend({ name: z.string(), loaded: z.boolean(), loadedAt: z.iso.datetime().optional() })).optional(),
    configHash: z.string(), validationHash: z.string(), artifacts: z.array(fileHashSchema) }).optional(),
  originalDelivery: observationSchema.optional(), checks: z.array(observationSchema).optional(),
  pendingCheck: z.object({ id: z.string(), startedAt: z.iso.datetime(), kind: z.enum(['initial', 'recheck']) }).optional(),
  workflowId: z.string().optional(), parentRunId: z.string().optional(),
  id: z.string(), directory: z.string(), task: z.string(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  execution: z.enum(['running', 'completed', 'failed', 'aborted']), delivery: z.enum(['not_checked', 'passed', 'partial', 'failed']),
  session: z.object({ id: z.string(), file: z.string().optional() }), model: z.object({ provider: z.string(), id: z.string() }).optional(),
  artifacts: z.array(z.string()), text: z.string().optional(), error: z.string().optional(), finishReason: z.string().optional(),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), totalTokens: z.number().optional() }).optional(),
});
const checkSchema = z.object({
  status: z.enum(['passed', 'partial', 'failed']),
  checks: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()), issues: z.array(z.string()),
});
export function runId(root: string, value: string): string {
  if (/^[A-Za-z0-9_-]{1,120}$/.test(value)) return value;
  const path = relative(resolve(root, 'runs'), isAbsolute(value) ? value : resolve(root, value));
  return opaqueId(path);
}
export async function listArtifacts(root: string, id: string): Promise<string[]> {
  const directory = await storagePath(root, `runs/${opaqueId(id)}/output`);
  const found: string[] = [];
  const visit = async (path: string, prefix: string) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Artifact symlink is not allowed: ${prefix}${entry.name}`);
      if (entry.isDirectory()) await visit(resolve(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) found.push(`output/${prefix}${entry.name}`);
    }
  };
  await visit(directory, '');
  return found.sort();
}
export function createRunStore(config: AgentConfig) {
  const root = config.root;
  const directory = async (id: string) => storagePath(root, `runs/${opaqueId(id)}`);
  const save = async (record: RunRecord) => {
    runSchema.parse(record);
    await atomicJSON(root, `runs/${opaqueId(record.id)}/run.json`, record);
  };
  const load = async (value: string): Promise<RunRecord> => {
    const id = runId(root, value);
    const record = runSchema.parse(await readJSON(root, `runs/${id}/run.json`));
    if (record.id !== id) throw new Error('Run ID does not match its record.');
    return { ...record, directory: await directory(id) };
  };
  return {
    directory, save, load,
    async create(task: string, sessionId: string, options: { workflowId?: string; parentRunId?: string; inputs?: string[] } = {}): Promise<RunRecord> {
      const { inputs, ...links } = options;
      if (links.workflowId) opaqueId(links.workflowId);
      if (links.parentRunId) opaqueId(links.parentRunId);
      const provenance = await createProvenance(config, inputs);
      const startedAt = new Date().toISOString();
      const id = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const output = await storagePath(root, `runs/${id}/output`, true);
      await mkdir(output, { mode: 0o700 });
      const model = typeof config.model === 'string' ? { provider: 'gateway', id: config.model } : { provider: config.model.provider, id: config.model.modelId };
      const record: RunRecord = { schemaVersion: 2, provenance, ...links, id, directory: await directory(id), task, startedAt, execution: 'running', delivery: 'not_checked',
        session: { id: sessionId, file: resolve(root, `.lab-agent/sessions/${sessionId}.json`) }, model, artifacts: [] };
      await save(record); return record;
    },
    async list(): Promise<{ runs: RunRecord[]; issues: string[] }> {
      const path = await storagePath(root, 'runs');
      const entries = await readdir(path, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const runs: RunRecord[] = []; const issues: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try { runs.push(await load(entry.name)); }
        catch (error) { issues.push(`${entry.name}: ${errorMessage(error)}`); }
      }
      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { runs, issues };
    },
    async report(value: string): Promise<CheckReport | null> {
      const id = runId(root, value);
      const path = await storagePath(root, `runs/${id}/check.json`);
      const info = await lstat(path).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!info) return null;
      return checkSchema.parse(await readJSON(root, `runs/${id}/check.json`));
    },
  };
}
export async function checkRunUnlocked(config: AgentConfig, value: string, signal?: AbortSignal, options: { initial?: boolean } = {}): Promise<RunRecord> {
  const store = createRunStore(config);
  const run = await store.load(value);
  if (run.execution === 'running') throw new Error('A running task cannot be rechecked.');
  if (run.pendingCheck) await interruptCheckUnlocked(config, run);
  const directory = await storagePath(config.root, `runs/${run.id}`);
  const check = resolve(directory, 'check.json');
  const log = resolve(directory, 'validation.log');
  run.pendingCheck = { id: randomUUID(), startedAt: new Date().toISOString(), kind: options.initial ? 'initial' : 'recheck' };
  // A terminated recheck must never leave its previous verdict as current.
  run.delivery = 'not_checked';
  await store.save(run);
  let artifactHashes: CheckObservation['artifactHashes'] = [];
  let inputChanges: string[] = [];
  let codeChanges: string[] = [];
  let validationHash: string | undefined;
  const evidence = async (report: CheckReport | null, logText: string) => {
    const id = run.pendingCheck!.id;
    const prefix = `checks/${id}`;
    const observation: CheckObservation = { id, kind: options.initial ? 'initial' : 'recheck', checkedAt: new Date().toISOString(),
      delivery: run.delivery, report: report ? `${prefix}/check.json` : null, log: report ? `${prefix}/validation.log` : null,
      artifactHashes, inputChanges, codeChanges, artifactChanges: run.provenance ? changedHashes(run.provenance.artifacts, artifactHashes) : [], validationHash };
    if (report) {
      await atomicJSON(config.root, `runs/${run.id}/${observation.report}`, report);
      await atomicText(config.root, `runs/${run.id}/${observation.log}`, logText);
    }
    run.checks = [...(run.checks ?? []), observation];
    if (options.initial && !run.originalDelivery) run.originalDelivery = observation;
    delete run.pendingCheck;
    await store.save(run);
    return run;
  };
  let listed = false;
  try {
    run.artifacts = await listArtifacts(config.root, run.id);
    listed = true;
    artifactHashes = await hashArtifacts(config.root, run.id, run.artifacts);
    if (run.provenance) {
      inputChanges = (await verifyRecordedFiles(config.root, run.provenance.inputs)).changes;
      const code = await hashCode(config);
      codeChanges = changedHashes(run.provenance.code, code);
      codeChanges.push(...(await verifyRecordedFiles(config.root, (run.provenance.skills ?? []).filter(skill => skill.loaded))).changes);
      validationHash = sha256(JSON.stringify({ command: config.validation?.command, code }));
      if (validationHash !== run.provenance.validationHash && !codeChanges.length) codeChanges.push('validation configuration');
      if (inputChanges.length || codeChanges.length) throw new Error(`Provenance changed since execution: ${[...inputChanges, ...codeChanges].join(', ')}`);
    }
  }
  catch (error) {
    const report: CheckReport = { status: 'failed', checks: [], issues: [`Artifact integrity: ${errorMessage(error)}`] };
    if (!listed) run.artifacts = [];
    run.delivery = 'failed';
    await rm(check, { force: true, recursive: true });
    await atomicJSON(config.root, `runs/${run.id}/check.json`, report);
    await rm(log, { force: true, recursive: true });
    await atomicText(config.root, `runs/${run.id}/validation.log`, `${report.issues.join('\n')}\n`);
    return evidence(report, report.issues.join('\n'));
  }
  if (!config.validation) {
    run.delivery = 'not_checked'; return evidence(null, '');
  }
  await rm(check, { force: true, recursive: true });
  await rm(log, { force: true, recursive: true });
  await atomicText(config.root, `runs/${run.id}/validation.log`, '');
  let report: CheckReport;
  let logText = '';
  try {
    const [command, ...args] = config.validation.command;
    const result = await runCommand(command, args, { cwd: config.root, signal, timeoutMs: config.validation.timeoutMs ?? 120_000,
      maxOutputBytes: config.limits?.maxToolOutputBytes ?? 1_048_576,
      env: { ...config.env, AGENT_ROOT: config.root, AGENT_RUN_ID: run.id, AGENT_RUN_DIR: run.directory, AGENT_OUTPUT_DIR: resolve(run.directory, 'output'), AGENT_CHECK_FILE: check } });
    logText = `${result.stdout}${result.stderr}`;
    if (result.code !== 0) throw new Error(`Checker exited ${result.code}. See validation.log.`);
    // A checker can write a report, but cannot redirect the host to another file.
    await storagePath(config.root, `runs/${run.id}/check.json`);
    const handle = await open(check, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1_048_576) throw new Error('Checker report must be a regular file no larger than 1 MiB.');
      const buffer = Buffer.alloc(1_048_577); let length = 0;
      for (;;) {
        const result = await handle.read(buffer, length, buffer.length - length); length += result.bytesRead;
        if (length > 1_048_576) throw new Error('Checker report exceeds 1 MiB.');
        if (!result.bytesRead) break;
      }
      raw = buffer.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
    report = checkSchema.parse(JSON.parse(raw));
  } catch (error) {
    const message = errorMessage(error);
    report = { status: 'failed', checks: [], issues: [message] };
    // Remove checker-created symlinks before writing a host-owned failure report.
    await rm(check, { force: true, recursive: true });
    await atomicJSON(config.root, `runs/${run.id}/check.json`, report);
    const partial = error as { stdout?: string; stderr?: string };
    logText += `${partial.stdout ?? ''}${partial.stderr ?? ''}\n${message}\n`;
  }
  // Checkers can modify files even when exiting nonzero or writing bad JSON.
  // Persist hashes of the actual final state on every completion path.
  try {
    const finalArtifacts = await listArtifacts(config.root, run.id);
    const finalHashes = await hashArtifacts(config.root, run.id, finalArtifacts);
    const changedDuringCheck = changedHashes(artifactHashes, finalHashes);
    run.artifacts = finalArtifacts; artifactHashes = finalHashes;
    if (run.provenance) {
      inputChanges = (await verifyRecordedFiles(config.root, run.provenance.inputs)).changes;
      codeChanges = changedHashes(run.provenance.code, await hashCode(config));
      codeChanges.push(...(await verifyRecordedFiles(config.root, (run.provenance.skills ?? []).filter(skill => skill.loaded))).changes);
    }
    if (changedDuringCheck.length || inputChanges.length || codeChanges.length) {
      report = { ...report, status: 'failed', issues: [...report.issues, `Files changed during validation: ${[...changedDuringCheck, ...inputChanges, ...codeChanges].join(', ')}`] };
    }
  } catch (error) {
    artifactHashes = []; run.artifacts = [];
    report = { ...report, status: 'failed', issues: [...report.issues, `Final integrity: ${errorMessage(error)}`] };
  }
  await rm(check, { force: true, recursive: true });
  await atomicJSON(config.root, `runs/${run.id}/check.json`, report);
  await rm(log, { force: true, recursive: true });
  await atomicText(config.root, `runs/${run.id}/validation.log`, logText);
  run.delivery = report.status;
  return evidence(report, logText);
}
/** Recover interrupted validation without rerunning its program or model. */
export async function interruptCheckUnlocked(config: AgentConfig, run: RunRecord): Promise<void> {
  if (!run.pendingCheck) return;
  const pending = run.pendingCheck;
  const report: CheckReport = { status: 'failed', checks: [], issues: ['Previous process ended before delivery checking finished. Validation was not replayed.'] };
  const prefix = `checks/${opaqueId(pending.id)}`;
  const observation: CheckObservation = { id: pending.id, kind: pending.kind, checkedAt: new Date().toISOString(), delivery: 'failed',
    report: `${prefix}/check.json`, log: `${prefix}/validation.log`, artifactHashes: [], inputChanges: [], codeChanges: [], artifactChanges: [] };
  const directory = await storagePath(config.root, `runs/${run.id}`);
  for (const name of ['check.json', 'validation.log']) await rm(resolve(directory, name), { force: true, recursive: true });
  await atomicJSON(config.root, `runs/${run.id}/check.json`, report);
  await atomicText(config.root, `runs/${run.id}/validation.log`, `${report.issues[0]}\n`);
  await atomicJSON(config.root, `runs/${run.id}/${observation.report}`, report);
  await atomicText(config.root, `runs/${run.id}/${observation.log}`, `${report.issues[0]}\n`);
  run.delivery = 'failed'; run.checks = [...(run.checks ?? []), observation];
  if (pending.kind === 'initial' && !run.originalDelivery) run.originalDelivery = observation;
  delete run.pendingCheck;
  await createRunStore(config).save(run);
}
export async function checkRun(config: AgentConfig, value: string, options: { signal?: AbortSignal } = {}): Promise<RunRecord> {
  const release = await acquireOperation(config.root);
  try { return await checkRunUnlocked(config, value, options.signal); }
  finally { await release(); }
}

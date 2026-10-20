import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { errorMessage } from '../errors.js';
import { acquireOperation } from '../store/lock.js';
import { atomicJSON, atomicText, opaqueId, storagePath } from '../store/files.js';
import { runCommand } from '../workspace/process.js';
import { changedHashes, hashArtifacts, hashCode, validationHash, verifyRecordedFiles } from './provenance.js';
import { checkReportSchema, createRunStore, listArtifacts } from './store.js';
import type { AgentConfig, CheckObservation, CheckReport, FileHash, RunRecord } from '../types.js';

/**
 * Delivery checking, independent of the model:
 *
 *   1. preflight  – artifacts are listable and inputs/code still match the run's baseline
 *   2. checker    – run validation.command (argv, no shell); it writes AGENT_CHECK_FILE
 *   3. final      – rehash everything; a checker that modified files fails
 *
 * Each check appends an immutable observation under checks/<id>/. originalDelivery
 * keeps the first automatic observation forever. A recheck makes no model call.
 */

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_REPORT_BYTES = 1_048_576;

const failed = (issues: string[]): CheckReport => ({ status: 'failed', checks: [], issues });

/** Remove whatever the checker left (possibly a symlink) and write host-owned latest views. */
async function writeLatest(root: string, run: RunRecord, report: CheckReport, log: string): Promise<void> {
  const directory = await storagePath(root, `runs/${run.id}`);
  await rm(resolve(directory, 'check.json'), { force: true, recursive: true });
  await atomicJSON(root, `runs/${run.id}/check.json`, report);
  await rm(resolve(directory, 'validation.log'), { force: true, recursive: true });
  await atomicText(root, `runs/${run.id}/validation.log`, log);
}

/** A checker can write a report, but cannot redirect the host to another file. */
async function readCheckerReport(root: string, run: RunRecord, file: string): Promise<CheckReport> {
  await storagePath(root, `runs/${run.id}/check.json`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error('Checker report must be a regular file no larger than 1 MiB.');
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    for (;;) {
      const chunk = await handle.read(buffer, length, buffer.length - length);
      length += chunk.bytesRead;
      if (length > MAX_REPORT_BYTES) throw new Error('Checker report exceeds 1 MiB.');
      if (!chunk.bytesRead) break;
    }
    return checkReportSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } finally {
    await handle.close();
  }
}

/** Input, code and used-Skill files that changed since the run's baseline. */
async function baselineChanges(config: AgentConfig, run: RunRecord) {
  if (!run.provenance) return { inputChanges: [], codeChanges: [], code: undefined };
  const inputChanges = (await verifyRecordedFiles(config.root, run.provenance.inputs)).changes;
  const code = await hashCode(config);
  const usedSkills = (run.provenance.skills ?? []).filter(skill => skill.loaded);
  const codeChanges = [
    ...changedHashes(run.provenance.code, code),
    ...(await verifyRecordedFiles(config.root, usedSkills)).changes,
  ];
  return { inputChanges, codeChanges, code };
}

/** Run the configured checker. The caller must hold the project operation lock. */
export async function checkRunUnlocked(config: AgentConfig, value: string, signal?: AbortSignal, options: { kind?: CheckObservation['kind'] } = {}): Promise<RunRecord> {
  const store = createRunStore(config);
  const run = await store.load(value);
  if (run.execution === 'running' || run.execution === 'awaiting_approval') throw new Error('A running task cannot be rechecked.');
  if (run.pendingCheck) await interruptCheckUnlocked(config, run);
  const kind = options.kind ?? 'recheck';
  const checkFile = resolve(await storagePath(config.root, `runs/${run.id}`), 'check.json');

  // A terminated check must never leave its previous verdict as current.
  run.pendingCheck = { id: randomUUID(), startedAt: new Date().toISOString(), kind };
  run.delivery = 'not_checked';
  await store.save(run);

  let artifactHashes: FileHash[] = [];
  let inputChanges: string[] = [];
  let codeChanges: string[] = [];
  let observedValidationHash: string | undefined;

  const record = async (report: CheckReport | null, log: string): Promise<RunRecord> => {
    const id = run.pendingCheck!.id;
    const prefix = `checks/${id}`;
    const observation: CheckObservation = {
      id, kind, checkedAt: new Date().toISOString(), delivery: run.delivery,
      report: report ? `${prefix}/check.json` : null, log: report ? `${prefix}/validation.log` : null,
      artifactHashes, inputChanges, codeChanges,
      artifactChanges: run.provenance ? changedHashes(run.provenance.artifacts, artifactHashes) : [],
      validationHash: observedValidationHash,
    };
    if (report) {
      await atomicJSON(config.root, `runs/${run.id}/${observation.report}`, report);
      await atomicText(config.root, `runs/${run.id}/${observation.log}`, log);
    }
    run.checks = [...(run.checks ?? []), observation];
    if (kind === 'initial' && !run.originalDelivery) run.originalDelivery = observation;
    delete run.pendingCheck;
    await store.save(run);
    return run;
  };

  // 1. Preflight: changed inputs/code fail before the checker can run against them.
  let listed = false;
  try {
    run.artifacts = await listArtifacts(config.root, run.id);
    listed = true;
    artifactHashes = await hashArtifacts(config.root, run.id, run.artifacts);
    if (run.provenance) {
      const changes = await baselineChanges(config, run);
      ({ inputChanges, codeChanges } = changes);
      observedValidationHash = validationHash(config, changes.code!);
      if (observedValidationHash !== run.provenance.validationHash && !codeChanges.length) codeChanges.push('validation configuration');
      if (inputChanges.length || codeChanges.length) throw new Error(`Provenance changed since execution: ${[...inputChanges, ...codeChanges].join(', ')}`);
    }
  } catch (error) {
    if (!listed) run.artifacts = [];
    const report = failed([`Artifact integrity: ${errorMessage(error)}`]);
    run.delivery = 'failed';
    await writeLatest(config.root, run, report, `${report.issues.join('\n')}\n`);
    return record(report, report.issues.join('\n'));
  }

  if (!config.validation) {
    run.delivery = 'not_checked';
    return record(null, '');
  }

  // 2. Checker. Any nonzero exit, timeout or malformed report is a failed delivery.
  // Clear the latest views so a stale report can never be read back as this checker's output.
  await rm(checkFile, { force: true, recursive: true });
  await rm(resolve(run.directory, 'validation.log'), { force: true, recursive: true });
  await atomicText(config.root, `runs/${run.id}/validation.log`, '');
  let report: CheckReport;
  let log = '';
  try {
    const [command, ...args] = config.validation.command;
    const result = await runCommand(command, args, {
      cwd: config.root, signal,
      timeoutMs: config.validation.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      maxOutputBytes: config.limits?.maxToolOutputBytes ?? MAX_REPORT_BYTES,
      env: {
        ...config.env, AGENT_ROOT: config.root, AGENT_RUN_ID: run.id, AGENT_RUN_DIR: run.directory,
        AGENT_OUTPUT_DIR: resolve(run.directory, 'output'), AGENT_CHECK_FILE: checkFile,
      },
    });
    log = `${result.stdout}${result.stderr}`;
    if (result.code !== 0) throw new Error(`Checker exited ${result.code}. See validation.log.`);
    report = await readCheckerReport(config.root, run, checkFile);
  } catch (error) {
    const message = errorMessage(error);
    const partial = error as { stdout?: string; stderr?: string };
    report = failed([message]);
    log += `${partial.stdout ?? ''}${partial.stderr ?? ''}\n${message}\n`;
  }

  // 3. Final integrity. Checkers can modify files even when exiting nonzero or writing bad JSON.
  try {
    const finalArtifacts = await listArtifacts(config.root, run.id);
    const finalHashes = await hashArtifacts(config.root, run.id, finalArtifacts);
    const changedDuringCheck = changedHashes(artifactHashes, finalHashes);
    run.artifacts = finalArtifacts;
    artifactHashes = finalHashes;
    ({ inputChanges, codeChanges } = await baselineChanges(config, run));
    const changed = [...changedDuringCheck, ...inputChanges, ...codeChanges];
    if (changed.length) report = { ...report, status: 'failed', issues: [...report.issues, `Files changed during validation: ${changed.join(', ')}`] };
  } catch (error) {
    artifactHashes = [];
    run.artifacts = [];
    report = { ...report, status: 'failed', issues: [...report.issues, `Final integrity: ${errorMessage(error)}`] };
  }

  await writeLatest(config.root, run, report, log);
  run.delivery = report.status;
  return record(report, log);
}

/** Record an interrupted check as failed without rerunning its program or model. */
export async function interruptCheckUnlocked(config: AgentConfig, run: RunRecord): Promise<void> {
  if (!run.pendingCheck) return;
  const pending = run.pendingCheck;
  const report = failed(['Previous process ended before delivery checking finished. Validation was not replayed.']);
  const prefix = `checks/${opaqueId(pending.id)}`;
  const observation: CheckObservation = {
    id: pending.id, kind: pending.kind, checkedAt: new Date().toISOString(), delivery: 'failed',
    report: `${prefix}/check.json`, log: `${prefix}/validation.log`,
    artifactHashes: [], inputChanges: [], codeChanges: [], artifactChanges: [],
  };
  const log = `${report.issues[0]}\n`;
  await writeLatest(config.root, run, report, log);
  await atomicJSON(config.root, `runs/${run.id}/${observation.report}`, report);
  await atomicText(config.root, `runs/${run.id}/${observation.log}`, log);
  run.delivery = 'failed';
  run.checks = [...(run.checks ?? []), observation];
  if (pending.kind === 'initial' && !run.originalDelivery) run.originalDelivery = observation;
  delete run.pendingCheck;
  await createRunStore(config).save(run);
}

/** Standalone recheck (CLI `lab-agent check`). Acquires the project lock itself. */
export async function checkRun(config: AgentConfig, value: string, options: { signal?: AbortSignal } = {}): Promise<RunRecord> {
  const release = await acquireOperation(config.root);
  try {
    return await checkRunUnlocked(config, value, options.signal);
  } finally {
    await release();
  }
}

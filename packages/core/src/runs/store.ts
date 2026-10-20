import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { errorMessage } from '../errors.js';
import { modelInfo } from '../config/models.js';
import { atomicJSON, ifExists, isOpaqueId, opaqueId, readDirectory, readJSON, storagePath } from '../store/files.js';
import { createProvenance } from './provenance.js';
import type { AgentConfig, CheckReport, RunRecord } from '../types.js';

/**
 * runs/<id>/
 *   run.json         RunRecord (execution + delivery + provenance)
 *   output/          files the task produced
 *   check.json       latest checker report (convenience view)
 *   validation.log   latest checker output (convenience view)
 *   checks/<obs>/    immutable snapshot of every check
 */

const RUN_SCHEMA_VERSION = 2;

const fileHashSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().nonnegative() });
const deliverySchema = z.enum(['not_checked', 'passed', 'partial', 'failed']);
const checkKindSchema = z.enum(['initial', 'repair', 'recheck']);
const usageSchema = z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), totalTokens: z.number().optional(), cachedInputTokens: z.number().optional() });
const stepSchema = z.object({
  agent: z.string(), model: z.string(), finishReason: z.string(), usage: usageSchema, ms: z.number(),
  tools: z.array(z.object({ name: z.string(), ms: z.number().optional(), error: z.boolean().optional() })),
});

const observationSchema = z.object({
  id: z.string(), kind: checkKindSchema, checkedAt: z.iso.datetime(), delivery: deliverySchema,
  report: z.string().nullable(), log: z.string().nullable(), artifactHashes: z.array(fileHashSchema),
  inputChanges: z.array(z.string()), codeChanges: z.array(z.string()), artifactChanges: z.array(z.string()),
  validationHash: z.string().optional(),
});

const provenanceSchema = z.object({
  coreVersion: z.string(), aiSdkVersion: z.string(),
  environment: z.object({ node: z.string(), platform: z.string(), arch: z.string(), python: z.string().optional(), conda: z.string().optional() }).optional(),
  inputs: z.array(fileHashSchema), code: z.array(fileHashSchema), artifacts: z.array(fileHashSchema),
  inputSelection: z.object({ source: z.enum(['turn', 'config', 'default']), paths: z.array(z.string()) }).optional(),
  skills: z.array(fileHashSchema.extend({ name: z.string(), loaded: z.boolean(), loadedAt: z.iso.datetime().optional() })).optional(),
  memory: z.array(z.object({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), updatedAt: z.iso.datetime() })).optional(),
  attachments: z.array(fileHashSchema).optional(),
  toolSettings: z.object({ disabled: z.array(z.string()), alwaysAllow: z.array(z.string()) }).optional(),
  configHash: z.string(), validationHash: z.string(),
});

const runSchema = z.object({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION).optional(),
  id: z.string(), directory: z.string(), task: z.string(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  execution: z.enum(['running', 'awaiting_approval', 'completed', 'failed', 'aborted']), delivery: deliverySchema,
  session: z.object({ id: z.string(), file: z.string().optional() }),
  model: z.object({ provider: z.string(), id: z.string(), key: z.string().optional() }).optional(),
  artifacts: z.array(z.string()), text: z.string().optional(), error: z.string().optional(), finishReason: z.string().optional(),
  usage: usageSchema.optional(), costUsd: z.number().optional(), steps: z.array(stepSchema).optional(), repairs: z.number().int().optional(),
  provenance: provenanceSchema.optional(),
  originalDelivery: observationSchema.optional(), checks: z.array(observationSchema).optional(),
  pendingCheck: z.object({ id: z.string(), startedAt: z.iso.datetime(), kind: checkKindSchema }).optional(),
  workflowId: z.string().optional(), parentRunId: z.string().optional(),
});

export const checkReportSchema = z.object({
  status: z.enum(['passed', 'partial', 'failed']),
  checks: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()),
  issues: z.array(z.string()),
});

/** Accept a bare run ID or a path such as runs/<id>. */
export function runId(root: string, value: string): string {
  if (isOpaqueId(value)) return value;
  return opaqueId(relative(resolve(root, 'runs'), isAbsolute(value) ? value : resolve(root, value)));
}

/** Every regular file under runs/<id>/output, as sorted `output/...` paths. Symlinks are rejected. */
export async function listArtifacts(root: string, id: string): Promise<string[]> {
  const directory = await storagePath(root, `runs/${opaqueId(id)}/output`);
  const found: string[] = [];
  const visit = async (path: string, prefix: string) => {
    const entries = (await ifExists(readdir(path, { withFileTypes: true }))) ?? [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Artifact symlink is not allowed: ${prefix}${entry.name}`);
      if (entry.isDirectory()) await visit(resolve(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) found.push(`output/${prefix}${entry.name}`);
    }
  };
  await visit(directory, '');
  return found.sort();
}

export type RunStore = ReturnType<typeof createRunStore>;

export function createRunStore(config: AgentConfig) {
  const root = config.root;
  const directory = (id: string) => storagePath(root, `runs/${opaqueId(id)}`);

  async function save(record: RunRecord): Promise<void> {
    runSchema.parse(record);
    await atomicJSON(root, `runs/${opaqueId(record.id)}/run.json`, record);
  }

  async function load(value: string): Promise<RunRecord> {
    const id = runId(root, value);
    const record = runSchema.parse(await readJSON(root, `runs/${id}/run.json`));
    if (record.id !== id) throw new Error('Run ID does not match its record.');
    return { ...record, directory: await directory(id) };
  }

  async function create(task: string, sessionId: string, options: { workflowId?: string; parentRunId?: string; inputs?: string[]; model?: RunRecord['model'] } = {}): Promise<RunRecord> {
    const { inputs, model, ...links } = options;
    if (links.workflowId) opaqueId(links.workflowId);
    if (links.parentRunId) opaqueId(links.parentRunId);
    const provenance = await createProvenance(config, inputs);
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    await mkdir(await storagePath(root, `runs/${id}/output`, true), { mode: 0o700 });
    const record: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION, provenance, ...links,
      id, directory: await directory(id), task, startedAt, execution: 'running', delivery: 'not_checked',
      session: { id: sessionId, file: resolve(root, `.lab-agent/sessions/${sessionId}.json`) },
      model: model ?? { ...modelInfo(config.model), key: 'default' }, artifacts: [],
    };
    await save(record);
    return record;
  }

  /** Newest first. Unreadable records are reported as issues. */
  async function list(): Promise<{ runs: RunRecord[]; issues: string[] }> {
    const runs: RunRecord[] = [];
    const issues: string[] = [];
    for (const entry of await readDirectory(root, 'runs')) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        runs.push(await load(entry.name));
      } catch (error) {
        issues.push(`${entry.name}: ${errorMessage(error)}`);
      }
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { runs, issues };
  }

  /** The latest check.json, or null when the run was never checked. */
  async function report(value: string): Promise<CheckReport | null> {
    const id = runId(root, value);
    const info = await ifExists(lstat(await storagePath(root, `runs/${id}/check.json`)));
    if (!info) return null;
    return checkReportSchema.parse(await readJSON(root, `runs/${id}/check.json`));
  }

  return { directory, save, load, create, list, report };
}

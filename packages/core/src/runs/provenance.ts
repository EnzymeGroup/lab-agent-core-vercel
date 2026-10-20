import { lstat, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { InputError } from '../errors.js';
import { modelInfo } from '../config/models.js';
import { ifExists, projectPath, storagePath, within } from '../store/files.js';
import { hashFile, sha256 } from '../store/hash.js';
import type { AgentConfig, FileHash, RunProvenance } from '../types.js';

/**
 * Provenance is a byte-level baseline: which inputs, code and outputs a run saw.
 * Hashes establish identity, not correctness.
 */

const require = createRequire(import.meta.url);
const MAX_INPUT_DECLARATIONS = 256;
const MAX_INPUT_FILES = 4096;
/** Never fingerprinted when walking an input directory. */
const SKIPPED_INPUT_NAMES = new Set(['.git', '.lab-agent', '.ssh', '.aws', '.gnupg', '.direnv']);

export function validInputList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_INPUT_DECLARATIONS
    && value.every(file => typeof file === 'string' && !!file.trim() && !file.includes('\0'));
}

/** Expand declared files/directories into a sorted, deduplicated file list. */
async function enumerateInputs(root: string, declared: string[], optional: boolean): Promise<string[]> {
  const files = new Set<string>();
  const visit = async (file: string, allowMissing: boolean): Promise<void> => {
    const path = await storagePath(root, file);
    const info = allowMissing ? await ifExists(lstat(path)) : await lstat(path);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Input symlinks cannot be fingerprinted: ${file}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name.startsWith('.env') || SKIPPED_INPUT_NAMES.has(name) || /\.(pem|key|p12|pfx)$/iu.test(name)) continue;
        await visit(relative(root, resolve(path, name)), false);
      }
    } else if (info.isFile()) {
      files.add(projectPath(root, path));
    } else {
      throw new Error(`Input must be a regular file or directory: ${file}`);
    }
    if (files.size > MAX_INPUT_FILES) throw new Error('Input fingerprinting exceeds 4096 files. Configure provenance.inputs to select the task inputs.');
  };
  for (const file of declared) await visit(file, optional);
  return [...files].sort();
}

/**
 * Freeze this task's inputs: explicit turn selection, else config, else data/.
 * Explicit selections report InputError so callers see a 400, not a 500.
 */
export async function hashInputs(config: AgentConfig, selected?: string[]): Promise<FileHash[]> {
  const declared = selected ?? config.provenance?.inputs;
  if (declared !== undefined && !validInputList(declared)) throw new InputError('Task inputs must be an array of at most 256 nonempty project paths.');
  const asInputError = (prefix: string) => (error: unknown) => {
    if (selected === undefined) throw error;
    throw new InputError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const files = await enumerateInputs(config.root, declared ?? ['data'], declared === undefined).catch(asInputError('Cannot bind task inputs'));
  const hashes: FileHash[] = [];
  for (const file of files) hashes.push(await hashFile(config.root, file).catch(asInputError(`Cannot bind task input ${file}`)));
  return hashes;
}

/** Recheck exactly the frozen file set. New project files are unrelated to old runs. */
export async function verifyRecordedFiles(root: string, baseline: FileHash[]): Promise<{ hashes: FileHash[]; changes: string[] }> {
  const hashes: FileHash[] = [];
  const changes: string[] = [];
  for (const original of baseline) {
    try {
      const current = await hashFile(root, original.path);
      hashes.push(current);
      if (current.sha256 !== original.sha256 || current.bytes !== original.bytes) changes.push(original.path);
    } catch {
      changes.push(original.path);
    }
  }
  return { hashes, changes };
}

/** Config, instructions, registered scripts, local checker argv files and explicit provenance.code. */
export async function hashCode(config: AgentConfig): Promise<FileHash[]> {
  const required = new Set(config.provenance?.code ?? []);
  const candidates = new Set<string>(['agent.config.ts', 'agent.config.json', ...required]);
  if (typeof config.instructions !== 'object') candidates.add(config.instructions ?? 'AGENTS.md');
  for (const script of Object.values(config.python?.scripts ?? {})) candidates.add(script.path);
  for (const part of config.validation?.command ?? []) {
    if (part && within(config.root, resolve(config.root, part))) candidates.add(part);
  }
  const hashes: FileHash[] = [];
  for (const file of [...candidates].sort()) {
    const path = await storagePath(config.root, file);
    const info = await lstat(path).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENAMETOOLONG') return undefined;
      throw error;
    });
    if (required.has(file) && (!info || !info.isFile())) throw new Error(`provenance.code must select an existing regular file: ${file}`);
    if (info?.isFile() || info?.isSymbolicLink()) hashes.push(await hashFile(config.root, file));
  }
  return hashes;
}

export const validationHash = (config: AgentConfig, code: FileHash[]) => sha256(JSON.stringify({ command: config.validation?.command, code }));

async function packageVersion(file: string | URL): Promise<string> {
  return JSON.parse(await readFile(file, 'utf8')).version;
}

export async function createProvenance(config: AgentConfig, inputs?: string[]): Promise<RunProvenance> {
  const code = await hashCode(config);
  const source = inputs !== undefined ? 'turn' : config.provenance?.inputs !== undefined ? 'config' : 'default';
  return {
    coreVersion: await packageVersion(new URL('../../package.json', import.meta.url)),
    aiSdkVersion: await packageVersion(resolve(dirname(require.resolve('ai')), '../package.json')),
    inputs: await hashInputs(config, inputs),
    inputSelection: { source, paths: inputs ?? config.provenance?.inputs ?? ['data'] },
    code,
    validationHash: validationHash(config, code),
    // ui is presentation-only and deliberately excluded.
    configHash: sha256(JSON.stringify({
      code, model: modelInfo(config.model), models: Object.fromEntries(Object.entries(config.models ?? {}).map(([key, model]) => [key, modelInfo(model)])), instructions: config.instructions, python: config.python,
      validation: config.validation, fileAccess: config.fileAccess, limits: config.limits, skillsDir: config.skillsDir,
      tools: Object.keys(config.tools ?? {}).sort(), prepareStep: config.prepareStep?.toString(),
    })),
    artifacts: [],
  };
}

export async function hashArtifacts(root: string, id: string, artifacts: string[]): Promise<FileHash[]> {
  const directory = await storagePath(root, `runs/${id}`);
  const result: FileHash[] = [];
  for (const file of artifacts) {
    if (!file.startsWith('output/') || !within(resolve(directory, 'output'), resolve(directory, file))) throw new Error('Artifact escapes its run output.');
    result.push(await hashFile(directory, file));
  }
  return result;
}

/** Paths whose hash differs, including added and deleted files. */
export function changedHashes(before: FileHash[], after: FileHash[]): string[] {
  const previous = new Map(before.map(file => [file.path, file.sha256]));
  const current = new Map(after.map(file => [file.path, file.sha256]));
  return [...new Set([...previous.keys(), ...current.keys()])].filter(file => previous.get(file) !== current.get(file)).sort();
}

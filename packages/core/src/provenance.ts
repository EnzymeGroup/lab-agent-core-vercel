import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import type { AgentConfig, FileHash, RunProvenance } from './types.js';
import { storagePath, within } from './storage.js';

const require = createRequire(import.meta.url);
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Stream bytes from a regular, unaliased file; never load datasets into RAM. */
export async function hashFile(root: string, file: string): Promise<FileHash> {
  const path = await storagePath(root, file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1) throw new Error(`Hash source must be an unaliased regular file: ${file}`);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const part = await handle.read(buffer, 0, buffer.length);
      if (!part.bytesRead) break;
      digest.update(buffer.subarray(0, part.bytesRead)); bytes += part.bytesRead;
    }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`File changed while hashing: ${file}`);
    }
    return { path: relative(root, path).split('\\').join('/'), sha256: digest.digest('hex'), bytes };
  } finally { await handle.close(); }
}

/** Configured files/directories, or data/ by convention; no implicit home scan. */
export async function hashInputs(config: AgentConfig): Promise<FileHash[]> {
  const files = new Set<string>();
  const visit = async (file: string, optional = false): Promise<void> => {
    const path = await storagePath(config.root, file);
    const info = await lstat(path).catch(error => {
      if (optional && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Input symlinks cannot be fingerprinted: ${file}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name.startsWith('.') || /\.(pem|key|p12|pfx)$/iu.test(name)) continue;
        await visit(relative(config.root, resolve(path, name)));
      }
    } else if (info.isFile()) files.add(file);
    else throw new Error(`Input must be a regular file or directory: ${file}`);
    if (files.size > 4096) throw new Error('Input fingerprinting exceeds 4096 files. Configure provenance.inputs to select the task inputs.');
  };
  for (const file of config.provenance?.inputs ?? ['data']) await visit(file, config.provenance?.inputs === undefined);
  const hashes: FileHash[] = [];
  for (const file of [...files].sort()) hashes.push(await hashFile(config.root, file));
  return hashes;
}

export async function hashCode(config: AgentConfig): Promise<FileHash[]> {
  const required = new Set(config.provenance?.code ?? []);
  const candidates = new Set<string>(['agent.config.ts', 'agent.config.json', ...(config.provenance?.code ?? [])]);
  if (typeof config.instructions !== 'object') candidates.add(config.instructions ?? 'AGENTS.md');
  for (const script of Object.values(config.python?.scripts ?? {})) candidates.add(script.path);
  for (const part of config.validation?.command ?? []) {
    if (part && within(config.root, resolve(config.root, part))) candidates.add(part);
  }
  const hashes: FileHash[] = [];
  for (const file of [...candidates].sort()) {
    const path = await storagePath(config.root, file);
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENAMETOOLONG') return undefined; throw error; });
    if (required.has(file) && (!info || !info.isFile())) throw new Error(`provenance.code must select an existing regular file: ${file}`);
    if (info?.isFile() || info?.isSymbolicLink()) hashes.push(await hashFile(config.root, file));
  }
  return hashes;
}

export async function createProvenance(config: AgentConfig): Promise<RunProvenance> {
  const core = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const ai = JSON.parse(await readFile(resolve(dirname(require.resolve('ai')), '../package.json'), 'utf8'));
  const code = await hashCode(config);
  const model = typeof config.model === 'string' ? config.model : { provider: config.model.provider, id: config.model.modelId };
  return { coreVersion: core.version, aiSdkVersion: ai.version, inputs: await hashInputs(config), code,
    validationHash: sha256(JSON.stringify({ command: config.validation?.command, code })),
    configHash: sha256(JSON.stringify({ code, model, instructions: config.instructions, python: config.python,
      validation: config.validation, fileAccess: config.fileAccess, limits: config.limits, skillsDir: config.skillsDir,
      tools: Object.keys(config.tools ?? {}).sort(), prepareStep: config.prepareStep?.toString() })), artifacts: [] };
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

/** Differences include deleted/added files; old records with no baseline stay unknown. */
export function changedHashes(before: FileHash[], after: FileHash[]): string[] {
  const previous = new Map(before.map(file => [file.path, file.sha256]));
  const current = new Map(after.map(file => [file.path, file.sha256]));
  return [...new Set([...previous.keys(), ...current.keys()])].filter(file => previous.get(file) !== current.get(file)).sort();
}

import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Skill, SkillFingerprint } from './types.js';
import { getExecutionContext, type Workspace } from './workspace.js';
import { hashFile, sha256 } from './provenance.js';

async function frontmatter(workspace: Workspace, file: string): Promise<Record<string, unknown>> {
  const candidate = await workspace.resolve(file, { readRoots: false });
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) throw new Error(`Skill must be a regular file without hard links: ${file}`);
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/u, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
    if (!match) throw new Error(`Skill needs YAML frontmatter within its first 64 KiB: ${file}`);
    const data: unknown = parse(match[1], { uniqueKeys: true, maxAliasCount: 20 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Invalid skill frontmatter: ${file}`);
    return data as Record<string, unknown>;
  } finally { await handle.close(); }
}

/** Only name/description/path are retained; full instructions load on demand. */
export async function discoverSkills(workspace: Workspace, skillsDir = '.agents/skills'): Promise<Skill[]> {
  let entries;
  try { entries = await workspace.list(skillsDir, { readRoots: false }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const skills: Skill[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('.') || (entry.type !== 'directory' && entry.type !== 'symlink')) continue;
    const file = path.posix.join(skillsDir.split(path.sep).join('/'), entry.name, 'SKILL.md');
    let data: Record<string, unknown>;
    try { data = await frontmatter(workspace, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(data.name) || data.name.length > 64) {
      throw new Error(`Skill name must contain lowercase letters, digits and single hyphens (maximum 64 characters): ${file}`);
    }
    if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024) {
      throw new Error(`Skill description must contain 1–1024 characters: ${file}`);
    }
    if (names.has(data.name)) throw new Error(`Duplicate skill name: ${data.name}`);
    names.add(data.name);
    skills.push({ name: data.name, description: data.description.trim(), path: file });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkill(workspace: Workspace, skills: readonly Skill[], name: string, maxBytes?: number, options: { includeLocation?: boolean } = {}): Promise<string> {
  const skill = skills.find(candidate => candidate.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  const context = getExecutionContext();
  context?.signal?.throwIfAborted();
  const canonical = await workspace.resolve(skill.path, { readRoots: false });
  const file = path.relative(workspace.root, canonical).split(path.sep).join('/');
  const limit = maxBytes ?? 1_048_576;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Skill read limit must be a positive safe integer.');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1) throw new Error(`Skill must be a regular file without hard links: ${name}`);
    if (before.size > limit) throw new Error(`Skill exceeds ${limit} bytes: ${name}`);
    const parts: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(65_536, limit + 1));
    let length = 0;
    for (;;) {
      context?.signal?.throwIfAborted();
      const part = await handle.read(buffer, 0, Math.min(buffer.length, limit - length + 1));
      if (!part.bytesRead) break;
      length += part.bytesRead;
      if (length > limit) throw new Error(`Skill exceeds ${limit} bytes: ${name}`);
      parts.push(Buffer.from(buffer.subarray(0, part.bytesRead)));
    }
    const after = await handle.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink > 1) {
      throw new Error(`Skill changed while reading: ${name}`);
    }
    bytes = Buffer.concat(parts);
  } finally { await handle.close(); }
  const fingerprint: SkillFingerprint = { name, path: file, sha256: sha256(bytes), bytes: bytes.length, loaded: true };
  const baseline = context?.skillBaselines?.find(candidate => candidate.name === name);
  if (context?.mode === 'task') {
    if (!baseline) throw new Error(`Skill ${name} has no task-start fingerprint. Start a new task with the current Skill catalog.`);
    if (baseline.path !== fingerprint.path || baseline.sha256 !== fingerprint.sha256 || baseline.bytes !== fingerprint.bytes) {
      throw new Error(`Skill ${name} changed since task acceptance. Its new instructions were not loaded; start a new task to use them.`);
    }
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`Skill instructions must be UTF-8 text: ${name}`); }
  fingerprint.loadedAt = baseline?.loadedAt ?? new Date().toISOString();
  context?.signal?.throwIfAborted();
  await context?.onSkillLoad?.(fingerprint);
  if (baseline) Object.assign(baseline, fingerprint);
  if (options.includeLocation === false) return text;
  const directory = path.posix.dirname(file);
  const reference = path.posix.join(directory, 'references/output.md');
  return `Skill source (project-relative): ${JSON.stringify(file)}\nSkill directory (project-relative): ${JSON.stringify(directory)}\nFile-tool paths are relative to the project root (cwd "."). Resolve Skill-relative references from its directory; for example, "references/output.md" means ${JSON.stringify(reference)}.\n\nSkill instructions (exact source text):\n${text}`;
}

/** Task-start hashes describe availability; actual-use evidence is marked later. */
export async function snapshotSkills(workspace: Workspace, skills: readonly Skill[]): Promise<SkillFingerprint[]> {
  const snapshots: SkillFingerprint[] = [];
  for (const skill of skills) {
    const canonical = await workspace.resolve(skill.path, { readRoots: false });
    const file = path.relative(workspace.root, canonical).split(path.sep).join('/');
    snapshots.push({ ...(await hashFile(workspace.root, file)), name: skill.name, loaded: false });
  }
  return snapshots;
}

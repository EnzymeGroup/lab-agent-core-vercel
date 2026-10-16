import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Skill } from './types.js';
import type { Workspace } from './workspace.js';

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

export async function loadSkill(workspace: Workspace, skills: readonly Skill[], name: string, maxBytes?: number): Promise<string> {
  const skill = skills.find(candidate => candidate.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  return workspace.read(skill.path, maxBytes, { readRoots: false });
}

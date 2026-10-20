import { readFile, rm, stat } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { InputError, NotFoundError } from '../errors.js';
import { atomicText, ifExists, readDirectory, storagePath } from './files.js';

/**
 * Project memory: one Markdown file per fact in .lab-agent/memory/<name>.md,
 * YAML frontmatter (name, description, type, updatedAt) followed by the body.
 * The model sees an index each turn and reads or writes entries through memory tools;
 * people can read and delete them. Generic file tools never see this directory.
 */

const DIRECTORY = '.lab-agent/memory';
export const MEMORY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
const MAX_ENTRIES = 100;
const MAX_CONTENT_CHARS = 8_000;
const MAX_FILE_BYTES = 64 * 1024;

export const memoryDraftSchema = z.object({
  name: z.string().regex(MEMORY_NAME, 'Memory name: lowercase letters, digits and -, at most 64 characters.'),
  description: z.string().trim().min(1).max(200).regex(/^[^\r\n]*$/u, 'Description must be one line.'),
  type: z.enum(MEMORY_TYPES),
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
});

export type MemoryDraft = z.infer<typeof memoryDraftSchema>;
export interface MemoryEntry extends MemoryDraft { updatedAt: string }
export type MemorySummary = Omit<MemoryEntry, 'content'>;

const frontmatterSchema = memoryDraftSchema.omit({ content: true }).extend({ updatedAt: z.iso.datetime() });

const file = (name: string) => `${DIRECTORY}/${name}.md`;

function parseEntry(text: string): MemoryEntry {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text);
  if (!match) throw new Error('missing frontmatter');
  const meta = frontmatterSchema.parse(parse(match[1]));
  return { ...meta, content: memoryDraftSchema.shape.content.parse(match[2]) };
}

function memoryName(name: string): string {
  if (!MEMORY_NAME.test(name)) throw new InputError('Invalid memory name.');
  return name;
}

export async function readMemory(root: string, name: string): Promise<MemoryEntry> {
  const path = await storagePath(root, file(memoryName(name)));
  const info = await ifExists(stat(path));
  if (!info?.isFile()) throw new NotFoundError(`No memory named ${name}.`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`Memory ${name} exceeds ${MAX_FILE_BYTES} bytes.`);
  const entry = parseEntry(await readFile(path, 'utf8'));
  if (entry.name !== name) throw new Error(`Memory file ${name}.md names ${entry.name}.`);
  return entry;
}

/** Every valid entry, sorted by name; unreadable files are reported, never fatal. */
export async function listMemory(root: string): Promise<{ entries: MemoryEntry[]; issues: string[] }> {
  const entries: MemoryEntry[] = [];
  const issues: string[] = [];
  for (const item of await readDirectory(root, DIRECTORY)) {
    if (!item.isFile() || !item.name.endsWith('.md')) continue;
    const name = item.name.slice(0, -3);
    try {
      entries.push(await readMemory(root, name));
    } catch (error) {
      issues.push(`${file(name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), issues };
}

/** Create or replace an entry by name. */
export async function saveMemory(root: string, value: unknown): Promise<MemoryEntry> {
  const result = memoryDraftSchema.safeParse(value);
  if (!result.success) throw new InputError(result.error.issues.map(issue => issue.message).join(' '));
  const draft = result.data;
  const { entries } = await listMemory(root);
  if (!entries.some(entry => entry.name === draft.name) && entries.length >= MAX_ENTRIES) {
    throw new InputError(`Project memory holds at most ${MAX_ENTRIES} entries. Update or forget an existing one.`);
  }
  const entry: MemoryEntry = { ...draft, updatedAt: new Date().toISOString() };
  const { content, ...meta } = entry;
  await atomicText(root, file(entry.name), `---\n${stringify(meta).trimEnd()}\n---\n${content}\n`);
  return entry;
}

export async function forgetMemory(root: string, name: string): Promise<void> {
  const path = await storagePath(root, file(memoryName(name)));
  if (!(await ifExists(stat(path)))?.isFile()) throw new NotFoundError(`No memory named ${name}.`);
  await rm(path);
}

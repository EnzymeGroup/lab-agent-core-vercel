import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { InputError, NotFoundError } from '../errors.js';

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,120}$/;

export const isOpaqueId = (value: unknown): value is string => typeof value === 'string' && OPAQUE_ID.test(value);

/** IDs become file names, so they are restricted to a safe alphabet. */
export function opaqueId(value: string): string {
  if (!isOpaqueId(value)) throw new InputError('Invalid ID. Expected an opaque alphanumeric token.');
  return value;
}

/** Resolve to undefined when the path does not exist; rethrow every other error. */
export function ifExists<T>(operation: Promise<T>): Promise<T | undefined> {
  return operation.catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

/** True when `file` is `root` or inside it. Purely lexical. */
export function within(root: string, file: string): boolean {
  const part = relative(root, file);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Project-relative path with forward slashes, as stored in records. */
export function projectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** Host-owned metadata paths never traverse symlinks, even inside the project. */
export async function storagePath(root: string, path: string, createParent = false): Promise<string> {
  const file = resolve(root, path);
  if (!within(root, file)) throw new InputError('Path escapes the project.');
  const parts = relative(root, file).split(sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = resolve(cursor, parts[i]);
    const info = await ifExists(lstat(cursor));
    if (info?.isSymbolicLink()) throw new Error(`Metadata path must not contain symlinks: ${relative(root, cursor)}`);
    const isParent = i < parts.length - 1;
    if (isParent && info && !info.isDirectory()) throw new Error('Metadata parent must be a directory.');
    if (isParent && !info && createParent) {
      await mkdir(cursor, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
  }
  return file;
}

/** Write through a synced temporary file and rename, so readers never see partial records. */
export async function atomicText(root: string, path: string, content: string): Promise<void> {
  const file = await storagePath(root, path, true);
  const temporary = resolve(dirname(file), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await storagePath(root, path);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function atomicJSON(root: string, path: string, value: unknown): Promise<void> {
  await atomicText(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

const MAX_RECORD_BYTES = 32 * 1024 * 1024;

export async function readJSON(root: string, path: string): Promise<unknown> {
  const file = await storagePath(root, path);
  const info = await stat(file).catch(error => {
    if (error.code === 'ENOENT') throw new NotFoundError(`Record does not exist: ${path}`);
    throw error;
  });
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error('Record must be a regular file smaller than 32 MiB.');
  return JSON.parse(await readFile(file, 'utf8'));
}

/** List a metadata directory, treating a missing directory as empty. */
export async function readDirectory(root: string, path: string) {
  const directory = await storagePath(root, path);
  return (await ifExists(readdir(directory, { withFileTypes: true }))) ?? [];
}

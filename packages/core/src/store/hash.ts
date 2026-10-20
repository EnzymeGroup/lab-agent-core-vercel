import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { projectPath, storagePath } from './files.js';
import type { FileHash } from '../types.js';

/** SHA-256 primitives shared by Skills, uploads and run provenance. */

const HASH_CHUNK = 64 * 1024;

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Stream bytes from a regular, unaliased file; never load datasets into RAM. */
export async function hashFile(root: string, file: string): Promise<FileHash> {
  const path = await storagePath(root, file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1) throw new Error(`Hash source must be an unaliased regular file: ${file}`);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(HASH_CHUNK);
    let bytes = 0;
    for (;;) {
      const part = await handle.read(buffer, 0, buffer.length);
      if (!part.bytesRead) break;
      digest.update(buffer.subarray(0, part.bytesRead));
      bytes += part.bytesRead;
    }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`File changed while hashing: ${file}`);
    }
    return { path: projectPath(root, path), sha256: digest.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}

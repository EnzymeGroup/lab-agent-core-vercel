import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ModelMessage, UIMessage } from 'ai';
import { InputError } from '../errors.js';
import { projectPath } from '../store/files.js';
import type { Workspace } from '../workspace/workspace.js';

/**
 * Images and PDFs attached to a user message. History stores only a reference
 * (url "project:<path>"); the bytes are read through the file policy each time the
 * model sees the message, so sessions stay small and secrets stay unreadable.
 * Whether a model accepts images or PDFs depends on its provider.
 */

export const ATTACHMENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
};
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SCHEME = 'project:';

type FilePart = Extract<UIMessage['parts'][number], { type: 'file' }>;

/** Validate paths and build the stored parts. Throws InputError for anything unusable. */
export async function attachmentParts(workspace: Workspace, paths: unknown): Promise<FilePart[]> {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > MAX_ATTACHMENTS || paths.some(path => typeof path !== 'string' || !path)) {
    throw new InputError(`attachments must be an array of at most ${MAX_ATTACHMENTS} project paths.`);
  }
  const parts: FilePart[] = [];
  for (const path of new Set(paths as string[])) {
    const mediaType = ATTACHMENT_TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new InputError(`Attach images or PDFs only (${Object.keys(ATTACHMENT_TYPES).join(', ')}): ${path}`);
    let file: string;
    try {
      file = projectPath(workspace.root, await workspace.resolve(path));
      await readAttachment(workspace, file);
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError(`Cannot attach ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    parts.push({ type: 'file', mediaType, filename: file.split('/').at(-1), url: `${SCHEME}${file}` });
  }
  return parts;
}

async function readAttachment(workspace: Workspace, path: string): Promise<Buffer> {
  const handle = await open(await workspace.resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new InputError(`${path} is not a regular file.`);
    if (stats.size > MAX_ATTACHMENT_BYTES) throw new InputError(`${path} exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Project paths referenced by attachments in these messages. */
export function attachedPaths(messages: UIMessage[]): string[] {
  return messages.flatMap(message => message.parts)
    .flatMap(part => part.type === 'file' && part.url.startsWith(SCHEME) ? [part.url.slice(SCHEME.length)] : []);
}

/**
 * Replace stored references with data URLs for the model call. A file that is gone or
 * now denied becomes a short note, so one missing attachment never breaks a session.
 */
export async function inlineAttachments(workspace: Workspace, messages: UIMessage[]): Promise<UIMessage[]> {
  if (!attachedPaths(messages).length) return messages;
  return Promise.all(messages.map(async message => {
    if (!message.parts.some(part => part.type === 'file' && part.url.startsWith(SCHEME))) return message;
    const parts = await Promise.all(message.parts.map(async part => {
      if (part.type !== 'file' || !part.url.startsWith(SCHEME)) return part;
      const path = part.url.slice(SCHEME.length);
      try {
        const data = await readAttachment(workspace, path);
        return { ...part, url: `data:${part.mediaType};base64,${data.toString('base64')}` };
      } catch (error) {
        return { type: 'text' as const, text: `[Attachment ${path} is unavailable: ${error instanceof Error ? error.message : String(error)}]` };
      }
    }));
    return { ...message, parts };
  }));
}

/**
 * JSON size of a model view without file bytes, which do not count as text context.
 * Matches any file or image part, whatever form the SDK holds its data in (URL, base64, bytes).
 */
export function contextChars(messages: ModelMessage[]): number {
  return JSON.stringify(messages, (_key, value) => value && typeof value === 'object' && (value.type === 'file' || value.type === 'image') && ('data' in value || 'image' in value)
    ? { type: value.type, mediaType: value.mediaType, filename: value.filename }
    : value).length;
}

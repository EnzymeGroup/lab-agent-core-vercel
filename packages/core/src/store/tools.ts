import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJSON, ifExists, readJSON, storagePath } from './files.js';

/**
 * Per-project tool switches set from the workbench or code, stored in .lab-agent/tools.json.
 * disabled: hidden from the model and refused if called anyway.
 * alwaysAllow: tools from config.approval that no longer pause for a person.
 */

const FILE = '.lab-agent/tools.json';
const NAME = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);

const settingsSchema = z.object({
  disabled: z.array(NAME).max(500).default([]),
  alwaysAllow: z.array(NAME).max(500).default([]),
});

export type ToolSettings = z.infer<typeof settingsSchema>;

export async function readToolSettings(root: string): Promise<ToolSettings> {
  if (!(await ifExists(lstat(await storagePath(root, FILE))))) return { disabled: [], alwaysAllow: [] };
  return settingsSchema.parse(await readJSON(root, FILE));
}

/** Deduplicate, sort, validate and save; returns what was saved. */
export async function saveToolSettings(root: string, settings: ToolSettings): Promise<ToolSettings> {
  const unique = (names: string[]) => [...new Set(names)].sort();
  const saved = settingsSchema.parse({ disabled: unique(settings.disabled), alwaysAllow: unique(settings.alwaysAllow) });
  await atomicJSON(root, FILE, saved);
  return saved;
}

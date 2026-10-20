import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { getExecutionContext } from '../workspace/context.js';
import { loadSkill } from './skills.js';
import type { Workspace } from '../workspace/workspace.js';
import type { Skill } from '../types.js';

/** readFile, writeFile, listFiles, loadSkill, updatePlan and readToolOutput. All paths are project-relative. */

const MAX_READ_CHARS = 8_000;

/**
 * A generic readFile of a SKILL.md must not bypass Skill provenance tracking.
 * Authorize the read first; Skill registration never expands what readFile may see.
 */
async function readFileOrSkill(workspace: Workspace, skills: readonly Skill[], file: string, maxBytes: number): Promise<string> {
  const candidate = await workspace.resolve(file);
  const requested = path.resolve(workspace.root, file);
  const baselines = getExecutionContext()?.skillBaselines;
  for (const skill of skills) {
    const baseline = baselines?.find(value => value.name === skill.name);
    const matchesSkill = requested === path.resolve(workspace.root, skill.path)
      || (baseline && candidate === path.resolve(workspace.root, baseline.path));
    if (matchesSkill) return loadSkill(workspace, skills, skill.name, maxBytes, { includeLocation: false });
    let canonical: string;
    try {
      canonical = await workspace.resolve(skill.path, { readRoots: false });
    } catch {
      continue; // An unrelated broken Skill must not block data reads.
    }
    if (candidate === canonical) return loadSkill(workspace, skills, skill.name, maxBytes, { includeLocation: false });
  }
  return workspace.read(file, maxBytes);
}

export function builtinTools(workspace: Workspace, skills: readonly Skill[], maxBytes: number) {
  return {
    readFile: tool({
      description: 'Read an allowed UTF-8 project file. Registered Skill instructions retain task-start verification and actual-use tracking. Sensitive files, agent metadata and paths outside configured readRoots are unavailable.',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: ({ path: file }) => readFileOrSkill(workspace, skills, file, maxBytes),
    }),
    writeFile: tool({
      description: 'During an active task, write a UTF-8 deliverable in its current AGENT_OUTPUT_DIR. Development mode additionally permits explicitly configured writeRoots. Chat and direct native calls have no implicit write access.',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path: file, content }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const bytes = Buffer.byteLength(content);
        if (bytes > maxBytes) throw new Error(`File content exceeded ${maxBytes} bytes.`);
        await workspace.write(file, content);
        return { path: file, bytes };
      },
    }),
    listFiles: tool({
      description: 'List immediate allowed project files and directories. Sensitive files, metadata and disallowed readRoots are hidden.',
      inputSchema: z.object({ path: z.string().default('.') }),
      execute: ({ path: directory }) => workspace.list(directory),
    }),
    loadSkill: tool({
      description: 'Load full instructions for a skill listed in the system prompt, with its exact source path and base directory. Resolve Skill-relative references from that directory; file-tool arguments remain project-relative. Read referenced files only when needed.',
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: ({ name }) => loadSkill(workspace, skills, name, maxBytes),
    }),
    updatePlan: tool({
      description: 'Record or update the plan for multi-step work. Send the complete list every time; the person sees it as a checklist. Keep at most one item in_progress.',
      inputSchema: z.object({
        items: z.array(z.object({ step: z.string().min(1).max(300), status: z.enum(['pending', 'in_progress', 'done']) })).min(1).max(30),
      }),
      execute: ({ items }) => ({ items, done: items.filter(item => item.status === 'done').length, total: items.length }),
    }),
    readToolOutput: tool({
      description: 'Read more of a tool result that was truncated in your context, by its toolCallId. Use the offset given in the truncation note.',
      inputSchema: z.object({
        toolCallId: z.string().min(1),
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().positive().max(MAX_READ_CHARS).default(MAX_READ_CHARS),
      }),
      execute: ({ toolCallId, offset, length }) => {
        const full = getExecutionContext()?.clipped?.get(toolCallId);
        if (full === undefined) throw new Error(`No truncated output is available for ${toolCallId} in this turn.`);
        const end = Math.min(full.length, offset + length);
        return { toolCallId, offset, end, total: full.length, text: full.slice(offset, end), more: end < full.length };
      },
    }),
  };
}

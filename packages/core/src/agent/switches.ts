import { z } from 'zod';
import { InputError } from '../errors.js';
import { saveToolSettings, type ToolSettings } from '../store/tools.js';
import type { AgentResources } from './resources.js';

/**
 * Per-project tool switches (.lab-agent/tools.json), read at call time:
 * disabled tools leave the model's active tools (the SDK refuses calls to them);
 * alwaysAllow lets a tool that needs approval (config.approval or its own needsApproval) run without pausing.
 * The config is the ceiling: a switch can turn a tool off or skip its pause, never add a tool.
 */

export interface ToolSwitches {
  settings: ToolSettings;
  enabled(name: string): boolean;
  /** Marked alwaysAllow: runs without pausing even if it needs approval. */
  allowed(name: string): boolean;
}

export function toolSwitches(settings: ToolSettings): ToolSwitches {
  return {
    settings,
    enabled(name) { return !this.settings.disabled.includes(name); },
    allowed(name) { return this.settings.alwaysAllow.includes(name); },
  };
}

const changeSchema = z.object({
  name: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  alwaysAllow: z.boolean().optional(),
}).refine(change => change.enabled !== undefined || change.alwaysAllow !== undefined, 'Set enabled or alwaysAllow.');

/** Change one tool's switches between turns, under the operation gate. */
export async function updateToolSwitch(res: AgentResources, input: unknown): Promise<ToolSettings> {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) throw new InputError(parsed.error.issues.map(issue => issue.message).join(' '));
  const { name, enabled, alwaysAllow } = parsed.data;
  if (!Object.hasOwn(res.tools, name)) throw new InputError(`Unknown tool: ${name}.`);
  if (alwaysAllow && !res.needsApproval(name)) throw new InputError(`${name} does not need approval.`);
  const lease = await res.gate.acquire();
  try {
    const toggle = (list: string[], on: boolean | undefined) => on === undefined ? list : on ? [...list, name] : list.filter(item => item !== name);
    const next = {
      disabled: toggle(res.switches.settings.disabled, enabled === undefined ? undefined : !enabled),
      alwaysAllow: toggle(res.switches.settings.alwaysAllow, alwaysAllow),
    };
    await saveToolSettings(res.root, next);
    res.switches.settings = { disabled: [...new Set(next.disabled)].sort(), alwaysAllow: [...new Set(next.alwaysAllow)].sort() };
    return res.switches.settings;
  } finally {
    await lease.release();
  }
}

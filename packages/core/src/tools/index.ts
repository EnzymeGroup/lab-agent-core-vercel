import type { Tool, ToolSet } from 'ai';
import { builtinTools } from './builtin.js';
import { pythonTool } from './python.js';
import { guardTool } from './guard.js';
import { searchTools } from './search.js';
import { memoryTools } from './memory.js';
import type { Workspace } from '../workspace/workspace.js';
import type { AgentConfig, Skill } from '../types.js';

export { guardTool, waitForToolExecutions } from './guard.js';
export { pythonToolAllowed } from './python.js';

const DEFAULT_MAX_TOOL_OUTPUT = 1_048_576;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/** limits.maxToolOutputBytes, default 1 MiB: the largest serialized result any tool may return. */
export function maxToolOutputBytes(config: AgentConfig): number {
  const maxBytes = config.limits?.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxToolOutputBytes must be a positive safe integer.');
  return maxBytes;
}

/**
 * Assemble the model's tool set in a stable order:
 * built-ins → findFiles/searchFiles → memory tools → runPython → config.tools → MCP tools. Names must be unique.
 */
export function createTools(workspace: Workspace, config: AgentConfig, skills: readonly Skill[] = [], mcpTools: ToolSet = {}): ToolSet {
  const maxBytes = maxToolOutputBytes(config);
  const tools: ToolSet = Object.create(null) as ToolSet;
  const register = (name: string, native: Tool) => {
    if (!TOOL_NAME.test(name)) throw new Error(`Invalid tool name: ${name}`);
    if (Object.hasOwn(tools, name)) throw new Error(`Duplicate tool name: ${name}`);
    if (!native || typeof native !== 'object' || !('inputSchema' in native)) throw new Error(`Tool ${name} must be a native AI SDK tool.`);
    tools[name] = guardTool(native, maxBytes);
  };

  for (const [name, native] of Object.entries(builtinTools(workspace, skills, maxBytes))) register(name, native as Tool);
  for (const [name, native] of Object.entries(searchTools(workspace))) register(name, native as Tool);
  if (config.memory !== false) for (const [name, native] of Object.entries(memoryTools(workspace.root))) register(name, native as Tool);
  const python = pythonTool(workspace, config, maxBytes);
  if (python) register('runPython', python as Tool);
  for (const [name, native] of Object.entries(config.tools ?? {})) register(name, native);
  for (const [name, native] of Object.entries(mcpTools)) register(name, native);
  return tools;
}

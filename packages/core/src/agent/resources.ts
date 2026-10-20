import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NoSuchToolError, ToolLoopAgent, isStepCount, type Tool, type ToolCallRepairFunction, type ToolSet } from 'ai';
import { defineAgent, limitsOf, readInstructions } from '../config/load.js';
import { errorMessage } from '../errors.js';
import { createSessionStore } from '../store/sessions.js';
import { listProjectMcp, mergeMcpServers } from '../store/mcp.js';
import { createRunStore } from '../runs/store.js';
import { createWorkspace, type Workspace } from '../workspace/workspace.js';
import { getExecutionContext, type ExecutionContext } from '../workspace/context.js';
import { discoverSkills } from '../tools/skills.js';
import { connectMcp } from '../tools/mcp.js';
import { createTools, guardTool, pythonToolAllowed } from '../tools/index.js';
import { describeTools } from '../tools/describe.js';
import { createOperationGate } from './gate.js';
import { recoverInterrupted } from './recovery.js';
import { boundContext, projectContext, systemInstructions } from './prompt.js';
import { approvalMatcher, toolApproval } from './approval.js';
import { injectSteering } from './steering.js';
import { helperTools, subagentTool } from './subagent.js';
import type { AgentConfig, Skill } from '../types.js';

/** Everything a running agent holds. Built once by createAgent; only the tool set is swapped later. */

export { limitsOf };

const DEFAULT_MAX_TOOL_OUTPUT = 1_048_576;
const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A misspelled tool name ("list_files" for "listFiles") is repaired when exactly one
 * active tool matches after normalization. Invalid inputs are left to the SDK, which
 * returns the validation error to the model as a tool error so it can retry.
 */
export function repairedToolName(names: readonly string[], name: string): string | undefined {
  const matches = names.filter(candidate => normalize(candidate) === normalize(name));
  return matches.length === 1 ? matches[0] : undefined;
}

const repairToolName: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, error }) => {
  if (!NoSuchToolError.isInstance(error)) return null;
  const toolName = repairedToolName(error.availableTools ?? Object.keys(tools), toolCall.toolName);
  return toolName ? { ...toolCall, toolName } : null;
};

function createNativeAgent(config: AgentConfig, instructions: string, skills: readonly Skill[], tools: ToolSet, needsApproval: (name: string) => boolean) {
  const { maxSteps, maxContextChars, maxRetries } = limitsOf(config);
  return new ToolLoopAgent({
    model: config.model,
    tools,
    // A stable system prefix; Anthropic caches it (and the tool definitions before it).
    instructions: { role: 'system', content: systemInstructions(instructions, skills, config.fileAccess, config.memory !== false), providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
    stopWhen: [isStepCount(maxSteps), () => getExecutionContext()?.overBudget?.() ?? false],
    toolApproval: toolApproval(Object.keys(tools), needsApproval),
    repairToolCall: repairToolName,
    telemetry: config.telemetry,
    // Core bounds the context before and after the application's own prepareStep, and
    // applies the session's selected model unless the application's prepareStep sets one.
    prepareStep: async options => {
      const context = getExecutionContext();
      const steered = injectSteering(context?.steering, options.messages);
      const bounded = projectContext(steered, maxContextChars, context?.clipped);
      const prepared = await config.prepareStep?.({ ...options, messages: bounded });
      const activeTools = context?.mode && !pythonToolAllowed(config, context.mode)
        ? (prepared?.activeTools ?? Object.keys(tools)).filter(name => name !== 'runPython')
        : prepared?.activeTools;
      const final = boundContext(prepared?.messages ?? bounded, maxContextChars, context?.clipped);
      context?.onContext?.(final.stats);
      return {
        ...(context?.model ? { model: context.model } : {}),
        ...prepared,
        ...(activeTools ? { activeTools } : {}),
        messages: final.messages,
      };
    },
    maxRetries,
  });
}

/** Connect config MCP plus project HTTP MCP, then build the tool set and native agent on top. */
async function connectTools(config: AgentConfig, workspace: Workspace, skills: readonly Skill[], instructions: string) {
  const servers = mergeMcpServers(config.mcp, await listProjectMcp(config.root));
  const mcp = await connectMcp(servers, { cwd: config.root, env: config.env });
  try {
    const tools = createTools(workspace, config, skills, mcp.tools);
    const needsApproval = approvalMatcher(config.approval);
    if (config.subagents && Object.keys(config.subagents).length) {
      if (Object.hasOwn(tools, 'runSubagent')) throw new Error('Duplicate tool name: runSubagent');
      const rules = systemInstructions('', [], config.fileAccess);
      const maxBytes = config.limits?.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT;
      tools.runSubagent = guardTool(subagentTool(config, helperTools(config, tools, needsApproval), rules) as Tool, maxBytes);
    }
    const toolDetails = (await describeTools(tools)).map(detail => ({ ...detail, needsApproval: needsApproval(detail.name) }));
    return { mcp, tools, toolDetails, needsApproval, native: createNativeAgent(config, instructions, skills, tools, needsApproval) };
  } catch (error) {
    await mcp.close();
    throw error;
  }
}

/** The turn currently streaming in this process, so steer() can reach its queue. */
export interface ActiveTurn {
  sessionId: string;
  context: ExecutionContext;
}

export async function assembleAgent(input: AgentConfig) {
  defineAgent(input);
  const root = await realpath(resolve(input.root));
  const config: AgentConfig = { ...input, root };
  const workspace = await createWorkspace(root, config.fileAccess);
  const skills = await discoverSkills(workspace, config.skillsDir);
  const instructions = await readInstructions(config);
  const sessions = createSessionStore(root);
  const runs = createRunStore(config);
  const res = {
    config, root, workspace, skills, sessions, runs,
    ...(await connectTools(config, workspace, skills, instructions)),
    gate: createOperationGate(root),
    activeTurn: undefined as ActiveTurn | undefined,
    errorMessage: (error: unknown) => errorMessage(error, config.env),
    /** Mark crash leftovers as interrupted. Caller holds the lock. */
    recoverUnlocked: () => recoverInterrupted(config, sessions, runs),
    /** Reconnect MCP after project servers change and swap the tool set. Caller holds the lock. */
    async reloadTools(): Promise<void> {
      const next = await connectTools(config, workspace, skills, instructions);
      const previous = res.mcp;
      Object.assign(res, next);
      // The new tool set is live; a failure closing old clients is not actionable.
      await previous.close().catch(() => {});
    },
  };
  return res;
}

export type AgentResources = Awaited<ReturnType<typeof assembleAgent>>;

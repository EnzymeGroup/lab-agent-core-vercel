import { ToolLoopAgent, isStepCount, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { limitsOf } from '../config/load.js';
import { selectModel } from '../config/models.js';
import { getExecutionContext } from '../workspace/context.js';
import { pythonToolAllowed } from '../tools/index.js';
import { projectContext } from './prompt.js';
import { stepRecord } from './steps.js';
import type { AgentConfig } from '../types.js';

/**
 * runSubagent: delegate a self-contained subtask to a configured helper.
 * The helper is a native ToolLoopAgent with its own instructions, its own short
 * context and a subset of the main tools. It runs inside the parent tool call, so
 * it shares the turn's cancel signal, output directory, file policy and budget.
 * Only its final text returns to the main agent's context.
 */

const DEFAULT_HELPER_STEPS = 8;
// Helpers get no memory index, so they neither read nor change project memory.
const EXCLUDED = new Set(['runSubagent', 'updatePlan', 'saveMemory', 'readMemory', 'forgetMemory']);

/** Each helper's tools. Tools that need approval are never given to a helper. */
export function helperTools(config: AgentConfig, tools: ToolSet, needsApproval: (name: string) => boolean): Record<string, ToolSet> {
  const result: Record<string, ToolSet> = {};
  for (const [name, helper] of Object.entries(config.subagents ?? {})) {
    const names = helper.tools ?? Object.keys(tools).filter(tool => !EXCLUDED.has(tool) && !needsApproval(tool));
    const selected: ToolSet = {};
    for (const tool of names) {
      if (EXCLUDED.has(tool)) throw new Error(`subagents.${name}.tools cannot include ${tool}.`);
      if (needsApproval(tool)) throw new Error(`subagents.${name}.tools cannot include ${tool}: it needs approval, which a helper cannot request.`);
      // An optional MCP server can be offline; its tools are simply absent.
      if (!Object.hasOwn(tools, tool)) {
        if (tool.startsWith('mcp_')) continue;
        throw new Error(`subagents.${name}.tools: unknown tool ${tool}.`);
      }
      selected[tool] = tools[tool];
    }
    result[name] = selected;
  }
  return result;
}

export function subagentTool(config: AgentConfig, tools: Record<string, ToolSet>, rules: string) {
  const helpers = config.subagents ?? {};
  const names = Object.keys(helpers) as [string, ...string[]];
  const catalog = names.map(name => `- ${name}: ${helpers[name].description}`).join('\n');
  const { maxContextChars, maxRetries } = limitsOf(config);
  return tool({
    description: `Delegate a self-contained subtask to a helper agent with its own context. Give it everything it needs in the task; it cannot see this conversation. Only its final answer is returned.\nHelpers:\n${catalog}`,
    inputSchema: z.object({ agent: z.enum(names), task: z.string().min(1).max(16_000) }),
    async *execute({ agent, task }, { abortSignal }) {
      const helper = helpers[agent];
      const context = getExecutionContext();
      const selected = helper.model ? selectModel(config, helper.model) : { key: context?.modelKey ?? 'default', model: context?.model ?? config.model };
      const available = Object.keys(tools[agent]).filter(name => name !== 'runPython' || !context?.mode || pythonToolAllowed(config, context.mode));
      const native = new ToolLoopAgent({
        model: selected.model, tools: tools[agent], maxRetries, telemetry: config.telemetry,
        instructions: `${helper.instructions}\n\n${rules}`,
        stopWhen: [isStepCount(helper.maxSteps ?? DEFAULT_HELPER_STEPS), () => context?.overBudget?.() ?? false],
        prepareStep: ({ messages }) => ({ activeTools: available, messages: projectContext(messages, maxContextChars, context?.clipped) }),
      });
      let steps = 0;
      const used: string[] = [];
      const result = await native.stream({
        prompt: task, abortSignal,
        onStepEnd: step => {
          steps++;
          context?.onStep?.(stepRecord(agent, selected.key, step));
        },
      });
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw part.error;
        if (part.type === 'tool-call') {
          used.push(part.toolName);
          yield { agent, status: 'working' as const, steps, tools: used.slice(-10) };
        }
      }
      yield { agent, status: 'done' as const, steps, tools: used, text: await result.text };
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: output.status === 'done' ? output.text ?? '' : 'The helper did not finish.' }),
  });
}

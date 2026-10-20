import path from 'node:path';
import { stat } from 'node:fs/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { projectPath } from '../store/files.js';
import { getExecutionContext } from '../workspace/context.js';
import { runCommand } from '../workspace/process.js';
import type { Workspace } from '../workspace/workspace.js';
import type { AgentConfig, PythonScript, TurnMode } from '../types.js';

/**
 * runPython: call an explicitly registered, trusted script by name with argv.
 * There is no arbitrary shell tool. Scripts are trusted code, not sandboxed.
 */

const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
const MAX_ARGS = 256;
const MAX_ARGV_BYTES = 65_536;

function scriptAllowed(script: PythonScript, mode: TurnMode): boolean {
  return script.modes === undefined || (Array.isArray(script.modes) && script.modes.includes(mode));
}

/** Active-tool selection is advisory; execute enforces every named script too. */
export function pythonToolAllowed(config: AgentConfig, mode: TurnMode): boolean {
  if (mode !== 'chat' && mode !== 'task') return false;
  return Object.values(config.python?.scripts ?? {}).some(script => scriptAllowed(script, mode));
}

function describeScripts(scripts: Record<string, PythonScript>): string {
  const list = Object.entries(scripts).map(([name, script]) => `${name} [${script.modes?.join(', ') ?? 'chat, task'}]: ${script.description}`).join('; ');
  return `Run an explicitly registered, trusted Python script with argv. Scripts: ${list}. Scripts may restrict chat/task mode; disallowed calls are refused. Returns cwd "." and a project-relative outputDirectory (null in chat). Resolve bare artifact filenames from stdout under outputDirectory; file-tool arguments are project-relative. Uses AGENT_ROOT/AGENT_RUN_DIR/AGENT_OUTPUT_DIR environment variables.`;
}

export function pythonTool(workspace: Workspace, config: AgentConfig, maxBytes: number) {
  const python = config.python;
  if (!python || !Object.keys(python.scripts).length) return undefined;
  const scripts = python.scripts;
  return tool({
    description: describeScripts(scripts),
    inputSchema: z.object({ script: z.enum(Object.keys(scripts)), args: z.array(z.string()).max(MAX_ARGS).default([]) }),
    execute: async ({ script: name, args }, { abortSignal }) => {
      if (!Object.hasOwn(scripts, name)) throw new Error(`Unknown Python script: ${name}`);
      if (args.some(arg => arg.includes('\0')) || args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > MAX_ARGV_BYTES) {
        throw new Error('Python argv exceeds its limit or contains NUL bytes.');
      }
      const script = scripts[name];
      const context = getExecutionContext();
      if (context?.mode && !scriptAllowed(script, context.mode)) throw new Error(`Python script ${name} is not allowed in ${context.mode} mode.`);
      const scriptPath = await workspace.resolve(script.path, { internal: true });
      if (!scriptPath.endsWith('.py') || !(await stat(scriptPath)).isFile()) throw new Error('Registered Python path must be a regular .py file inside the project.');
      const outputDirectory = context?.mode !== 'chat' && context?.outputDirectory
        ? await workspace.resolve(context.outputDirectory, { internal: true }) : '';
      const result = await runCommand(python.command ?? 'python3', [...(python.args ?? []), scriptPath, ...args], {
        cwd: workspace.root,
        env: {
          ...config.env, AGENT_ROOT: workspace.root, AGENT_RUN_ID: context?.runId ?? '',
          AGENT_RUN_DIR: outputDirectory ? path.dirname(outputDirectory) : '', AGENT_OUTPUT_DIR: outputDirectory,
        },
        signal: abortSignal,
        timeoutMs: script.timeoutMs ?? config.limits?.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        // guardTool also verifies the exact serialized result against this ceiling.
        maxOutputBytes: maxBytes,
      });
      return { ...result, cwd: '.' as const, outputDirectory: outputDirectory ? projectPath(workspace.root, outputDirectory) : null };
    },
  });
}

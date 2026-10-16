import path from 'node:path';
import { stat } from 'node:fs/promises';
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentConfig, PythonScript, Skill } from './types.js';
import { loadSkill } from './skills.js';
import { runCommand } from './process.js';
import { getExecutionContext, runWithExecutionContext, type Workspace } from './workspace.js';

const executing = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
function trackExecution<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const pending = executing.get(signal) ?? new Set<Promise<unknown>>();
  executing.set(signal, pending);
  pending.add(promise);
  const settled = () => {
    pending.delete(promise);
    if (!pending.size) executing.delete(signal);
  };
  void promise.then(settled, settled);
  return promise;
}

/** The SDK can stop its stream before an aborted tool finishes cleanup. */
export async function waitForToolExecutions(signal: AbortSignal): Promise<void> {
  for (;;) {
    const pending = executing.get(signal);
    if (!pending?.size) return;
    await Promise.allSettled([...pending]);
  }
}

function assertOutputSize(value: unknown, maxBytes: number): void {
  let serialized: string | undefined;
  try { serialized = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { throw new Error('Tool output must be serializable.'); }
  if (serialized !== undefined && Buffer.byteLength(serialized) > maxBytes) {
    throw new Error(`Tool output exceeded ${maxBytes} bytes.`);
  }
}

function scriptAllowed(script: PythonScript, mode: 'chat' | 'task'): boolean {
  return script.modes === undefined || (Array.isArray(script.modes) && script.modes.includes(mode));
}

/** Active-tool selection is advisory; execute enforces every named script too. */
export function pythonToolAllowed(config: AgentConfig, mode: 'chat' | 'task'): boolean {
  if (mode !== 'chat' && mode !== 'task') return false;
  return Object.values(config.python?.scripts ?? {}).some(script => scriptAllowed(script, mode));
}

function limitTool(native: Tool, maxBytes: number): Tool {
  if (!native.execute) return native;
  const execute = native.execute;
  return {
    ...native,
    execute(input, options) {
      const context = getExecutionContext();
      const signals = [context?.signal, options.abortSignal].filter((signal): signal is AbortSignal => Boolean(signal));
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const ownerSignal = context?.signal ?? signal;
      signal?.throwIfAborted();
      const result = runWithExecutionContext({ ...context, signal }, () => execute(input, { ...options, abortSignal: signal }));
      if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
        return (async function* () {
          const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          let finish!: () => void;
          trackExecution(new Promise<void>(resolve => { finish = resolve; }), ownerSignal);
          try {
            for (;;) {
              signal?.throwIfAborted();
              const next = await runWithExecutionContext({ ...context, signal }, () => iterator.next());
              if (next.done) return;
              signal?.throwIfAborted();
              assertOutputSize(next.value, maxBytes);
              yield next.value;
            }
          } finally {
            try {
              if (iterator.return) await runWithExecutionContext({ ...context, signal }, () => iterator.return!());
            } finally { finish(); }
          }
        })();
      }
      return trackExecution(Promise.resolve(result).then(value => {
        signal?.throwIfAborted();
        assertOutputSize(value, maxBytes);
        return value;
      }), ownerSignal);
    },
  } as Tool;
}

/** Native tools stay native; wrappers provide cancellation/output accounting. */
export function createTools(workspace: Workspace, config: AgentConfig, skills: readonly Skill[] = [], mcpTools: ToolSet = {}): ToolSet {
  const maxBytes = config.limits?.maxToolOutputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxToolOutputBytes must be a positive safe integer.');
  const tools: ToolSet = Object.create(null) as ToolSet;
  const register = (name: string, native: Tool) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new Error(`Invalid tool name: ${name}`);
    if (Object.hasOwn(tools, name)) throw new Error(`Duplicate tool name: ${name}`);
    if (!native || typeof native !== 'object' || !('inputSchema' in native)) throw new Error(`Tool ${name} must be a native AI SDK tool.`);
    tools[name] = limitTool(native, maxBytes);
  };
  register('readFile', tool({
    description: 'Read an allowed UTF-8 project file. Registered Skill instructions retain task-start verification and actual-use tracking. Sensitive files, agent metadata and paths outside configured readRoots are unavailable.',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path: file }) => {
      // A generic file read must not bypass the named Skill provenance path.
      // Authorize the requested read first; Skill registration never expands
      // the readFile allowlist or grants access to sensitive paths.
      const candidate = await workspace.resolve(file);
      const requested = path.resolve(workspace.root, file);
      const baselines = getExecutionContext()?.skillBaselines;
      for (const skill of skills) {
        const baseline = baselines?.find(value => value.name === skill.name);
        if (requested === path.resolve(workspace.root, skill.path) ||
          (baseline && candidate === path.resolve(workspace.root, baseline.path))) {
          return loadSkill(workspace, skills, skill.name, maxBytes, { includeLocation: false });
        }
        let canonical: string;
        try { canonical = await workspace.resolve(skill.path, { readRoots: false }); }
        catch { continue; } // An unrelated broken Skill must not block data reads.
        if (candidate === canonical) return loadSkill(workspace, skills, skill.name, maxBytes, { includeLocation: false });
      }
      return workspace.read(file, maxBytes);
    },
  }));
  register('writeFile', tool({
    description: 'During an active task, write a UTF-8 deliverable in its current AGENT_OUTPUT_DIR. Development mode additionally permits explicitly configured writeRoots. Chat and direct native calls have no implicit write access.',
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: async ({ path: file, content }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      if (Buffer.byteLength(content) > maxBytes) throw new Error(`File content exceeded ${maxBytes} bytes.`);
      await workspace.write(file, content);
      return { path: file, bytes: Buffer.byteLength(content) };
    },
  }));
  register('listFiles', tool({
    description: 'List immediate allowed project files and directories. Sensitive files, metadata and disallowed readRoots are hidden.',
    inputSchema: z.object({ path: z.string().default('.') }),
    execute: ({ path: directory }) => workspace.list(directory),
  }));
  register('loadSkill', tool({
    description: 'Load full instructions for a skill listed in the system prompt, with its exact source path and base directory. Resolve Skill-relative references from that directory; file-tool arguments remain project-relative. Read referenced files only when needed.',
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: ({ name }) => loadSkill(workspace, skills, name, maxBytes),
  }));
  if (config.python && Object.keys(config.python.scripts).length) {
    const scripts = config.python.scripts;
    register('runPython', tool({
      description: `Run an explicitly registered, trusted Python script with argv. Scripts: ${Object.entries(scripts).map(([name, script]) => `${name} [${script.modes?.join(', ') ?? 'chat, task'}]: ${script.description}`).join('; ')}. Scripts may restrict chat/task mode; disallowed calls are refused. Returns cwd "." and a project-relative outputDirectory (null in chat). Resolve bare artifact filenames from stdout under outputDirectory; file-tool arguments are project-relative. Uses AGENT_ROOT/AGENT_RUN_DIR/AGENT_OUTPUT_DIR environment variables.`,
      inputSchema: z.object({ script: z.enum(Object.keys(scripts)), args: z.array(z.string()).max(256).default([]) }),
      execute: async ({ script: name, args }, { abortSignal }) => {
        if (!Object.hasOwn(scripts, name)) throw new Error(`Unknown Python script: ${name}`);
        if (args.some(arg => arg.includes('\0')) || args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 65_536) {
          throw new Error('Python argv exceeds its limit or contains NUL bytes.');
        }
        const script = scripts[name];
        const context = getExecutionContext();
        if (context?.mode && !scriptAllowed(script, context.mode)) {
          throw new Error(`Python script ${name} is not allowed in ${context.mode} mode.`);
        }
        const scriptPath = await workspace.resolve(script.path, { internal: true });
        if (!scriptPath.endsWith('.py') || !(await stat(scriptPath)).isFile()) throw new Error('Registered Python path must be a regular .py file inside the project.');
        const outputDirectory = context?.mode !== 'chat' && context?.outputDirectory ? await workspace.resolve(context.outputDirectory, { internal: true }) : '';
        const runDirectory = outputDirectory ? path.dirname(outputDirectory) : '';
        const result = await runCommand(config.python?.command ?? 'python3', [...(config.python?.args ?? []), scriptPath, ...args], {
          cwd: workspace.root,
          env: { ...config.env, AGENT_ROOT: workspace.root, AGENT_RUN_ID: context?.runId ?? '', AGENT_RUN_DIR: runDirectory, AGENT_OUTPUT_DIR: outputDirectory },
          signal: abortSignal,
          timeoutMs: script.timeoutMs ?? config.limits?.timeoutMs ?? 120_000,
          // Reserve enough room for the result envelope; limitTool verifies the
          // exact serialized result as well as this raw stdout/stderr ceiling.
          maxOutputBytes: maxBytes,
        });
        return { ...result, cwd: '.' as const, outputDirectory: outputDirectory ? path.relative(workspace.root, outputDirectory).split(path.sep).join('/') : null };
      },
    }));
  }
  for (const [name, native] of Object.entries(config.tools ?? {})) register(name, native);
  for (const [name, native] of Object.entries(mcpTools)) register(name, native);
  return tools;
}

# Tools, execution environments and MCP

Use an independent project with an installed Core package. Config, Python and MCP programs are trusted code; a browser request cannot select a different config or register an executable.

## Native tools

The extension interface is AI SDK's own tool function. A tool can call Python, a database or an existing service without a Core-specific base class:

```ts
import { tool } from 'ai';
import { z } from 'zod';

const tools = {
  normalizeIdentifier: tool({
    description: 'Trim surrounding whitespace while preserving identifier case.',
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      return { value: value.trim() };
    },
  }),
};
```

Pass tools to defineAgent. Names must be unique across built-in, application and MCP tools. Core preserves native schemas and display metadata while accounting for output size and cancellation. Custom asynchronous tools must propagate abortSignal and settle their work; Core cannot terminate arbitrary external services. A tracked tool that does not settle retains project ownership instead of allowing conflicting work to overlap. [cooperative-tool.ts](../examples/advanced/cooperative-tool.ts) passes that signal to a real fetch request whose endpoint comes from trusted config.

getExecutionContext provides the active outputDirectory, runId and signal to application tools. Native access through agent.native deliberately bypasses automatic history, locks, provenance, task creation and checking. The advanced examples demonstrate native child-Agent delegation and explicit application-controlled orchestration without a scheduler. One project still permits only one Core operation at a time; a second session is another history, not a second worker.

## Adapt an existing project

Install the current Core tarball in the existing repository and add agent.config.ts and AGENTS.md. Keep source data, analysis scripts and scientific checks in their existing locations. Register the fixed entry points and their actual input paths; there is no need to move them into a new framework directory.

```ts
import path from 'node:path';
import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['measurements/source.csv'], code: ['analysis/shared.py'] },
  python: { command: path.join(root, '.venv/bin/python'), scripts: {
    analyze: { path: 'analysis/analyze.py', description: 'Analyze the supplied measurements without imputation.' },
  } },
  validation: { command: [path.join(root, '.venv/bin/python'), 'checks/validate.py'] },
}));
```

Use the actual environment executable for your platform. Explicit input/code registration helps reproducibility; configuration, instructions, registered Python and local checker code are also fingerprinted. .env is deliberately excluded. Analysis mode preserves source/checker/history files. To authorize edits, use `fileAccess: {mode:'development',writeRoots:['analysis/']}`. Keep input/checker directories outside edit roots. A selected root can authorize editing their files, but changed source/input provenance prevents accepting them as the original delivery. Secrets, Core metadata and prior-run history remain protected.

## Python environment

The default interpreter is python3. Select an existing virtual environment with an absolute executable path, or use an argv prefix:

```ts
python: {
  command: 'uv',
  args: ['run', '--project', root, 'python'],
  scripts: {
    analyze: { modes: ['task'], path: 'tools/analyze.py', description: 'Analyze the project input', timeoutMs: 120000 },
  },
},
validation: { command: ['uv', 'run', '--project', root, 'python', 'checks/validate.py'] },
```

The tool accepts a registered script name and literal argv; it cannot replace the registered entry point. Core uses project cwd, loaded project env, environment variables described in Conventions, bounded stdout/stderr, execution timeout and process-group cleanup on POSIX. Arguments are never interpreted by a shell. Install/lock the environment before an execution campaign. A script may import dependencies installed in its selected environment. The examples use only the Python standard library; NumPy/PyTorch environments and GPU jobs require their own domain configuration and have not been benchmarked here.

Add `modes: ['task']` to computational registrations. Omitted modes preserve chat/task compatibility; a task-only registration is hidden and rejected in chat. This controls eligibility, not host permissions. Python remains trusted code and chat may use other side-effecting native/MCP tools.

For domain arguments, [python-arguments.ts](../examples/advanced/python-arguments.ts) uses a native AI SDK Tool plus Zod to turn a fixed CSV input and bounded maxRows into literal Python argv. It uses runCommand, the active task output context and AbortSignal; no BaseTool or extra runtime is added. Ordinary runPython remains available for named script execution. Register the native tool's Python/module paths in provenance.code.

Long-running external jobs need an explicit domain tool for submission, status and cancellation. A restarted session does not automatically resume an external job or replay a submission. Persist job identifiers in the application's artifacts and define recovery there.

## MCP

Provide servers in config, not in model text:

```ts
mcp: {
  local: {
    transport: 'stdio',
    command: 'python3',
    args: ['tools/server.py'],
  },
  remote: {
    optional: true,
    transport: 'http',
    url: 'https://your-server.example/mcp',
    headers: { Authorization: `Bearer ${env.MCP_API_TOKEN}` },
  },
},
```

This config fragment belongs inside a factory receiving env. Core starts stdio servers with the selected project root as cwd and its loaded env, including when CLI --root selects a different directory. Tools are discovered through the official MCP client and registered as mcp_SERVER_TOOL. Required startup failures reject creation; optional failures remain visible as unavailable with an error and contribute no tools. Static inspect/models only report configured entries. Doctor explicitly connects, lists tools and closes transports. Invalid names and normalization collisions fail visibly. Partial startup closes clients; agent.close waits for execution cleanup and closes resources. Tests exercise real HTTP JSON-RPC and stdio discovery/execution/shutdown. OAuth management is application-owned; the workbench is not a multi-user credential service.

## Skills

Each .agents/skills/NAME/SKILL.md starts with YAML name and description. Only those metadata fields appear in the initial instructions. loadSkill reads the full body on demand; referenced files are read through normal workspace tools. Skill instructions do not add tool permissions or bypass registered-script restrictions. Malformed metadata, duplicate names and escaped paths fail visibly.

Task acceptance fingerprints available SKILL.md files; actual loadSkill calls verify and mark use. Rechecks gate on used Skills. Explicitly register important reference files in provenance.code, or bind them as task inputs; a reference mentioned in a Skill is not automatically fingerprinted.

## Execution limits

limits.maxSteps bounds SDK loop steps; limits.timeoutMs bounds a turn; limits.maxToolOutputBytes bounds file/tool return values; limits.maxContextChars bounds the message projection. Full durable messages remain separate from the projection. Older complete turns can be omitted from model input, and large tool results are explicitly truncated there. A current turn that still exceeds the projection budget fails rather than silently dropping unmatched tool calls.

Stopping at a tool-call step budget records failed execution. An ordinary final response records completed execution, after which the independent checker may still record failed or partial delivery. Limits are character/byte bounds, not tokenizer-specific context-window guarantees.

## Native workflow policy

Config may pass an optional native AI SDK prepareStep callback. Core still applies its bounded model-context projection; a policy cannot bypass durable history or turn execution into a separate engine. Native activeTools/toolChoice/model policy must follow the installed SDK types. runTask/streamTurn also accept workflowId and parentRunId metadata so an application can link related runs. These labels do not schedule, resume or automatically replay child work. Use an explicit sequence or a native delegated tool for composition, and define scientific acceptance in each project's checker.

[context-policy.ts](../examples/advanced/context-policy.ts) provides a reusable native prepareStep example: stable rules remain in instructions, saved intermediate artifact paths stay referenced, and a callback/model notice warns near the character budget. It removes only older complete user turns and preserves the current tool-call/result chain. References are paths, not fabricated summaries; the model must read an artifact before relying on it. A single oversized current turn still fails Core's bound. See [native examples](../examples/advanced/README.md) for wiring.

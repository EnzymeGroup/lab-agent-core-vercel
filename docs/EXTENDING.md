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

Pass tools to defineAgent. Names must be unique across built-in, application and MCP tools. Core preserves native schemas and display metadata while accounting for output size and cancellation. Custom asynchronous tools must propagate abortSignal and settle their work; Core cannot terminate arbitrary external services. A tracked tool that does not settle retains project ownership instead of allowing conflicting work to overlap.

getExecutionContext provides the active outputDirectory, runId and signal to application tools. Native access through agent.native deliberately bypasses automatic history, task creation and checking. The advanced examples demonstrate native child-Agent delegation and explicit application-controlled orchestration without a scheduler.

## Python environment

The default interpreter is python3. Select an existing virtual environment with an absolute executable path, or use an argv prefix:

```ts
python: {
  command: 'uv',
  args: ['run', 'python'],
  scripts: {
    analyze: { path: 'tools/analyze.py', description: 'Analyze the project input', timeoutMs: 120000 },
  },
},
```

The tool accepts a registered script name and literal argv; it cannot replace the registered entry point. Core uses project cwd, environment variables described in Conventions, bounded stdout/stderr, execution timeout and process-group cleanup on POSIX. Arguments are never interpreted by a shell. A script may import the dependencies installed in its selected environment. The examples use only the Python standard library; NumPy/PyTorch environments and GPU jobs require their own domain configuration and have not been benchmarked here.

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
    transport: 'http',
    url: 'https://your-server.example/mcp',
    headers: { Authorization: `Bearer ${process.env.MCP_API_TOKEN}` },
  },
},
```

Core starts stdio servers with the selected project root as cwd, including when CLI --root selects a different directory. Transport configuration is passed to the official MCP client. Tools are discovered through that client and registered as mcp_SERVER_TOOL. Invalid names and normalization collisions fail explicitly. Partial startup closes already-open clients; agent.close waits for execution cleanup and closes MCP resources. Tests exercise real HTTP JSON-RPC and stdio discovery/execution/shutdown. OAuth management is application-owned; the local workbench is not a multi-user credential service.

## Skills

Each .agents/skills/NAME/SKILL.md starts with YAML name and description. Only those metadata fields appear in the initial instructions. loadSkill reads the full body on demand; referenced files are read through normal workspace tools. Skill instructions do not add tool permissions or bypass registered-script restrictions. Malformed metadata, duplicate names and escaped paths fail visibly.

## Execution limits

limits.maxSteps bounds SDK loop steps; limits.timeoutMs bounds a turn; limits.maxToolOutputBytes bounds file/tool return values; limits.maxContextChars bounds the message projection. Full durable messages remain separate from the projection. Older complete turns can be omitted from model input, and large tool results are explicitly truncated there. A current turn that still exceeds the projection budget fails rather than silently dropping unmatched tool calls.

Stopping at a tool-call step budget records failed execution. An ordinary final response records completed execution, after which the independent checker may still record failed or partial delivery. Limits are character/byte bounds, not tokenizer-specific context-window guarantees.

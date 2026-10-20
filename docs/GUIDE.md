# Guide

How to build, run and customize an agent. Exact field types, routes and statuses are in the [Reference](REFERENCE.md).

## 1. Project layout

```
my-agent/
  agent.config.ts            model, tools, Python, MCP, checker, limits, ui
  AGENTS.md                  role and rules (system instructions)
  .agents/skills/<name>/     SKILL.md procedures, loaded only when relevant
  tools/  workflows/         Python entry points and drivers
  data/                      source files; workbench uploads land in data/uploads/
  .env                       credentials (never visible to model file tools)
  .lab-agent/sessions/       saved conversations (Core-owned)
  runs/<id>/                 one directory per task run (Core-owned)
```

Create one with `create-lab-agent <dir> --template basic|python` or `lab-agent init <dir> --template …`. `basic` shows a native TypeScript tool; `python` adds a registered script, a Skill and an independent checker.

## 2. Choose a model

`modelFromEnv(env)` reads the project `.env`:

```dotenv
LAB_AGENT_PROVIDER=openai          # or anthropic
LAB_AGENT_MODEL=YOUR_TOOL_CAPABLE_MODEL_ID
LAB_AGENT_API_KEY=YOUR_KEY         # OPENAI_API_KEY / ANTHROPIC_API_KEY also work
# LAB_AGENT_BASE_URL=https://your-endpoint.example/v1   # any OpenAI-compatible Chat Completions server
```

Explicit process variables override `.env`; loading never mutates `process.env`. Missing or invalid settings fail before any work starts.

| Server | Settings |
| --- | --- |
| Local vLLM | `LAB_AGENT_BASE_URL=http://127.0.0.1:8000/v1`, the served model name, and the server's token. Start vLLM with tool calling enabled ([vLLM guide](https://docs.vllm.ai/en/latest/features/tool_calling/)). |
| Local Ollama | `LAB_AGENT_BASE_URL=http://127.0.0.1:11434/v1`, an installed tool-capable model, any placeholder key ([Ollama docs](https://docs.ollama.com/api/openai-compatibility)). |

Any other native AI SDK model works too; return it from the config factory:

```ts
import { createGoogle } from '@ai-sdk/google';
import { defineAgent } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })('YOUR_MODEL_ID'),
}));
```

To let users switch models per session, add named models. The workbench shows a model picker; the choice is saved on the session and recorded on each run as `run.model.key`:

```ts
export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),                                          // offered as "default"
  models: { strong: modelFromEnv({ ...env, LAB_AGENT_MODEL: 'YOUR_LARGER_MODEL_ID' }) },
}));
```

Only configured models can be chosen; the browser cannot supply a model ID. SDK callers pass `{ model: 'strong' }` to `chat`, `runTask` or `streamTurn`. An application `prepareStep` that returns its own `model` still wins.

`lab-agent inspect` shows the configured model without connecting. `lab-agent doctor --probe-model` sends one small, potentially billable request; it proves connectivity, not that the model handles your tool workflow.

## 3. Run it

```sh
npx lab-agent dev                                    # workbench at http://127.0.0.1:8787
npx lab-agent chat                                   # terminal UI
npx lab-agent run "Summarize the FASTA" --input data/input.fasta --json
npx lab-agent check <run-id>                         # recheck outputs, no model call
```

All commands accept `--root <project>`. On a remote machine, forward the port: `ssh -N -L 8787:127.0.0.1:8787 user@server`. The server binds to loopback only and is a single-user local tool, not a hosted service.

**One project runs one operation at a time**, across sessions, CLI and browser. A second session is a second history, not a second worker.

## 4. Chat or task

| | Chat | Task |
| --- | --- | --- |
| Creates a run in `runs/<id>/` | No | Yes |
| File-tool writes | None | Only into that run's `output/` |
| Checker runs afterwards | No | Yes, when `validation` is configured |
| Typical use | Questions, explanations | Producing deliverables |

Both share the same session history. Chat is not a sandbox: other native and MCP tools you register can still have side effects.

## 5. Add capabilities

### Native tools

The extension API is the AI SDK's own `tool()`. Honor `abortSignal` so cancel and close can finish:

```ts
import { tool } from 'ai';
import { z } from 'zod';

tools: {
  normalizeId: tool({
    description: 'Trim whitespace while preserving identifier case.',
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      return { value: value.trim() };
    },
  }),
},
```

Names must be unique across built-ins (`readFile`, `writeFile`, `listFiles`, `findFiles`, `searchFiles`, `loadSkill`, `updatePlan`, `readToolOutput`, `saveMemory`, `readMemory`, `forgetMemory`, `runPython`, `runSubagent`), your tools and MCP tools. `getExecutionContext()` gives a tool the active `runId`, `outputDirectory`, `mode` and `signal`. A tool that never settles keeps the project busy rather than letting conflicting work overlap. See [cooperative-tool.ts](../examples/advanced/cooperative-tool.ts).

### Python scripts

Register entry points by name. The model calls `runPython({ script, args })`; there is no arbitrary shell.

```ts
python: {
  command: 'uv', args: ['run', '--project', root, 'python'],   // default: python3
  scripts: {
    analyze: { path: 'tools/analyze.py', description: 'Analyze the project input.', modes: ['task'], timeoutMs: 120000 },
  },
},
```

Scripts run with the project as cwd and receive `AGENT_ROOT`, `AGENT_RUN_ID`, `AGENT_RUN_DIR` and `AGENT_OUTPUT_DIR`; write results under `AGENT_OUTPUT_DIR`. Argv is passed literally, output is bounded, and cancel stops the whole process group. Use `modes: ['task']` for computations so chat cannot call them. For typed domain arguments, wrap `runCommand` in a native tool as in [python-arguments.ts](../examples/advanced/python-arguments.ts).

Long-running external jobs need their own submit/status/cancel tool. Core never replays a tool after a restart.

### Skills

`.agents/skills/<name>/SKILL.md` starts with YAML frontmatter:

```md
---
name: table-quality
description: Profile a CSV while preserving raw cells and missing values.
---
Steps the agent should follow…
```

Only `name` and `description` enter the system prompt; `loadSkill` returns the full text when the model decides it is relevant. During a task, a Skill must match the bytes it had when the task started. Files a Skill refers to are not fingerprinted automatically; list important ones in `provenance.code`.

### MCP servers

```ts
mcp: {
  local:  { transport: 'stdio', command: 'python3', args: ['tools/server.py'] },
  remote: { transport: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: `Bearer ${env.MCP_TOKEN}` }, optional: true },
},
```

Tools appear as `mcp_<server>_<tool>`. A required server that fails to start stops agent creation; an optional one is reported as unavailable and skipped. `lab-agent doctor` connects, lists tools and disconnects; `inspect` never connects.

From the workbench (Capabilities → MCP) you can also test, add and remove **HTTP** MCP servers. They are stored in `.lab-agent/mcp.json`, always optional, and take effect between turns without a restart. Header values (for example `Authorization`) stay in that file and are never returned by the API. stdio servers run local programs, so they can only be declared in `agent.config.ts`.

### Inspecting the agent

Capabilities lists models, limits and prices, project memory, every tool with its input schema (and whether it needs approval), helpers, the compaction policy, Python script modes and MCP servers with their tools. Skills expand to their full `SKILL.md`; viewing one does not mark it as used by any run. Under the message box, the context meter shows how much of the budget the latest step sent and whether earlier turns were summarized or trimmed; **Compact** summarizes older turns on demand. The header shows the session's tokens and cost. Full history always stays on disk.

### Approval

List tools that must wait for a person:

```ts
approval: ['writeFile', 'mcp_*'],
```

When the model calls one, the turn pauses and the workbench shows **Approve** and **Deny** on that call. Nothing runs until you answer; the same reply then continues. From the CLI, `lab-agent run` exits 3 and prints the command to continue: `lab-agent approve --session ID [--deny]`. In code, `agent.approve(sessionId, true)`.

**Always allow** on the card approves the call and stops that tool asking again in this project. Capabilities → Tools has two switches per tool: **Enabled** (off hides the tool from the model; a call to it is refused) and, for tools in `approval`, **Always allow**. They are saved in `.lab-agent/tools.json`, work from the next step, and each task records the switches it ran with. In code: `agent.tools.update({ name: 'writeFile', alwaysAllow: true })`. `approval` in the config stays the ceiling: a switch can turn a tool off or skip its pause, never add a tool.

### Images and PDFs

Import a `.png`, `.jpg`, `.gif`, `.webp` or `.pdf` under Input files and press **Attach**; it is shown to the model with your next message, in Chat or Task mode. From the CLI: `lab-agent run "describe the figure" --attach data/figure.png`. In code: `agent.chat('…', { attachments: ['data/figure.png'] })`. History keeps only the path, and the bytes are read through the file policy each time. Whether the model can read images or PDFs depends on the model and provider; one that cannot will return a provider error.

### Search

`findFiles` finds files by glob (`**/*.csv`) and `searchFiles` greps contents with a regular expression, both recursively and through the same file policy as `readFile`: secrets, `.lab-agent/` and paths outside `readRoots` never show up. They need no `rg` binary.

### Memory

Like Claude Code's memory, the agent keeps durable facts for later sessions in `.lab-agent/memory/`, one Markdown file per fact (`user`, `feedback`, `project` or `reference`). Each turn the model sees an index of names and descriptions and reads an entry with `readMemory` when it is relevant. It saves preferences, corrections, decisions and lessons from failed checks with `saveMemory`, and removes wrong ones with `forgetMemory`.

Review entries in Capabilities → Memory (open to read, the trash icon to delete) or with `lab-agent memory [NAME] [--forget]`. Memory is project-wide: every session and eval sees it, and each task records which entries it was shown. Set `memory: false` to turn it off. Saved memory steers later work, so read what accumulates and delete anything you did not intend.

### Steering a running turn

While a turn runs, the message box sends to it (**Send to running turn**). The agent sees your note at its next step, and it is saved in history where it arrived. If the agent had already finished its last step, the note starts a short follow-up on the same turn.

## 6. Check deliveries

A checker is any program, run as argv without a shell after every completed task:

```ts
validation: { command: ['python3', 'tools/validate.py'], timeoutMs: 30000 },
```

It receives `AGENT_ROOT`, `AGENT_RUN_ID`, `AGENT_RUN_DIR`, `AGENT_OUTPUT_DIR` and `AGENT_CHECK_FILE`, and writes this JSON to `AGENT_CHECK_FILE`:

```json
{ "status": "passed", "checks": [{ "name": "values match source", "status": "passed" }], "issues": [] }
```

`status` is `passed`, `partial` or `failed`. A nonzero exit, timeout, or missing or malformed report always means `failed`. Without a checker, delivery stays `not_checked`.

Add `repairAttempts: 2` to let the agent fix a failed or partial delivery itself: Core sends the checker's issues back as an automatic message and checks again, up to that many times. Each check is kept, so `originalDelivery` still shows the first verdict.

Write checkers that recompute expected values from the original source. "The file exists" does not show it is correct. `lab-agent check <run>` reruns the checker without the model and appends a new observation; the first result is kept as `originalDelivery`. If inputs, code or the checker changed since the run, the recheck fails instead of silently accepting new evidence.

## 7. Bind task inputs

A task's inputs are frozen when it starts:

1. explicit per-task inputs: `--input PATH` (repeatable), the workbench "Task inputs" panel, or `runTask(task, { inputs: [...] })`
2. otherwise `provenance.inputs` from config
3. otherwise every file under `data/`

`inputs: []` means none. Rechecks hash exactly the recorded files, so a later unrelated upload never invalidates an earlier run, but editing or deleting a recorded file does. Binding records provenance; your tool still has to read that path. Mentioning a filename in the prompt is not binding.

## 8. Brand the workbench

```ts
ui: {
  title: 'Table Quality',                      // header, message label, browser tab
  tagline: 'Profile CSV tables safely.',       // shown before a session exists
  accent: '#0f766e',                           // primary buttons and focus ring; omit for black/white
  starters: [                                  // up to 6 prompts in an empty conversation
    { title: 'Profile the table', prompt: 'Profile the CSV and validate the artifacts.' },
    { title: 'How are blanks handled?', prompt: 'Explain how empty cells are treated.', mode: 'chat' },
  ],
},
```

`ui` affects presentation only and is excluded from run provenance. Clicking a starter fills the message box; it never sends on its own. Light/dark follows the system until the user toggles it.

## 9. Adapt an existing repository

Keep data and scripts where they are. Add `agent.config.ts` and `AGENTS.md`, and register the real paths:

```ts
import path from 'node:path';
import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['measurements/source.csv'], code: ['analysis/shared.py'] },
  python: { command: path.join(root, '.venv/bin/python'), scripts: {
    analyze: { path: 'analysis/analyze.py', description: 'Analyze the measurements without imputation.' },
  } },
  validation: { command: [path.join(root, '.venv/bin/python'), 'checks/validate.py'] },
}));
```

By default (`fileAccess.mode: 'analysis'`), model file tools can write only into the current run's output. To let the agent edit source, opt in with `fileAccess: { mode: 'development', writeRoots: ['analysis/'] }`, and keep inputs and checkers outside those roots.

## 10. Embed in an application

```ts
import { createAgent, loadAgentConfig } from 'lab-agent-core-vercel';

const agent = await createAgent(await loadAgentConfig(process.cwd()));
try {
  const run = await agent.runTask('Summarize the FASTA', { inputs: ['data/input.fasta'] });
  console.log(run.execution, run.delivery);
  const reply = await agent.chat('Explain the limitations', { sessionId: run.session.id });
  console.log(reply.text);
} finally {
  await agent.close();
}
```

`agent.streamTurn()` returns a native AI SDK UI message stream; this is what the HTTP API and terminal UI use. `createHttpServer(agent)` serves the workbench. `agent.native` is the raw `ToolLoopAgent`; calls through it skip sessions, locks, runs and checks.

If a saved session contains tool calls whose definitions you have since removed or changed, continuing it throws `SessionCompatibilityError` and leaves the history untouched. Restore the tool or start a new session.

## 11. Compose agents

Core adds no scheduler. Declare helpers the agent can delegate to:

```ts
subagents: {
  reviewer: { description: 'Checks a draft against the source data.', instructions: 'Report unsupported claims briefly.', tools: ['readFile', 'listFiles'] },
},
```

The model calls `runSubagent({ agent: 'reviewer', task })`. The helper has its own short context, shares the turn's cancel signal, output directory and token budget, and only its final answer returns. For multi-step work the agent keeps a checklist with `updatePlan`, shown above the message box.

Or compose with plain code:

- **Delegate**: a native tool that calls a second agent ([delegation.ts](../examples/advanced/delegation.ts)).
- **Sequence**: run agents one after another and link the runs with `workflowId` and `parentRunId` ([two-agent-workflow.ts](../examples/advanced/two-agent-workflow.ts)).
- **Shape context**: pass a native `prepareStep` that keeps stable rules and saved artifact paths when old turns are dropped ([context-policy.ts](../examples/advanced/context-policy.ts)).

## 12. Limits and trust

| Limit | Default | Bounds |
| --- | --- | --- |
| `limits.maxSteps` | 20 (max 100) | model/tool loop steps per turn |
| `limits.timeoutMs` | 600000 | one turn; also the default script timeout |
| `limits.maxToolOutputBytes` | 1 MiB | each tool result and file read |
| `limits.maxContextChars` | 120000 | the history projection sent to the model |
| `limits.maxContextTokens` | none | also compact when the provider reports this many input tokens |
| `limits.maxTurnTokens` | none | tokens one turn may use, helpers included |
| `limits.maxRetries` | 2 | provider retries for 429/5xx, with backoff |

Full history always stays on disk. At 75% of the budget (`compaction.at`), older turns are summarized into one message the model sees instead; the last two turns stay verbatim. Set `compaction: false` to drop the oldest turns instead. Long tool results are clipped in the model's view, and the agent can page through them with `readToolOutput`. Stopping at the step or token budget records a failed execution.

### Measure it

Write `evals.json` with tasks your checker can grade:

```json
{ "cases": [{ "name": "fasta summary", "task": "Summarize the FASTA and validate it.", "repeat": 3 }] }
```

`lab-agent eval` runs each case in a fresh session, grades it with the checker and prints the pass rate, tokens and cost; the full report is saved in `.lab-agent/evals/`. Tool calls that need approval are denied during evals. Add `pricing: { default: { input: 3, output: 15 } }` (USD per million tokens) to see cost, and `telemetry` to export OpenTelemetry spans for each model call.

**Trust model.** `agent.config.ts`, registered Python, native tools and MCP servers are trusted code with your user's permissions; nothing is sandboxed. Model file tools are confined: they cannot see `.env*`, keys, `.git` or Core metadata (including through symlinks and hard links), and they write only where the policy allows. The workbench listens on 127.0.0.1, rejects foreign origins and requires a per-process token.

## Migrating from lab-agent-core (Pi)

Rewrite the model and tool configuration with native AI SDK types and move Python commands into `python.scripts`. `AGENTS.md`, Skills, data and checkers keep their role. Pi credentials, settings and extensions are not imported. See the [matched comparison](evidence/COMPARISON.md).

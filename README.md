# lab-agent-core-vercel

A small agent base built directly on the [Vercel AI SDK](https://ai-sdk.dev). The AI SDK runs the model/tool loop; Core adds what a long-lived project agent needs around it: persistent sessions, one tracked run per task, an independent checker, file-access boundaries, a CLI and a local browser workbench.

You describe the agent in one file:

```ts
// agent.config.ts
import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  python: { scripts: { analyze: { path: 'tools/analyze.py', description: 'Profile the input table.', modes: ['task'] } } },
  validation: { command: ['python3', 'tools/validate.py'] },
  ui: { title: 'Table Agent', accent: '#0f766e' },
}));
```

Requires Node 22.19+. Python 3.10+ is needed only for Python tools.

## How it fits together

```
  lab-agent CLI · TUI      browser workbench      your code
          │                       │                   │
          └──────── createAgent(config).streamTurn() ─┘
                                  │
                 ┌────────────────┼──────────────────┐
           session history   AI SDK ToolLoopAgent   runs/<id>/
           .lab-agent/       + tools: files, Python, run.json · output/
                             Skills, MCP, yours     checker → delivery
```

Every entry point goes through the same `streamTurn`. There is no second execution server and no custom model loop. The [architecture page](docs/architecture.html) walks through a turn step by step.

## Quick start

```sh
TGZ=https://github.com/EnzymeGroup/lab-agent-core-vercel/releases/download/v0.1.0-rc.3/lab-agent-core-vercel-0.1.0-rc.3.tgz
npx --yes --package=$TGZ create-lab-agent my-agent --template python   # or --template basic
cd my-agent && npm install $TGZ
cp .env.example .env        # set LAB_AGENT_MODEL and LAB_AGENT_API_KEY
npx lab-agent doctor        # checks setup; makes no model call
npx lab-agent dev           # workbench on http://127.0.0.1:8787
```

No credentials yet? From a built checkout, `npm run demo` starts the workbench against a clearly labeled local model fixture.

## What you write, what Core does

| You write | Core handles |
| --- | --- |
| `AGENTS.md`: role and rules | Chat and task sessions shared by CLI, SDK and browser |
| `.agents/skills/<name>/SKILL.md`: procedures loaded on demand | Cancellation, timeouts, retries, and a bounded, summarized model context over full on-disk history |
| `agent.config.ts`: model, tools, Python, MCP, checker, UI | A run record per task with inputs, code and outputs fingerprinted |
| `tools/*.py` and native `tool()` definitions | Running your checker after each task, and again on demand without the model |
| `data/`: source files | Path confinement, secret hiding, a loopback-only token-guarded server |

## Harness features

All off the native AI SDK loop, no scheduler. Each is one config field; see the [Guide](docs/GUIDE.md).

- **Approval**: `approval: ['writeFile', 'mcp_*']` pauses on those calls until someone approves or denies (workbench buttons, `lab-agent approve`).
- **Search**: `findFiles` (glob) and `searchFiles` (regex) walk the project through the same file policy as `readFile`.
- **Memory**: durable facts and lessons in `.lab-agent/memory/`, indexed for every new session; review or delete them in the workbench or with `lab-agent memory`.
- **Context**: older turns are summarized at 75% of the budget; clipped tool results can be paged with `readToolOutput`.
- **Self-repair**: `validation.repairAttempts` sends failed checks back to the agent.
- **Helpers and plans**: `subagents` adds `runSubagent`; `updatePlan` shows a checklist.
- **Steering**: send a note to a running turn; it arrives at the next step.
- **Cost and evals**: per-call `run.steps`, `pricing`, `limits.maxTurnTokens`, and `lab-agent eval` graded by your checker.

## Two ideas to know

**Chat vs task.** Both share one session history. A task also creates `runs/<id>/`, is the only mode where file tools can write (into that run's `output/`), and triggers the checker.

**Execution vs delivery.** `execution` records whether the agent loop finished; `delivery` records whether your checker accepted the output. They are separate fields, so a model saying "done" is never a passed check.

```sh
npx lab-agent run "Summarize the FASTA" --input data/input.fasta   # exit 0 passed · 2 partial · 1 failed
npx lab-agent check <run-id>                                       # recheck, no model call
```

## Documentation

- [Guide](docs/GUIDE.md): layout, models, tools, Skills, MCP, checkers, inputs, branding, embedding, composition
- [Reference](docs/REFERENCE.md): config fields, Agent API, CLI, HTTP API, storage and status meanings
- [Architecture](docs/ARCHITECTURE.md) and [architecture.html](docs/architecture.html): layers, source map, invariants; [framework.html](docs/framework.html): one-page teaching diagram (Chinese)
- [Extras](docs/EXTRAS.md): opt-in tool sets in `packages/extras`, kept out of Core (web search and fetch, HPC jobs, NCBI/UniProt/Ensembl, large-file inspection, environment capture)
- [Changelog](docs/CHANGELOG.md) · [Validation evidence](docs/evidence/VALIDATION.md)
- Examples: [FASTA summary](examples/sequence-summary/README.md), [CSV quality](examples/table-quality/README.md), [native composition](examples/advanced/README.md)

## Status and trust

`0.1.0-rc.3` is a GitHub prerelease tarball and is not on the npm registry. Automated tests use deterministic local HTTP fixtures. They establish integration behavior, not model reasoning quality; bounded live-provider trials are in [live validation](docs/evidence/LIVE-VALIDATION.md).

Config, Python and MCP code is trusted local code and is not sandboxed. The workbench binds to 127.0.0.1 and is a single-user local tool.

## Develop Core

```sh
npm ci
npm run verify          # typecheck, build, unit + consumer tests, docs check
npm run test:browser    # Playwright workbench tests
npm run pack:core       # .artifacts/lab-agent-core-vercel-<version>.tgz
```

Contributors should read [AGENTS.md](AGENTS.md) and [Architecture](docs/ARCHITECTURE.md) first.

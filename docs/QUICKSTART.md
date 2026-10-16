# Quickstart

Requires Node 22.19+. The basic template needs no Python; the python template needs Python 3.10+ and no third-party Python packages. The package has not been published to npm.

## Install a self-contained project

The [GitHub rc.3 prerelease](https://github.com/EnzymeGroup/lab-agent-core-vercel/releases/tag/v0.1.0-rc.3) contains the package. Replace the local tarball paths below with `https://github.com/EnzymeGroup/lab-agent-core-vercel/releases/download/v0.1.0-rc.3/lab-agent-core-vercel-0.1.0-rc.3.tgz` to create/install a project without cloning or building Core. The same native binary and templates are included. Formal npm registry publication still requires registry authentication.

From the repository root:

```sh
npm ci
npm run build
npm run pack:core
npx --yes --package=./.artifacts/lab-agent-core-vercel-0.1.0-rc.3.tgz create-lab-agent ../my-agent --template python
cd ../my-agent
npm install ../lab-agent-core-vercel/.artifacts/lab-agent-core-vercel-0.1.0-rc.3.tgz
cp .env.example .env
```

Use `--template basic` for a small native-tool project or `--template python` for FASTA analysis plus an independent checker. `minimal` remains an alias for python. The installed command `lab-agent init DIRECTORY --template NAME` provides the same scaffolds. The scaffold dependency follows the installed Core version.

Set LAB_AGENT_PROVIDER=openai, LAB_AGENT_MODEL to a tool-capable model ID and LAB_AGENT_API_KEY to its credential. LAB_AGENT_BASE_URL optionally selects an OpenAI-compatible endpoint ending in /v1. [Provider recipes](PROVIDERS.md) cover OpenAI, Anthropic, local vLLM/Ollama and native Google integration. Missing model/credential configuration fails explicitly.

The binary is **create-lab-agent inside the lab-agent-core-vercel package**. If this package is later published, the registry spelling will be `npx --package=lab-agent-core-vercel create-lab-agent my-agent --template basic`. A separate create-lab-agent npm package is not assumed to exist. The tarball command above works with the current unpublished build.

## Diagnose before inference

```sh
npx lab-agent inspect --json
npx lab-agent models --json
npx lab-agent doctor --json
# Optional, explicit and potentially billable:
npx lab-agent doctor --probe-model --json
```

Core's static inspect/models path loads trusted config, instructions, Skills, local native tool schemas and existing records. It does not initialize MCP or invoke a model. MCP entries are marked configured until connected. Doctor checks Node, the configured Python command's version, registered script existence/regular-file status and each MCP connection/list-tools/cleanup. It does not run analysis scripts. An unavailable optional MCP is a warning; an unavailable required MCP is a failed diagnostic. Default doctor performs no inference. The explicit probe sends one tiny tool-free request and establishes connectivity only.

## Run and open the workbench

```sh
npx lab-agent run "Load sequence-summary and summarize the supplied FASTA" --input data/input.fasta --json
npx lab-agent sessions --json
npx lab-agent dev
```

The python template writes summary.json and report.md under runs/<id>/output and reconstructs expected values from the original FASTA in its independent checker. The basic template demonstrates a native countText tool; no checker is configured, so its delivery is not_checked.

## Bind the actual task inputs

Use repeatable CLI `--input PATH`, the workbench task input selector, or SDK options:

```ts
const run = await agent.runTask('Analyze the selected CSV with its registered tool', {
  inputs: ['data/uploads/unique-source.csv'],
});
```

Per-task inputs override config.provenance.inputs. Without either selection, existing data/ files are enumerated once when the run is created. SDK `inputs: []` deliberately selects no inputs. Files/directories must already exist inside the project; at most 256 declarations and 4096 files are accepted. Directory selections freeze their current files. Adding an unrelated upload afterward does not alter an earlier baseline; changing/deleting/aliasing a recorded file fails recheck. Binding a path records provenance; configure your analysis tool to consume that path too. Merely mentioning a filename in the prompt is not input binding.

The workbench shows bound paths before submission and in run provenance. Uploading does not automatically insert text or send a message. Chat rejects explicit task input bindings. The sample computational Python registrations specify `modes: ['task']`; chat cannot call them. Other trusted native/MCP tools may have side effects in chat, so chat is not an execution sandbox.

Task mode creates a run and invokes its checker. Chat mode persists conversation without a delivery. CLI and browser use the same history. The workbench supports source uploads, tool/schema capabilities, bounded previews, artifacts, explicit Cancel and Recheck. **One project has one active operation**, including across sessions and CLI/server processes. Opening another session does not add execution capacity.

`lab-agent check RUN_ID --json` appends an independent observation without model inference or replacing the original check evidence. `lab-agent recover` diagnoses stale same-host dead-process ownership and never replays tools. Hard host/process crashes can leave detached processes outside that metadata recovery; operators must inspect/clean those processes or use OS isolation. `lab-agent chat` opens the official SDK terminal interface. All commands accept `--root PROJECT` when called elsewhere.

For a remote server, forward the loopback port: `ssh -N -L 8787:127.0.0.1:8787 USER@SERVER`, then open the local forwarded address. Use 4317 for the default demo. This does not create a hosted multiuser service.

## Customize without moving your project

Keep existing data/scripts in place; add a factory config:

```ts
import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  provenance: { inputs: ['data/input.fasta'] },
  python: { scripts: {
    summarize: { path: 'tools/summarize.py', description: 'Summarize the original FASTA.' },
  } },
  validation: { command: ['python3', 'tools/validate.py'], timeoutMs: 30000 },
}));
```

The env object merges the project's parsed .env with inherited process variables; explicit process values win. Loading projects never mutates process.env. Existing object configs calling modelFromEnv() remain supported through scoped config evaluation. Native tools/subprocesses receive the loaded project env through config.env. Never return that env object as a model-visible tool result.

Edit AGENTS.md for rules and `.agents/skills/<name>/SKILL.md` for progressive instructions. The Agent invokes runPython with `{script:'summarize',args:[]}`. Scripts receive AGENT_ROOT, AGENT_RUN_DIR, AGENT_OUTPUT_DIR and AGENT_RUN_ID. Write outputs only under AGENT_OUTPUT_DIR. A checker receives AGENT_CHECK_FILE and writes the documented structured report. Registered config/Python/MCP/native tools are trusted host code.

For existing repositories, Python virtualenv/uv, native tools, MCP and optional workflow hooks, see [Extensions](EXTENDING.md). `python3 workflows/run.py` drives the same CLI. Copy the complete [table-quality application](../examples/table-quality/README.md) for raw CSV preservation.

## Use the SDK

```ts
import { createAgent, loadAgentConfig } from 'lab-agent-core-vercel';

const agent = await createAgent(await loadAgentConfig(process.cwd()));
try {
  const run = await agent.runTask('Summarize the supplied FASTA', { inputs: ['data/input.fasta'] });
  console.log(run.execution, run.delivery, run.provenance);
  const turn = await agent.chat('Explain source limitations', { sessionId: run.session.id });
  console.log(turn.text);
} finally {
  await agent.close();
}
```

`agent.native` is an advanced escape hatch. Direct native calls bypass Core persistence, locks, provenance and independent delivery handling. Application code owns those responsibilities. Native delegation and explicit sequencing do not introduce a scheduler.

If a restored session's tool names/schemas no longer match, SessionCompatibilityError preserves its stored history and rejects continuation before appending text or creating a run. Restore compatible definitions or create a new session. Core does not silently rewrite old tool evidence.

## Try without provider credentials

Run `npm run demo` after building. `npm run demo -- --port 4318 --root /absolute/demo-project` chooses its loopback port and persistent directory. The model is a clearly labeled deterministic local fixture with real HTTP streaming/tool execution. This verifies integration, not provider reasoning quality, scientific discovery or human onboarding success.

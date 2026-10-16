# Quickstart

Node.js 22.19+ is required. The examples use Python 3.10+ and its standard library. This release candidate has not been published to npm.

## Build and install outside the repository

From the repository root:

```sh
npm ci
npm run build
mkdir -p .artifacts
npm pack -w lab-agent-core-vercel --pack-destination .artifacts
node packages/core/dist/create.js ../my-agent
cd ../my-agent
npm install ../lab-agent-core-vercel/.artifacts/lab-agent-core-vercel-0.1.0-rc.1.tgz
cp .env.example .env
```

Set LAB_AGENT_PROVIDER=openai, LAB_AGENT_MODEL to a tool-capable model ID and LAB_AGENT_API_KEY to its credential in .env. LAB_AGENT_BASE_URL optionally selects an OpenAI-compatible endpoint ending in /v1. For Anthropic set LAB_AGENT_PROVIDER=anthropic and use its model ID and credential. No default model or synthetic live credential is supplied. Missing model/credential configuration fails explicitly.

## Run and inspect

```sh
npx lab-agent inspect --json
npx lab-agent run "Load sequence-summary and summarize the supplied FASTA" --json
npx lab-agent sessions --json
npx lab-agent dev
```

Open the printed loopback URL. Task mode creates a run and invokes its configured checker; chat mode persists the conversation without creating a delivery. The CLI and browser restore the same histories. Tool arguments/results, session history, run state and downloadable outputs are visible in the workbench. Explicit Cancel propagates to model requests and registered subprocesses. Recheck reruns only the validator.

`lab-agent check RUN_ID --json` rechecks an existing result without another model call. `lab-agent recover` handles stale same-host dead-process ownership after interruption; it never replays tools. `lab-agent models` prints configured model information. `lab-agent chat` opens the terminal conversation entry point. All commands accept `--root PROJECT` when called elsewhere.

On a remote server, forward the printed loopback port to your computer, for example `ssh -N -L 8787:127.0.0.1:8787 USER@SERVER`, then open the local forwarded address. Use port 4317 instead for the default demo. The workbench is a trusted local interface; hosted multi-user execution requires an additional authenticated execution service.

## Customize the scaffold

Edit AGENTS.md for project rules. Add a task-specific `.agents/skills/<name>/SKILL.md` with name and description in YAML frontmatter. Only metadata is in the initial prompt; loadSkill reads the full instructions when requested. Put long reference material in sibling reference files and load it only when needed.

Register fixed Python entry points in agent.config.ts:

```ts
python: {
  scripts: {
    summarize: {
      path: 'tools/summarize.py',
      description: 'Summarize data/input.fasta without changing identifiers.',
      timeoutMs: 30000,
    },
  },
},
validation: { command: ['python3', 'tools/validate.py'], timeoutMs: 30000 },
```

The Agent invokes runPython with `{script:'summarize',args:[]}`. Core supplies AGENT_ROOT, AGENT_RUN_DIR, AGENT_OUTPUT_DIR and AGENT_RUN_ID. Scripts write delivery files under AGENT_OUTPUT_DIR. The checker reads the original input and outputs, writes its report to AGENT_CHECK_FILE, and exits nonzero on failed acceptance. Removing validation leaves delivery not_checked. Configuration and registered code are trusted project code.

The scaffold's `python3 workflows/run.py` invokes the same installed CLI and parses its JSON RunRecord. Copy the complete [table-quality example](../examples/table-quality/README.md) for a CSV starting point.

## Use TypeScript

```ts
import { createAgent, loadAgentConfig } from 'lab-agent-core-vercel';

const agent = await createAgent(await loadAgentConfig(process.cwd()));
try {
  const run = await agent.runTask('Summarize the supplied FASTA');
  console.log(run.execution, run.delivery, run.artifacts);
  const turn = await agent.chat('Explain the source limitations', { sessionId: run.session.id });
  console.log(turn.text);
} finally {
  await agent.close();
}
```

Add custom tools using native `tool()` from ai and a schema from zod. Delegate through a native ToolLoopAgent, or explicitly sequence two Agents in application code; see [native examples](../examples/advanced/README.md). `agent.native` is an advanced escape hatch outside Core persistence and automatic delivery handling.

## Try without a live provider

Run `npm run demo` from the repository after building. Use `npm run demo -- --port 4318` to change the port, or `--root /absolute/project` to choose its persistent demo directory. The workbench displays a deterministic-demo label. This local fixture makes genuine Chat Completions requests and tool loops while returning fixed model decisions. It does not measure live reasoning or scientific validity.

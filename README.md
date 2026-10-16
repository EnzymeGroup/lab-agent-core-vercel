# lab-agent-core-vercel

A small application kit for scientific Agents built directly on the Vercel AI SDK. Core provides persistent sessions, task records, registered Python tools, Skills, MCP, an installed CLI and a Next.js workbench. Your project supplies instructions, native tools and an independent delivery checker.

This is an independent implementation. Pi packages are not runtime dependencies. Execution and delivery are separate: a completed model loop can still produce failed, partial or unchecked delivery.

Requires Node.js 22.19+ and Python 3.10+ for the examples. The package is an unpublished local release candidate; use a built tarball.

```sh
git clone https://github.com/EnzymeGroup/lab-agent-core-vercel.git
cd lab-agent-core-vercel
npm ci
npm run build
npm run demo
```

Open the printed loopback URL. This is a visibly labeled deterministic local demo: a local OpenAI-compatible fixture drives real AI SDK streaming, Skills and Python calls. It verifies integration, and does not establish live-provider reasoning quality. The demo project and sessions persist in `.artifacts/demo-project`.

To create an independent project:

```sh
mkdir -p .artifacts
npm pack -w lab-agent-core-vercel --pack-destination .artifacts
node packages/core/dist/create.js ../my-agent
cd ../my-agent
npm install ../lab-agent-core-vercel/.artifacts/lab-agent-core-vercel-0.1.0-rc.1.tgz
cp .env.example .env
# Set LAB_AGENT_MODEL and LAB_AGENT_API_KEY in .env.
npx lab-agent run "Summarize the supplied FASTA" --json
npx lab-agent dev
```

The scaffold contains a complete FASTA application with a Skill, registered stdlib Python script, an independent source-based validator and a Python CLI driver. The [table-quality example](examples/table-quality/README.md) preserves CSV values and distinguishes empty and absent cells.

| Change | Location |
| --- | --- |
| Role and project rules | AGENTS.md |
| Progressive task instructions | .agents/skills/<name>/SKILL.md |
| Model, native tools, Python registration, MCP and checker | agent.config.ts |
| Python analysis | tools/ |
| Python-driven orchestration | workflows/run.py |
| Persisted conversation history | .lab-agent/sessions/ |
| Outputs and independent checks | runs/<id>/ |

Read [Quickstart](docs/QUICKSTART.md), [Tools, Python and MCP](docs/EXTENDING.md), [Conventions](docs/CONVENTIONS.md), [Architecture](docs/ARCHITECTURE.md), [Comparison with the Pi implementation](docs/COMPARISON.md), and [Validation evidence and limits](docs/VALIDATION.md). Native [delegation and two-Agent workflow examples](examples/advanced/README.md) use ToolLoopAgent directly.

Maintainers: `npm run verify` checks types, builds, runtime tests, installed-package consumers and documentation. `npm run test:browser` runs Playwright against the compiled workbench. No credentials are bundled or required for fixture tests.

# lab-agent-core-vercel

A scientific Agent application kit built directly on Vercel AI SDK. Core provides persistent chat/task sessions, named Python tools, progressive Skills, MCP, independent delivery checks and a Next.js workbench. Your project supplies scientific procedures and acceptance criteria. Pi is not a runtime dependency.

Requires **Node 22.19+**. Choose **basic** for native JavaScript tools, or **python** for the complete FASTA application with stdlib Python 3.10+, a Skill and an independent checker. The [rc.3 GitHub prerelease](https://github.com/EnzymeGroup/lab-agent-core-vercel/releases/tag/v0.1.0-rc.3) provides an installable tarball. The package is not published to the npm registry.

Install from the versioned release without cloning Core:

```sh
npx --yes --package=https://github.com/EnzymeGroup/lab-agent-core-vercel/releases/download/v0.1.0-rc.3/lab-agent-core-vercel-0.1.0-rc.3.tgz create-lab-agent my-agent --template python
cd my-agent
npm install https://github.com/EnzymeGroup/lab-agent-core-vercel/releases/download/v0.1.0-rc.3/lab-agent-core-vercel-0.1.0-rc.3.tgz
cp .env.example .env
# Set LAB_AGENT_MODEL and LAB_AGENT_API_KEY in .env.
npx lab-agent doctor
npx lab-agent dev
```

From this repository:

```sh
npm ci
npm run build
npm run pack:core
npx --yes --package=./.artifacts/lab-agent-core-vercel-0.1.0-rc.3.tgz create-lab-agent ../my-agent --template python
cd ../my-agent
npm install ../lab-agent-core-vercel/.artifacts/lab-agent-core-vercel-0.1.0-rc.3.tgz
cp .env.example .env
# Set LAB_AGENT_MODEL and LAB_AGENT_API_KEY in .env.
npx lab-agent doctor
npx lab-agent run "Summarize the supplied FASTA" --input data/input.fasta --json
npx lab-agent dev
```

`inspect` and `models` inspect configuration without connecting MCP or a provider. `doctor` checks the actual Node/Python configuration and MCP connectivity; **only `doctor --probe-model` makes an explicit model request**. Config is trusted executable project code.

For a credential-free integration demo, run `npm run demo` from the built repository. Its workbench visibly identifies the deterministic local model fixture. Real AI SDK streaming and Python analysis run, but this is not live reasoning or human usability evidence. Demo sessions persist in `.artifacts/demo-project`.

| Project concern | Location |
| --- | --- |
| Role and source-use rules | AGENTS.md |
| Progressive procedures | .agents/skills/<name>/SKILL.md |
| Native model/tools, Python/MCP, checker and input provenance | agent.config.ts |
| Project environment, isolated from other projects | .env; factory receives `{root, env}` |
| Scientific source data | data/; uploads are immutable unique files |
| Python entry points and Python-driven orchestration | tools/ and workflows/ |
| Persistent conversation evidence | .lab-agent/sessions/ |
| Run, artifact hashes and independent check observations | runs/<id>/ |

One project permits one active operation. Task input bindings freeze the exact source files used for provenance; an unrelated later upload does not invalidate earlier runs. Analysis mode confines file-tool writes to the current run output; development edits require explicit write roots. Config, Python, native tools and MCP remain trusted host code. Computational Python examples are task-only, while chat still may call other trusted side-effecting tools. Execution completion and accepted delivery are separate; basic has delivery `not_checked` until you add a checker.

Start with [Quickstart](docs/QUICKSTART.md), [provider recipes](docs/PROVIDERS.md), [existing-project adaptation and extensions](docs/EXTENDING.md), [conventions](docs/CONVENTIONS.md), [architecture](docs/ARCHITECTURE.md), [review issue ledger](docs/REVIEW-LEDGER.md), [compatibility changes](docs/CHANGELOG.md), [large-file measurements](docs/BENCHMARK.md), and [validation evidence](docs/VALIDATION.md). The [CSV example](examples/table-quality/README.md) retains identifiers and missingness; [native examples](examples/advanced/README.md) demonstrate cooperative tools, context preparation, delegation and an explicit two-Agent sequence.

Maintainers use `npm run verify`, `npm run test:browser` and `npm run pack:core`. See [live-provider trials](docs/LIVE-VALIDATION.md) for the three bounded rc.3 application results; deterministic tests do not establish live-provider quality or measured newcomer usability.

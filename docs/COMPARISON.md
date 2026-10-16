# Comparison with lab-agent-core

This sibling implementation retains the application boundary of lab-agent-core: the SDK executes model/tool loops, Core records tasks and independently checks delivery, and the project supplies scientific knowledge and acceptance criteria. It does not import, patch or wrap the Pi runtime.

| Area | Existing lab-agent-core | This implementation |
| --- | --- | --- |
| Model/tool runtime | Pi Agent SDK | Vercel AI SDK ToolLoopAgent |
| Model selection | Pi settings/provider/auth conventions | Native LanguageModel plus explicit environment/provider helper |
| Native extension | Pi extension API | Native ai `tool()` and schemas |
| Python execution | Pi Bash-based project scripts | Explicit registered Python entry points, argv without shell |
| Skills | Pi-native project conventions | Metadata discovery plus loadSkill progressive loading |
| MCP | Pi MCP integration | @ai-sdk/mcp with named tools and lifecycle cleanup |
| Browser surface | Task-delivery page plus linked native Pi Web | One Next.js workbench sharing persistent task/chat sessions |
| Streaming format | Pi runtime and UI interfaces | Native AI SDK UIMessage stream and DefaultChatTransport |
| Chat/task history | Existing Pi/native conversation boundary | Shared persisted UIMessage sessions across CLI, SDK and HTTP |
| Check semantics | Core independent task delivery checks | Same execution/delivery distinction with strict check report handling |
| Composition | Pi-native extensions | Native delegated tool or explicit application sequence |

The frontend change is an integration choice, not evidence of better scientific reasoning. Fixed fixtures can establish HTTP/tool/persistence/checker behavior. They cannot establish provider quality, biological correctness, general benchmark gains or newcomer usability. No live-provider performance benchmark or human usability study has been run for this release candidate.

## Executed matched engineering comparison

On 2026-10-16, the optional comparison script executed both the new Core and the already-built local lab-agent-core against the same two applications. All **4/4 framework/application scenarios passed** initial execution and independent delivery. Each task made **3 streamed HTTP requests**, for **12 total**: loadSkill, runPython, final response. Each source-based validator rejected deliberately altered computed output on recheck, with **zero additional model requests**.

| Application | Source size | New Core | Existing Pi Core | Computed deliverables |
| --- | --- | --- | --- | --- |
| Sequence summary | 4 FASTA records | completed / passed; tamper → failed | completed / passed; tamper → failed | summary.json and report.md byte-identical across runtimes |
| Table quality | 5 CSV rows | completed / passed; tamper → failed | completed / passed; tamper → failed | profile.json and report.md byte-identical across runtimes |

Reproduce after building this repository, while retaining an already-built sibling Pi implementation:

```sh
node scripts/compare-pi.mjs --pi-root ../lab-agent-core
```

`--output DIRECTORY` changes the evidence destination. The default `.artifacts/comparison/results.json` records runtime versions, input and implementation SHA256 digests, exact artifact digests and per-scenario tool/request summaries. Scenario directories retain native session history, full model requests, initial/tampered run and check reports, and the original correct deliverables. A source snapshot preserves the exact input, analysis code, validator, instructions and Skill. Temporary project paths inside archived records are historical; temporary roots are deleted after capture.

This is a matched integration protocol with explicit adapters. Both runtimes expose only the named loadSkill and fixed runPython tools, execute the same unchanged Python analysis/validator, use the same task text and deterministic Chat Completions fixture, and follow the same three-request plan. The new Core's documented native tool map is narrowed for this comparison to remove its default file tools. Pi's native customTools interface supplies a fixed Skill loader and registered Python adapter; Bash, file mutation tools and optional builtin extensions are disabled. The Pi Python adapter uses the new Core's same shell-free subprocess runner, so this comparison does not compare different subprocess implementations. A three-turn guard and 60-second task deadline bound Pi; the new Core uses its three-step/60-second limits. Python and checker deadlines are 30 seconds in both.

Pi is dynamically imported only from the supplied existing build and its pinned SDK (observed Pi SDK 1.2.0; existing Core 0.1.0). No Pi package becomes a dependency of the new Core. Each Pi process starts with its own temporary PI_CODING_AGENT_DIR; provider config, trust and native sessions stay there. The comparator does not rebuild or edit the old source, import global trust/credentials, or claim stock-default parity. Different framework system prompts and session schemas remain native to each runtime.

The supported conclusion is bounded: both implementations completed these two source-preserving delivery paths under identical fixed model decisions, and their independently checked computed outputs agreed exactly. This does not establish better reasoning, better human usability, lower latency, reduced model cost or superiority on scientific tasks.

Migration requires rewriting model/tool configuration against native AI SDK types and moving Python commands into the explicit registry. AGENTS.md, task-specific Skills, source data and independent Python validators can retain their scientific role. Pi credentials, settings and extensions are not silently imported. See [Quickstart](QUICKSTART.md) for the new project layout.

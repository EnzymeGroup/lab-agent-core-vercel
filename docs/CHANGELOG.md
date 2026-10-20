# Changes and compatibility

## Unreleased

Repositioned as a general agent base; the FASTA and CSV applications remain as examples. Execution, delivery, provenance and safety semantics are unchanged; all existing tests pass.

Breaking:

- Package binaries moved to `dist/cli/main.js` (`lab-agent`) and `dist/cli/create.js` (`create-lab-agent`). Code importing deep `dist/*.js` paths must use the package entry point; module layout is now `config/ agent/ tools/ workspace/ store/ runs/ server/ cli/`.
- The `minimal` template alias is removed. Use `--template python`.
- Upload rejection for non-text bodies now reads "Only UTF-8 text files can be imported."
- Two built-in tools, `updatePlan` and `readToolOutput`, are always registered; a project tool with either name now fails as a duplicate.
- Compaction is on by default and makes one extra model call when the view reaches 75% of the budget. Set `compaction: false` for the previous drop-oldest behavior.
- Model calls now retry twice on 429/5xx. Set `limits.maxRetries: 0` for the previous behavior.
- New built-in names `findFiles`, `searchFiles`, `saveMemory`, `readMemory` and `forgetMemory`; a project tool with one of them now fails as a duplicate. Memory is on by default and adds its rules to the system prompt and an index to each turn; set `memory: false` to turn it off.

Added:

- `models` config and a per-session `model` choice (SDK, HTTP and workbench picker). Runs record `model.key`; unknown keys are rejected.
- Assistant messages carry `metadata` with the model, the bounded context size of the latest step (`chars`, `maxChars`, dropped messages, clipped results) and token usage. The workbench shows it as a context meter.
- `skills.read` / `GET /api/skill` return full `SKILL.md` text without marking the Skill as loaded; Skills expand in Capabilities.
- Project HTTP MCP servers: `mcp.test/add/remove` and `/api/mcp*`, stored in `.lab-agent/mcp.json`, applied between turns without restart. stdio MCP stays config-only. `doctor` and `inspect` include project servers.
- Tool approval: `approval` lists tools that pause the turn (native AI SDK `toolApproval`). Sessions and runs gain the non-terminal `awaiting_approval` state; `respond`, `approve`, `lab-agent approve` and approval responses on `/api/chat` continue the same message and run. The workbench shows Approve/Deny on the call.
- Provider retries with backoff (`limits.maxRetries`, default 2; previously no retries) and repair of misspelled tool names.
- Compaction (`compaction`, on by default at 75% of the budget): older turns are summarized into `session.summary` for the model's view; history is never rewritten. `compact()` / `POST /api/compact` on demand. `limits.maxContextTokens` adds a token trigger. Clipped tool results can be paged with the new `readToolOutput` tool. The system prompt carries Anthropic `cacheControl`.
- Automatic repair loop: `validation.repairAttempts` sends a failed or partial check back to the agent on the same run. Checks gain `kind: 'repair'`; `run.repairs` counts attempts.
- Helpers: `subagents` config and the `runSubagent` tool (native `ToolLoopAgent` inside the tool call, own context, shared signal and budget). `updatePlan` records a checklist shown above the composer.
- Steering: `steer()` / `POST /api/steer` queue a message for the running turn; it reaches the next step and is stored as a user message. The composer sends to a running turn.
- Telemetry: `run.steps[]` per model call (agent, model, finish reason, usage, time, tools), `run.costUsd`, `session.usage`, `pricing` config, `limits.maxTurnTokens` and a `telemetry` pass-through.
- Search: `findFiles` (glob) and `searchFiles` (regex, line numbers) walk the workspace under the file policy; no external binary.
- Project memory: `.lab-agent/memory/<name>.md` entries written by the agent (`saveMemory`, `readMemory`, `forgetMemory`), indexed each turn and recorded in run provenance (`provenance.memory`). `memory.*`, `GET/DELETE /api/memory`, `lab-agent memory` and Capabilities → Memory read and delete them.
- `lab-agent eval` / `runEvals` / `loadEvalFile`: run `evals.json` cases and grade them with the checker; reports in `.lab-agent/evals/`.

- `ui` config (`title`, `tagline`, `accent`, `starters`) for workbench branding. Presentation only; excluded from provenance. Returned by `/api/state` and `inspect`.
- Uploads and previews accept `.yaml`, `.yml` and `.log`.
- `acquireOperation`, `lockOwner`, `RunError`, `SessionCompatibilityError`, `describeTools`, `pythonToolAllowed` and `templates` are public exports.

Changed:

- Workbench redesigned as an agent workspace with Tailwind CSS v4 and shadcn-style components: tool calls and reasoning shown as a step timeline, an activity bar with the current step, a docked composer, starter prompts, Execute → Check → Deliver run progress and Markdown replies. The look is flat and neutral (no gradients, glows, blur or decorative motion); `ui.accent` only colors primary buttons and the focus ring.
- Internals restructured for readability: the turn lifecycle is split into accept / finish / resources, one operation gate replaces two duplicated busy-state machines, the checker runs as three named stages, and the HTTP server and CLI use route and command tables.
- Layering is strictly bottom-up: hashing moved to `store/hash.ts`, so tools no longer import from `runs/`. Shared `ifExists`, `isOpaqueId` and request-body helpers replace repeated inline copies; `doctor` uses `errorMessage` directly instead of a second redaction wrapper.
- Docs consolidated into README, [Guide](GUIDE.md), [Reference](REFERENCE.md) and [Architecture](ARCHITECTURE.md); evidence moved to `docs/evidence/`.

## 0.1.0-rc.3

- Task input bindings support SDK inputs, repeatable CLI --input and the workbench selector. Selected files are frozen at acceptance; unrelated uploads no longer invalidate earlier provenance. Explicit empty input arrays select no inputs. Existing rc.2 baselines are also rechecked as frozen file sets.
- Skill provenance distinguishes available instructions from instructions actually loaded. Used Skill edits fail integrity; unrelated unused Skill changes do not. Supporting reference files need explicit registration.
- Computational Python examples/templates are task-only. Registration defaults retain both modes for existing applications; trusted native/Python/MCP execution is still not sandboxed.
- Incompatible historical tool definitions produce an actionable SessionCompatibilityError without rewriting stored evidence or accepting a new run.
- Native examples add stable-rule/artifact-reference context preparation and validated domain arguments to cooperative Python execution. An opt-in generated-byte benchmark isolates large-input hashing/checking from model latency.
- Real-provider trials exposed ambiguous Skill/output paths. Named Skill retrieval now returns explicit source/directory/reference guidance; runPython includes cwd and project-relative outputDirectory. Fresh live and external installed-data trials passed after the correction.

The package is supplied as a GitHub release candidate tarball; the npm registry remains unpublished. Provider probes, actual public-reference metadata adaptation, generated-byte I/O measurements, human onboarding and formal registry publication are separate evidence categories; see [Validation](evidence/VALIDATION.md).

## 0.1.0-rc.2

This remains an unpublished release candidate. The changes address source boundary and onboarding reviews while retaining native AI SDK execution and UI messages.

- Analysis is the default file-tool mode: writes are confined to the current task output. Existing projects that intentionally edit source must opt into development mode with explicit write roots. Environment/credential/internal metadata aliases remain protected. Trusted Python/native/MCP execution is not sandboxed.
- Run schema v2 records runtime versions, configured input and relevant code hashes, and artifact hashes. Rechecks append evidence observations and preserve originalDelivery. Old records remain readable without inventing missing provenance.
- Static inspect/models no longer connect MCP. Doctor exposes actual environment/MCP failures; model inference requires --probe-model. Optional MCP failures remain visible instead of blocking unrelated runtime capabilities.
- Config factories receive `{root, env}`. Project dotenv parsing no longer mutates process.env; existing object configs remain supported. Inherited explicit process variables take precedence over .env.
- basic and python templates are installed with the package; minimal remains a python alias. Creation uses `npx --package=lab-agent-core-vercel create-lab-agent`, or the current local tarball equivalent. There is no assumed separate create-lab-agent package.
- Workbench additions include uploads, bounded safe previews and detailed capabilities. One-project-one-active-operation semantics remain unchanged.
- Native prepareStep and run linkage metadata support application-owned workflows; no scheduler or separate execution protocol is added.

Observed automated results belong in [Validation](evidence/VALIDATION.md). [Review ledger](evidence/REVIEW-LEDGER.md) separates implementation changes from unavailable provider/human/publication evidence.

## 0.1.0-rc.1

Initial independent AI SDK implementation: persistent native UIMessage sessions, task execution/check separation, registered Python, Skills, MCP, CLI, installed static workbench, two source-preserving Python applications and deterministic integration fixtures.

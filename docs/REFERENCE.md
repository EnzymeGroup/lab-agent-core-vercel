# Reference

Exact contracts. For explanations and examples, see the [Guide](GUIDE.md).

## agent.config.ts

```ts
export default defineAgent(config)                 // AgentConfig object
export default defineAgent(({ root, env }) => config) // factory; env = project .env + process env
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `root` | string | required | Must equal the project directory. |
| `model` | AI SDK `LanguageModel` | required | `modelFromEnv(env)` or any native provider model. Offered as `default`. |
| `models` | `Record<string, LanguageModel>` | none | Extra models a session may choose. Keys: 1–40 of `A-Za-z0-9_-`; `default` is reserved. |
| `instructions` | path or `{ text }` | `AGENTS.md` if present | ≤128000 chars. |
| `skillsDir` | string | `.agents/skills` | |
| `tools` | `ToolSet` | `{}` | Native `tool()` definitions. |
| `python` | `{ command?, args?, scripts }` | none | `command` default `python3`; `args` is an argv prefix. |
| `python.scripts.<name>` | `{ path, description, modes?, timeoutMs? }` | | `modes` default both; `[]` disables. |
| `mcp.<name>` | `{ transport: 'stdio'\|'http', command?, args?, env?, url?, headers?, optional? }` | | Tools are named `mcp_<name>_<tool>`. |
| `validation` | `{ command: string[], timeoutMs?, repairAttempts? }` | none | Checker argv; timeout default 120000. `repairAttempts` (0–5, default 0) sends a failed or partial report back to the agent. |
| `approval` | `string[]` | `[]` | Tools that pause for a person's decision. Exact names, a `prefix*`, or `*`. |
| `subagents.<name>` | `{ description, instructions, tools?, model?, maxSteps? }` | none | Exposed through `runSubagent`. `tools` default: every tool that needs no approval, minus `runSubagent`, `updatePlan` and the memory tools. `maxSteps` default 8. |
| `pricing.<modelKey>` | `{ input, output, cachedInput? }` | none | USD per million tokens for `default` or a `models` key. |
| `compaction` | `{ at?, keepTurns?, model? }` or `false` | `{ at: 0.75, keepTurns: 2 }` | Summarize older turns when the model's view reaches `at` of the budget. |
| `memory` | `boolean` | `true` | Project memory in `.lab-agent/memory/` with `saveMemory`, `readMemory` and `forgetMemory`; `false` removes the tools, rules and index. |
| `telemetry` | AI SDK `telemetry` | none | Passed to every model call (OpenTelemetry spans). |
| `fileAccess` | `{ mode?, readRoots?, writeRoots? }` | `{ mode: 'analysis' }` | `writeRoots` apply only in `development`. |
| `provenance` | `{ inputs?, code? }` | inputs: `data/` | Extra files fingerprinted per task. |
| `prepareStep` | AI SDK `prepareStep` | none | Runs between Core's bounded context projections. |
| `limits` | `{ maxSteps?, timeoutMs?, maxToolOutputBytes?, maxContextChars?, maxRetries?, maxContextTokens?, maxTurnTokens? }` | 20 · 600000 · 1 MiB · 120000 · 2 · none · none | Positive integers (`maxRetries` may be 0, ≤10); `maxSteps` ≤100. `maxRetries`: provider retries with backoff for 429/5xx. `maxContextTokens`: compaction also triggers on the provider's reported input tokens. `maxTurnTokens`: stop a turn once it has used this many tokens. |
| `ui` | `{ title?, tagline?, accent?, starters? }` | | Presentation only; excluded from provenance. `title` ≤60, `accent` `#rrggbb`, ≤6 `starters` of `{ title, prompt, mode? }`. |
| `env` | `ProcessEnv` | set by loader | Passed to Python, checkers and MCP; never shown to the model. |

### Model environment

`modelFromEnv` reads `LAB_AGENT_PROVIDER` (`openai` default, or `anthropic`), `LAB_AGENT_MODEL` (required), `LAB_AGENT_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and optional `LAB_AGENT_BASE_URL` (or `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`). OpenAI-compatible endpoints use Chat Completions. Credentials never appear in `inspect`, `/api/state` or error messages.

## Agent API

`createAgent(config)` returns:

| Member | Behavior |
| --- | --- |
| `streamTurn({ message, sessionId?, messageId?, mode?, model?, inputs?, attachments?, workflowId?, parentRunId?, signal? })` | → `{ sessionId, runId?, stream, completed, cancel }`. `stream` is a native `UIMessageChunk` stream; Core persists its own copy, so dropping the reader never stops accepted work. `mode` defaults to `chat`; `inputs` is task-only. `attachments` (≤8 project paths, `.png .jpg .jpeg .gif .webp .pdf`, ≤10 MiB each) are shown to the model with this message; whether a model accepts them depends on its provider. `model` (`default` or a `models` key) becomes the session's model; omitted keeps the session's choice. Assistant messages carry `metadata: { model, context, usage, notice? }`. |
| `runTask(task, options?)` | Runs a task to completion → `RunRecord`. Throws `RunError` (with `.run`) if execution failed. A task paused for approval returns with `execution: 'awaiting_approval'`. |
| `chat(message, options?)` | Runs a chat turn → `{ session, text, error?, pendingApprovals? }`. |
| `respond({ sessionId, approvals, signal? })` | Answers a paused turn. `approvals: [{ approvalId, approved, reason? }]`, one per pending call → `TurnStream` continuing the same assistant message and run. |
| `approve(sessionId, approved \| decisions, reason?)` | `respond` for every pending call, then waits → `TurnResult`. |
| `steer(sessionId, text)` | Queues a message for the turn running in that session → `{ queued }`. `InputError` if none runs in this process; `BusyError` once it is finishing. |
| `compact(sessionId)` | Summarizes older turns now → `SessionRecord`. `InputError` when compaction is off or nothing is old enough. |
| `runs.check(id)` | Reruns the checker without the model → `RunRecord`. |
| `runs.load / list / report` | Read run records and the latest check report. |
| `sessions.load / list / create` | Read or create sessions. |
| `skills.list()`, `skills.read(name)` | Discovered Skills; full `SKILL.md` text. Reading never marks a Skill as loaded. |
| `memory.list()`, `memory.read(name)`, `memory.forget(name)` | Project memory entries `{ name, description, type, content, updatedAt }`. |
| `tools.settings()`, `tools.update({ name, enabled?, alwaysAllow? })` | Project tool switches `{ disabled, alwaysAllow }`. `enabled: false` removes a tool from the model's active tools (a call to it is refused, never run). `alwaysAllow` applies only to tools that need approval (listed in `approval` or declaring `needsApproval`) and stops them pausing. Changed under the project lock; applies from the next model call. |
| `mcp.list / test / add / remove` | Config and project MCP servers. `test` connects once and lists tools; `add`/`remove` change project HTTP servers under the project lock and reconnect. |
| `cancel()` | Aborts the active operation → `boolean`. |
| `recover()` | Marks crash leftovers as interrupted; never replays tools. |
| `inspect()` | Project state as served by `/api/state`. |
| `close()` | Waits for the active operation to settle, then closes MCP. |
| `native` | The current `ToolLoopAgent` (replaced when project MCP servers change). Bypasses sessions, locks, runs and checks. |

Errors: `BusyError` (another operation owns the project), `InputError` (invalid request), `NotFoundError`, `RunError`, `SessionCompatibilityError` (stored tool calls no longer match current tools; history unchanged).

Lower-level exports for custom tools: `getExecutionContext`, `runWithExecutionContext`, `runCommand`, `createWorkspace`, `createTools`, `loadSkill`, `listMemory`, `readMemory`, `saveMemory`, `forgetMemory`, `connectMcp`, `acquireOperation`, `checkRun`, `createHttpServer`.

## CLI

`lab-agent <command> [--root DIR] [--config FILE] [--json]`

| Command | Effect | Exit code |
| --- | --- | --- |
| `init <dir> --template basic\|python` | Scaffold a project (same as `create-lab-agent`). | 0 / 1 |
| `dev`, `serve [--port N]` | Workbench on 127.0.0.1 (default port 8787). | 0 on Ctrl-C |
| `chat [--session ID]` | Terminal UI over the same session API. | 0 / 1 |
| `run <task> [--input PATH]… [--attach FILE]… [--session ID]` | Run one task; prints the `RunRecord`. `--attach` shows an image or PDF to the model. | 0 passed or not_checked · 2 partial · 1 failed/aborted · 3 paused for approval |
| `approve --session ID [--deny] [--reason TEXT]` | Answer every pending tool call, then finish the turn. | as `run` |
| `eval [FILE] [--repeat N]` | Run `evals.json` (or FILE) cases and grade each with the checker; saves `.lab-agent/evals/<time>.json`. | 0 all passed · 1 otherwise |
| `check <run-id\|runs/path>` | Recheck without the model. | same as `run` |
| `memory [NAME] [--forget]` | List project memory, print one entry, or delete it; no model connection. | 0 / 1 |
| `sessions` | List sessions. | 0 |
| `inspect`, `models` | Static config view; no MCP or model connection. | 0 / 1 |
| `doctor [--probe-model]` | Check Node, Python, scripts and MCP; `--probe-model` sends one request. | 1 if any check failed |
| `recover` | Mark interrupted work; never replays tools. | 0 / 1 |

A failed task still prints its terminal `RunRecord` before exiting 1.

## HTTP API

Served by `createHttpServer` on 127.0.0.1 only. Requests with a foreign `Host`, `Origin` or `Sec-Fetch-Site: cross-site` get 403. `GET /api/bootstrap` returns `{ token, demo }` to the same-origin page; every other `/api/*` route needs `Authorization: Bearer <token>`.

For local port forwarding, set `createHttpServer(agent, { browserOrigin: 'http://localhost:54523' })` to allow that exact additional HTTP loopback origin. The direct server origin remains available; each origin must match its own Host and Origin headers, and token checks still apply. Remote hostnames and non-origin URLs are rejected. The demo accepts the same option: `npm run demo -- --browser-origin http://localhost:54523`.

| Route | Body / query | Response |
| --- | --- | --- |
| `GET /api/state` | | `{ project, busy, active, model, models, limits, approval, subagents, pricing, compaction, memory, skills, tools, toolDetails, mcp, fileAccess, pythonScripts, ui, sessions, runs, issues, demo }`. `memory` is `false` or entry summaries without `content`. `toolDetails[]` has `needsApproval`, `enabled` and `alwaysAllow`; `toolSettings` is `{ disabled, alwaysAllow }`. `mcp[]` has `source` (`config`/`project`), `tools`, and for project servers `url` and `headerNames`. |
| `GET /api/session` | `?id` | `SessionRecord` |
| `POST /api/sessions` | `{ title? }` | `SessionRecord` (201) |
| `POST /api/chat` | `{ sessionId, mode, model?, inputs?, attachments?, messages }` | AI SDK UI message SSE; headers `x-lab-session-id`, `x-lab-run-id`. Only the last message is read; history loads server-side. A user text message starts a turn. An assistant message with `approval-responded` parts (useChat `addToolApprovalResponse`) answers a paused turn; only the decisions are used. |
| `POST /api/steer` | `{ sessionId, text }` | `{ queued }` (202). 400 when no turn runs in that session, 409 while it is finishing |
| `POST /api/compact` | `{ sessionId }` | `{ summary, usage }`. 400 when off or nothing to summarize |
| `POST /api/cancel` | | `{ canceled }` |
| `GET /api/skill` | `?name` | `{ name, description, path, content }` |
| `PUT /api/tools` | `{ name, enabled?, alwaysAllow? }` | `{ disabled, alwaysAllow }`. 400 for an unknown tool or `alwaysAllow` on a tool that needs no approval; 409 while busy |
| `GET /api/memory` | `?name` | `{ name, description, type, content, updatedAt }` |
| `DELETE /api/memory` | `?name` | `{ forgotten }` |
| `POST /api/mcp/test` | `{ name, url, headers? }` | Status and `tools[{ name, description }]`; changes nothing |
| `POST /api/mcp` | `{ name, url, headers? }` | `{ servers, issues }` (201). HTTP(S) only, no embedded credentials; 409 while busy |
| `DELETE /api/mcp` | `?name` | `{ servers, issues }`. Project servers only |
| `GET /api/run` | `?id` | `{ run, check }` |
| `POST /api/check` | `{ runId }` | `RunRecord` |
| `GET /api/uploads` | | `{ files, maxBytes, extensions }` |
| `POST /api/uploads` | `?name=` + raw body | `{ path, name, bytes, sha256, importedAt }` (201) |
| `GET /api/preview` | `?runId&path` | `{ kind, path, bytes, truncated, content?, rows?, mediaType? }` |
| `GET /api/artifact` | `?runId&path` | file download |

Errors are `{ error: { message } }` with 400 invalid input, 403 origin/token, 404 not found, 409 busy, 500 execution or config failure. A failure after a stream has been accepted arrives as an SDK error part, and the run gets a terminal record.

Uploads: ≤10 MiB, ≤1000 per project. Text extensions `.csv .tsv .json .txt .md .yaml .yml .log .fasta .fa .fna .faa .pdb .cif` must be UTF-8; `.png .jpg .jpeg .gif .webp .pdf` must start with that format's signature. Each is stored once at `data/uploads/<uuid>-<name>`, read-only and never overwritten. Previews: text ≤256 KiB, CSV/TSV ≤50 rows × 30 columns, PNG/JPEG ≤10 MiB after a signature check. HTML and SVG are never previewed.

## Storage

```
.lab-agent/sessions/<id>.json     full UIMessage history, including tool calls and results
.lab-agent/operation.lock         { id, pid, host, startedAt }
.lab-agent/uploads/<uuid>.json    upload records
.lab-agent/mcp.json               project HTTP MCP servers (may hold header credentials)
.lab-agent/tools.json             project tool switches { disabled, alwaysAllow }
.lab-agent/evals/<time>.json      eval reports
.lab-agent/memory/<name>.md       project memory: YAML frontmatter (name, description, type, updatedAt) + body
runs/<id>/run.json                RunRecord (schemaVersion 2)
runs/<id>/output/                 deliverables; the only part of runs/ the model can see
runs/<id>/check.json, validation.log      latest check (convenience view)
runs/<id>/checks/<obs>/                   immutable snapshot of each check
```

Records are written atomically. Unreadable records show up as `issues` instead of hiding the rest.

## Status meanings

| Execution | Meaning |
| --- | --- |
| `running` | Accepted and not yet finished. |
| `awaiting_approval` | Paused on tool calls that need a decision. Not terminal and not recovered after a crash; `respond`/`approve` continues it. |
| `completed` | The model/tool loop ended with a final response. |
| `failed` | An error, a step or token budget stop, a timeout, or interruption by a crash (`finishReason: 'interrupted'`). |
| `aborted` | Explicit cancel or a controlled shutdown. |

| Delivery | Meaning |
| --- | --- |
| `not_checked` | No checker is configured, or no check has finished yet. |
| `passed` | Valid report with `status: passed` and exit code 0. |
| `partial` | Valid report with `status: partial`. |
| `failed` | Report says failed, nonzero exit, timeout, missing or invalid report, changed provenance, or files modified during the check. |

Execution and delivery are independent; `runTask` returns `completed` runs whose delivery may still be `failed`.

## Checker protocol

The command in `validation.command` runs as argv (no shell) with the project as cwd. Environment: the project env plus `AGENT_ROOT`, `AGENT_RUN_ID`, `AGENT_RUN_DIR`, `AGENT_OUTPUT_DIR` and `AGENT_CHECK_FILE`. It must write `{ status: 'passed'|'partial'|'failed', checks: [{ name, status, …}], issues: string[] }` (≤1 MiB) to `AGENT_CHECK_FILE`.

Each check runs three stages: (1) preflight compares recorded inputs, code and used Skills against the run's baseline and fails on any change; (2) the checker runs; (3) everything is rehashed, and a checker that modified files fails. `originalDelivery` keeps the first automatic observation; every check appends to `checks` with `kind` `initial`, `repair` (after an automatic repair attempt) or `recheck`. A check interrupted by a crash is recorded as failed and is not rerun.

## Provenance

Each run records the Core and AI SDK versions; SHA-256 of the frozen inputs (≤256 declarations, ≤4096 files); config, instructions, registered scripts, local checker files and `provenance.code`; every available `SKILL.md` (marked `loaded` when actually used); the memory entries listed to the model at task start (`memory[{ name, sha256, updatedAt }]`); attached images and PDFs (`attachments`); the tool switches in effect when any are set (`toolSettings`); the host `environment` (Node version, platform, arch, the configured Python's `--version` or `unavailable`, and `CONDA_DEFAULT_ENV`); a config hash and a checker hash; and the output hashes at completion. Hashes show byte identity, not correctness. Native modules, transitive dependencies and MCP server versions are not captured.

## Harness behavior

Approval. A tool needs approval when it matches `approval` or declares the AI SDK's `needsApproval` itself (`true`, or a function of its input decided per call). Core applies both through the native `toolApproval` hook. The turn ends with the call in state `approval-requested`; the session becomes `awaiting_approval` and new messages are refused until every pending call is answered. The decision is written onto the stored part and the same assistant message continues. Only the server's own pending calls can be answered. Helpers never receive tools that need approval.

Tool switches. `.lab-agent/tools.json` turns a tool off for the model (`activeTools` leaves it out for the main agent and helpers; the SDK refuses a call to it before approval or execution) or marks a tool that needs approval as always allowed. The config stays the ceiling: a switch can remove a tool or skip its pause, never add a tool. The workbench approval card's "Always allow" sets the switch, then approves.

Attachments. A user message may carry images or PDFs. History stores only a reference (`url: "project:<path>"`); each model call reads the bytes through the file policy, so secrets stay unreadable and sessions stay small. A file that later disappears or becomes denied is replaced by a note. File bytes do not count toward `maxContextChars`; provider token limits still apply.

Parallel helpers. The SDK runs tool calls of one step concurrently, so a model can start several `runSubagent` calls at once; they share the turn's cancel signal, budget and output directory.

Retries and repair. Model calls retry 429/5xx with exponential backoff (`limits.maxRetries`, default 2). A tool call whose name differs from a real tool only in case or punctuation (`list_files` → `listFiles`) is repaired; invalid inputs return the validation error to the model as a tool error.

Context. Full history stays on disk. The model's view is: the session summary (if any), then the newer messages, with long tool results clipped (`readToolOutput` pages through the full text during the turn) and the oldest turns dropped only if still over budget. Compaction runs at the start of a user turn, cuts on a user-message boundary and keeps the last `keepTurns` turns verbatim; `session.summary` records what it covers. A failed summary falls back to dropping turns and adds `metadata.notice`. The system prompt is sent with Anthropic `cacheControl`.

Repair loop. With `repairAttempts`, a completed task whose check is `failed` or `partial` gets an automatic user message (`metadata.source: 'repair'`) listing the issues, on the same lock and run, until the check passes or attempts run out. `run.repairs` counts attempts.

Helpers and plan. `runSubagent({ agent, task })` runs a configured helper as a native `ToolLoopAgent` inside the tool call: own instructions and short context, the turn's cancel signal, output directory, file policy and token budget. It streams progress and returns only its final text to the main context. `updatePlan({ items })` records a checklist shown above the composer.

Steering. `steer` text is appended to the model's view at the next step and stored as a user message (`metadata.source: 'steer'`) between the assistant messages around it. Text that arrives after the last step starts a follow-up segment on the same lock. A canceled turn drops queued text.

Search. `findFiles({ pattern, path?, limit? })` matches globs (`**`, `*`, `?`, `{a,b}`; a pattern without `/` matches file names) and `searchFiles({ pattern, path?, glob?, ignoreCase?, limit? })` matches a JavaScript regular expression line by line. Both walk the workspace through the same policy as `listFiles`/`readFile`, so secrets, metadata and paths outside `readRoots` never appear. They skip `node_modules`, `__pycache__`, virtualenvs and tool caches, do not follow symlinks, stop after 20000 entries, and `searchFiles` skips binary files and files over 1 MiB (counted in `skipped`).

Memory. Each entry is one file `{ name, description, type: user|feedback|project|reference, content ≤8000 }`, at most 100 per project. The system prompt carries the memory rules; the index (`- name [type]: description`) is appended to the latest user message of each segment and never stored in history. The model reads entries with `readMemory`, writes or replaces them with `saveMemory` and deletes them with `forgetMemory`; people do the same through `memory.*`, `lab-agent memory` or Capabilities. The repair message suggests saving a lesson. Helpers have no memory tools. Memory is shared by every session and eval in the project; clear it for an independent baseline.

Telemetry. `run.steps[]` records every model call `{ agent, model, finishReason, usage, ms, tools[{ name, ms?, error? }] }`, including helpers (`agent` = helper name) and summaries (`summary`). `run.usage`, `run.costUsd` and `session.usage { …, costUsd?, turns }` add them up; cost counts only models with a `pricing` entry.

Evals. `evals.json` is `{ cases: [{ name, task, inputs?, model?, repeat? }] }`. Each attempt is a fresh task session; it passes when execution is `completed` and delivery is `passed`. Pending approvals are denied. Requires `validation`.

## Concurrency and recovery

`streamTurn`, `runs.check`, `recover` and uploads take the project lock. A lock is reclaimed only when its owner is a provably dead process on the same host. Recovery marks running sessions `interrupted` and running runs `failed`, leaves `awaiting_approval` untouched, and never replays tools or checkers. A hard kill can leave detached child processes running; clean those up yourself or use OS-level isolation.

## File access

Model file tools resolve every path both lexically and through symlinks, and both must stay inside the project. Hidden in every mode: `.env*`, `.git`, `.ssh`, `.aws`, `.gnupg`, `.netrc`, `.npmrc`, `.pypirc`, `keys/`, `secrets/`, `credentials/`, `*.pem|key|p12|pfx|jks|keystore`, `id_rsa`-style keys, service-account files, `.lab-agent/`, and every part of `runs/<id>/` except `output/`. Hard-linked files are refused. `analysis` mode writes only into the active task's `output/`; `development` mode also allows `writeRoots`. `readRoots`, when set, restricts reads (registered Skills are exempt).

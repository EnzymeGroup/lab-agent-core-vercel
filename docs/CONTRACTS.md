# Implementation contracts

This is an independent AI SDK implementation. The Pi project is not a runtime dependency.

## Ownership
`packages/core/src/types.ts` owns shared contracts. Resource modules are `models.ts`, `process.ts`, `workspace.ts`, `skills.ts`, `mcp.ts`, `tools.ts`. Lifecycle modules are `config.ts`, `storage.ts`, `session.ts`, `delivery.ts`, `agent.ts`, `http.ts`, `cli.ts`. The Next.js client is exported as static assets and served with Core's single local HTTP backend. This keeps an installed package self-contained without a second execution server.

## Public configuration
`defineAgent({root, model, instructions?, skillsDir?, tools?, python?, mcp?, validation?, fileAccess?, provenance?, prepareStep?, limits?})` or `defineAgent(({root, env}) => config)`.
`model` is a native AI SDK LanguageModel. `instructions` is a file path or `{text}`. Defaults: AGENTS.md and .agents/skills. Python scripts are explicitly registered; no arbitrary shell tool. External tools use native `tool()`.

`loadAgentConfig` parses the project .env into a private context without changing process.env. Explicit process environment wins. Factories receive `{root,env}`; legacy object configs using `modelFromEnv()` evaluate in a scoped context. Registered Python, checkers and MCP receive the project environment. Diagnostics redact scoped credentials.

`fileAccess` defaults to `{mode:'analysis'}`: model reads/lists hide .env variants, internal metadata, .git and common credential/key paths, including canonical aliases and shared regular-file inodes. Optional readRoots narrows model reads. Registered Skills bypass only readRoots while retaining secret/path restrictions. Writes require an active task and its exact `runs/<current-id>/output/` directory. Development mode additionally allows explicit writeRoots during a task. Historical outputs remain read-only. Host-only workspace overrides do not appear in tool schemas.

`provenance.inputs` selects input files/directories; default is data/ (4096-file ceiling; files are streamed for SHA256). Config/instructions, registered scripts, local validator argv files, and explicit `provenance.code` files are fingerprinted. Config loaders include the selected config file. Native modules/transitive dependencies and external MCP implementation versions require explicit application provenance; this is not a hermetic environment snapshot. `prepareStep` is the native SDK hook, applied between Core's bounded projections; durable history remains unchanged.

`createAgent(config)` → `{native, streamTurn, runTask, chat, close, cancel, sessions, runs, inspect}`.
`streamTurn({message, sessionId?, mode?:'chat'|'task', signal?})` → `{sessionId,runId?,stream:ReadableStream<UIMessageChunk>,completed:Promise<TurnResult>,cancel}`. Core consumes its own stream for persistence independently of the UI reader. `runTask` and `chat` consume this same path. Native access is an advanced escape hatch outside automatic persistence/delivery.

## Storage and execution
- `.lab-agent/sessions/<id>.json`: authoritative AI SDK UIMessage history, state and error. IDs are opaque tokens. UI and CLI share these records.
- `.lab-agent/operation.lock`: atomic project lock with PID and hostname; operations are sequential across sessions/CLI/HTTP. Recover only a demonstrably dead same-host process. Never replay tools after a crash.
- `runs/<id>/{run.json,output/,check.json,validation.log}`: execution (`running/completed/failed/aborted`) and delivery (`not_checked/passed/partial/failed`) stay independent. v2 runs include Core/SDK versions, config/validation digests, input/code/artifact SHA256 and optional workflowId/parentRunId. Unversioned rc.1 records remain readable without fabricated provenance.
- `originalDelivery` preserves the first automatic check observation, including not_checked. Every check appends a separate observation and `checks/<id>/{check.json,validation.log}` snapshot. Rechecking never changes the original artifact/input/code baseline. Changed input/code/validation configuration fails provenance preflight; artifact differences remain visible separately from the domain verdict. Files modified by a checker fail integrity verification, including failed/nonzero/malformed checker paths.
- A pendingCheck marker clears the current verdict before validation starts. Crash recovery appends an interrupted failed observation without replaying the validator. The first observation remains intact. Snapshot files are protected from model file tools; trusted host code can still change them.
- Checker argv runs without a shell with AGENT_ROOT, AGENT_RUN_DIR, AGENT_OUTPUT_DIR, AGENT_CHECK_FILE. Rechecking makes no model call. No checker means not_checked. Invalid/missing report, nonzero exit or timeout means failed delivery.
- Complete UIMessage parts are persisted, including tool calls and results. Conversion for model calls ignores incomplete tool calls after interruption while preserving stored evidence. Context projection is bounded without deleting history.
- Cancel propagates to the SDK and registered subprocess groups. Browser disconnect does not silently cancel an accepted task; explicit cancel endpoint owns cancellation. A server crash records interrupted work on recovery.
- Native TypeScript/custom MCP tools must cooperate with AbortSignal. Core retains ownership until actual tracked execution settles; an uncooperative Promise can keep cancel/close pending indefinitely. Hard process termination may leave detached child groups or external jobs alive; metadata recovery does not terminate those jobs. Operators must settle such jobs before resuming side-effecting work, or use process/container supervision.
- Trusted local project. File tools enforce canonical paths, internal metadata protection and size limits. Registered Python/config/MCP code is trusted code, not a sandbox. Server binds loopback, rejects foreign Host/Origin and requires a per-process token on API requests (bootstrap token is delivered only to same-origin UI).

## HTTP
`GET /api/bootstrap` → `{token}` (same-origin guard).
All other APIs require `Authorization: Bearer <token>`.
- GET /api/state → `{project,busy,active,model,skills,tools,toolDetails,mcp,fileAccess,sessions,runs,issues}`; GET /api/session?id → SessionRecord. toolDetails contains native name/description/inputSchema; MCP status distinguishes connected/unavailable. One project permits one active operation.
- POST /api/sessions `{title?}` → SessionRecord.
- POST /api/chat `{sessionId,mode,messages:UIMessage[]}` → native AI SDK UI message SSE. Only the latest user message is accepted; previous history is loaded server-side. Response headers include x-lab-session-id and x-lab-run-id.
- POST /api/cancel → `{canceled}`; POST /api/check `{runId}` → RunRecord.
- GET /api/run?id → `{run,check}`; GET /api/artifact?runId&path → confined registered artifact.
- GET /api/uploads → `{files,maxBytes:10485760,extensions}`. POST /api/uploads?name=<filename> with raw UTF-8 text bytes imports a unique file under data/uploads/ and returns `{path,name,bytes,sha256,importedAt}`. Original bytes are preserved; files are created with mode0400, not overwritten, and recorded in host metadata. Filename<=180 UTF-8 bytes, <=10MiB/file, <=1000 imports. Scientific text extensions are allowed; code, HTML, SVG and binary bodies are refused. Import acquires the same operation lock; busy returns409.
- GET /api/preview?runId&path → `{kind,path,bytes,truncated,content?,rows?,mediaType?}` for registered artifacts. Text/JSON/Markdown content<=256KiB encoded UTF-8; CSV/TSV<=50rows/30columns, bounded cell text; PNG/JPEG signature and <=10MiB checked. Raw HTML/SVG are not previewed. Authenticated image downloads become scoped blob URLs; Markdown content is escaped. Upload/preview/download all retain Host/Origin/token/path boundaries and reject shared-inode artifacts.

`lab-agent inspect`/`models` evaluate trusted static config without external connections. `doctor` diagnoses config, Python and MCP availability; only `doctor --probe-model` sends one explicit, potentially billable inference request. Optional MCP failure is visible and excludes that server's tools; required startup failures still fail.

Errors are `{error:{message}}` with 400 invalid input, 403 origin/token, 404 unknown resource, 409 busy, 500 execution/config failure. Accepted stream failures become native SDK error parts and a terminal stored record. A disconnected UI can reload sessions and run state.

## UI
Next.js static export, native useChat + DefaultChatTransport and AI SDK UI streams. Three panes on desktop, collapsible session/artifact panels on mobile. Task/chat mode, tool inputs/results/errors, full session restore, explicit cancel, original/latest checks and provenance, artifacts/download/preview, explicit input import, read-only capabilities, keyboard controls, light/dark preference. Importing or inserting an input path never automatically sends a message. Use semantic HTML, system fonts, neutral backgrounds and one teal action color; avoid landing-page hero styling.

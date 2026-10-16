# Implementation contracts

This is an independent AI SDK implementation. The Pi project is not a runtime dependency.

## Ownership
`packages/core/src/types.ts` owns shared contracts. Resource modules are `models.ts`, `process.ts`, `workspace.ts`, `skills.ts`, `mcp.ts`, `tools.ts`. Lifecycle modules are `config.ts`, `storage.ts`, `session.ts`, `delivery.ts`, `agent.ts`, `http.ts`, `cli.ts`. The Next.js client is exported as static assets and served with Core's single local HTTP backend. This keeps an installed package self-contained without a second execution server.

## Public configuration
`defineAgent({root, model, instructions?, skillsDir?, tools?, python?, mcp?, validation?, limits?})`.
`model` is a native AI SDK LanguageModel. `instructions` is a file path or `{text}`. Defaults: AGENTS.md and .agents/skills. Python scripts are explicitly registered; no arbitrary shell tool. External tools use native `tool()`.

`createAgent(config)` → `{native, streamTurn, runTask, chat, close, cancel, sessions, runs, inspect}`.
`streamTurn({message, sessionId?, mode?:'chat'|'task', signal?})` → `{sessionId,runId?,stream:ReadableStream<UIMessageChunk>,completed:Promise<TurnResult>,cancel}`. Core consumes its own stream for persistence independently of the UI reader. `runTask` and `chat` consume this same path. Native access is an advanced escape hatch outside automatic persistence/delivery.

## Storage and execution
- `.lab-agent/sessions/<id>.json`: authoritative AI SDK UIMessage history, state and error. IDs are opaque tokens. UI and CLI share these records.
- `.lab-agent/operation.lock`: atomic project lock with PID and hostname; operations are sequential across sessions/CLI/HTTP. Recover only a demonstrably dead same-host process. Never replay tools after a crash.
- `runs/<id>/{run.json,output/,check.json,validation.log}`: execution (`running/completed/failed/aborted`) and delivery (`not_checked/passed/partial/failed`) stay independent.
- Checker argv runs without a shell with AGENT_ROOT, AGENT_RUN_DIR, AGENT_OUTPUT_DIR, AGENT_CHECK_FILE. Rechecking makes no model call. No checker means not_checked. Invalid/missing report, nonzero exit or timeout means failed delivery.
- Complete UIMessage parts are persisted, including tool calls and results. Conversion for model calls ignores incomplete tool calls after interruption while preserving stored evidence. Context projection is bounded without deleting history.
- Cancel propagates to the SDK and registered subprocess groups. Browser disconnect does not silently cancel an accepted task; explicit cancel endpoint owns cancellation. A server crash records interrupted work on recovery.
- Trusted local project. File tools enforce canonical paths, internal metadata protection and size limits. Registered Python/config/MCP code is trusted code, not a sandbox. Server binds loopback, rejects foreign Host/Origin and requires a per-process token on API requests (bootstrap token is delivered only to same-origin UI).

## HTTP
`GET /api/bootstrap` → `{token}` (same-origin guard).
All other APIs require `Authorization: Bearer <token>`.
- GET /api/state → `{project,busy,active,model,skills,tools,sessions,runs,issues}`; GET /api/session?id → SessionRecord.
- POST /api/sessions `{title?}` → SessionRecord.
- POST /api/chat `{sessionId,mode,messages:UIMessage[]}` → native AI SDK UI message SSE. Only the latest user message is accepted; previous history is loaded server-side. Response headers include x-lab-session-id and x-lab-run-id.
- POST /api/cancel → `{canceled}`; POST /api/check `{runId}` → RunRecord.
- GET /api/run?id → `{run,check}`; GET /api/artifact?runId&path → confined registered artifact.

Errors are `{error:{message}}` with 400 invalid input, 403 origin/token, 404 unknown resource, 409 busy, 500 execution/config failure. Accepted stream failures become native SDK error parts and a terminal stored record. A disconnected UI can reload sessions and run state.

## UI
Next.js static export, native useChat + DefaultChatTransport and AI SDK UI streams. Three panes on desktop, collapsible session/artifact panels on mobile. Task/chat mode, tool inputs/results/errors, full session restore, explicit cancel, run/check distinction, artifacts, recheck, keyboard controls, light/dark preference. Use semantic HTML, system fonts, neutral backgrounds and one teal action color; avoid landing-page hero styling.

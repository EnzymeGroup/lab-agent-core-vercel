# Conventions

## Project contract

agent.config.ts exports defineAgent with a canonical project root and native AI SDK model. Default instructions are AGENTS.md; default Skills are .agents/skills. Native `tool()` is the extension API. Python entry points are named registrations; Core exposes no arbitrary shell tool. MCP uses named stdio or HTTP servers and namespaced native tools.

modelFromEnv supports openai and anthropic. LAB_AGENT_MODEL is required. LAB_AGENT_API_KEY or the provider's OPENAI_API_KEY/ANTHROPIC_API_KEY is required. LAB_AGENT_BASE_URL or the provider-specific base URL optionally selects an endpoint. OpenAI-compatible calls explicitly use Chat Completions. Credentials are never returned by inspect or state. Project .env is parsed without mutating process.env; inherited explicit process values take precedence. Config factories receive `{root,env}` and object configs calling modelFromEnv() remain compatible through scoped evaluation. config.env carries the project environment to subprocesses and MCP.

Core's inspect/models path does not connect MCP or a provider. It reports local schemas and configured MCP entries. Doctor checks Node, registered Python and MCP availability; it only invokes a model with explicit --probe-model. Optional MCP connection failures are recorded as unavailable; required failures remain errors. Trusted config evaluation itself can execute arbitrary application code.

## Conversation and task lifecycle

streamTurn is the shared implementation for runTask, chat, HTTP streaming and CLI execution. Core consumes the stream independently from the UI reader, so a browser disconnect does not stop accepted work or prevent final persistence. Only explicit cancellation aborts that work. Each project admits one operation at a time across processes and sessions through an atomic lock.

.lab-agent/sessions/<id>.json stores authoritative UIMessage history, including tool arguments/results/errors. Session IDs are opaque tokens. A bounded context projection controls model input while the complete stored history remains available. Incomplete tool calls after interruption stay in storage as evidence and are omitted from subsequent model-message conversion.

| Run execution | Meaning |
| --- | --- |
| running | Accepted operation has not reached a terminal state |
| completed | Model/tool loop ended successfully |
| failed | Execution encountered an error |
| aborted | Explicit cancellation or controlled server shutdown |

| Delivery | Meaning |
| --- | --- |
| not_checked | No independent check has established acceptance |
| passed | Configured checker returned valid passed report and exited zero |
| partial | Valid checker report explicitly records partial acceptance |
| failed | Checker rejected the result, timed out, exited nonzero or produced an invalid/missing report |

Completion and delivery are independent. A model statement such as “done” is not a check report. runTask returns a RunRecord on success; execution failures expose the persisted terminal run through RunError. CLI JSON emits the terminal RunRecord even for a failed run. Exit codes are 0 for completed passed/not_checked, 2 for partial, and 1 for failed/aborted work.

## Delivery checker

Each run has run.json and output/; an invoked checker adds check.json and validation.log. A checker receives its command as an argv array without a shell, project cwd and AGENT_ROOT, AGENT_RUN_DIR, AGENT_OUTPUT_DIR, AGENT_RUN_ID and AGENT_CHECK_FILE environment variables. It writes:

```json
{"status":"passed","checks":[{"name":"source-derived values","status":"passed"}],"issues":[]}
```

Allowed top-level statuses are passed, partial and failed. A nonzero exit always fails delivery even if a report says passed. Missing/malformed reports and checker timeouts fail visibly. Rechecking makes no model call and appends a new checks/<observation-id> snapshot rather than replacing first evidence. originalDelivery remains fixed; latest check.json/validation.log are convenience views. Schema v2 provenance records runtime versions, configured input/code hashes and original artifact hashes. Rechecks flag input/code/artifact changes; changed source does not silently become accepted original evidence. Legacy records remain readable with provenance unknown. Validators should reconstruct required values from original source; presence alone does not establish scientific correctness.

## Paths, concurrency and trust

File tools enforce canonical containment, sensitive-path/alias protection and byte limits. Analysis is the default: writes belong only to the current task output. Development edits require explicit fileAccess.writeRoots; a broad root can authorize source/input/checker edits, which provenance then flags rather than accepting as unchanged original evidence. Keep acceptance/input directories outside edit roots. Secrets, Core metadata and prior-run history remain protected. Environment variants, credentials, .git and internal metadata are hidden from model reads/listing, including aliases. Downloads are confined to registered outputs. Python, config, native tools and MCP commands are trusted host code; this is not a hostile-code sandbox.

The HTTP server binds to loopback, checks Host/Origin and requires a per-process bearer token on API requests. The same-origin UI obtains it through /api/bootstrap. Recovery requires evidence that the owning same-host process is dead; a live or foreign-host lock is retained. Immutable ownership claims serialize stale-lock recovery, including recovery interrupted by another crash. Recovery marks unfinished runs failed with finishReason interrupted and never replays tools. A pending check becomes an interrupted evidence observation. This is metadata recovery: detached process groups may survive SIGKILL/host failure and need operator cleanup or OS isolation. Controlled cancellation reaches SDK requests and registered subprocess groups, including independent rechecks; ownership remains until tracked tool cleanup settles. Custom tools must honor their abort signal and settle their work.

The native Agent handle bypasses Core run/session/delivery management. Applications using that escape hatch own those responsibilities. Native SDK composition does not add scheduler guarantees.

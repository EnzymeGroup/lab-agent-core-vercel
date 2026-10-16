# Conventions

## Project contract

agent.config.ts exports defineAgent with a canonical project root and native AI SDK model. Default instructions are AGENTS.md; default Skills are .agents/skills. Native `tool()` is the extension API. Python entry points are named registrations; Core exposes no arbitrary shell tool. MCP uses named stdio or HTTP servers and namespaced native tools.

modelFromEnv supports openai and anthropic. LAB_AGENT_MODEL is required. LAB_AGENT_API_KEY or the provider's OPENAI_API_KEY/ANTHROPIC_API_KEY is required. LAB_AGENT_BASE_URL or the provider-specific base URL optionally selects an endpoint. OpenAI-compatible calls explicitly use Chat Completions. Credentials are never returned by inspect or state. .env is loaded from the selected project root before config evaluation.

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

Allowed top-level statuses are passed, partial and failed. A nonzero exit always fails delivery even if a report says passed. Missing/malformed reports and checker timeouts fail visibly. Rechecking preserves execution history and makes no model call. Validators should reconstruct required values from the original source; checking file presence alone does not establish scientific correctness. The bundled FASTA and CSV validators detect modified computed values.

## Paths, concurrency and trust

File tools enforce canonical workspace containment, metadata protection and byte limits. Artifact downloads are confined to the selected run's registered outputs. Symlink traversal cannot escape the workspace or overwrite protected records. Python, config and MCP commands are trusted code with the user's process privileges; this is not a hostile-code sandbox.

The HTTP server binds to loopback, checks Host/Origin and requires a per-process bearer token on API requests. The same-origin UI obtains it through /api/bootstrap. Recovery requires evidence that the owning same-host process is dead; a live or foreign-host lock is retained. Immutable ownership claims serialize stale-lock recovery, including recovery interrupted by another crash. Recovery marks unfinished runs failed with finishReason interrupted and never replays tools. Cancel reaches SDK requests and registered subprocess groups, including independent rechecks; ownership is retained until tracked tool cleanup settles. Custom tools must honor their abort signal and settle their work.

The native Agent handle bypasses Core run/session/delivery management. Applications using that escape hatch own those responsibilities. Native SDK composition does not add scheduler guarantees.

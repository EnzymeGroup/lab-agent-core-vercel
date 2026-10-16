# Review issue ledger

This ledger maps the source/DX review concerns to concrete changes. Implementation status is separate from final automated results in [Validation](VALIDATION.md). Deterministic tests do not establish live reasoning or measured human usability.

| Concern | Change and evidence location | Claim boundary |
| --- | --- | --- |
| Model-visible reads expose environment/keys/history | Canonical sensitive-path and alias filtering in workspace.ts; boundary tests | File tools only; trusted host code retains process privileges |
| Agent edits acceptance logic or source during analysis | Analysis output-only writes; explicit development edit roots; provenance flags changed code/input | Broad development roots may authorize edits; keep checker/input outside them |
| Rechecking destroys first delivery evidence | Schema v2 originalDelivery and append-only check snapshots; input/code/artifact hashes | Legacy records retain unknown provenance |
| Cancellation releases ownership before side effects settle | Tracked native-tool cleanup; lock retained until cooperative or noncooperative tool settles | Core cannot forcibly stop arbitrary native JavaScript |
| Inspect starts unavailable services | Static inspectConfig and local schema rendering; onboarding tests assert no MCP start/no inference | Config itself is trusted executable code |
| Missing optional MCP makes the application unusable | Connected/unavailable runtime status and static configured status; explicit optional field | Required MCP failures remain errors |
| Installation/diagnosis instructions are ambiguous | Installed basic/python/minimal scaffolds, current tarball workflow, doctor and exact binary/package spelling | npm publication remains unperformed |
| Project dotenv contaminates another Agent | Factory `{root, env}`, scoped model env, config.env; concurrent object/factory isolation test | Explicit inherited process variables still win |
| Python/native tool integration is underspecified | Registered argv, virtualenv/uv examples, cooperative AbortSignal tool and existing-repo guide | User owns scientific validation and host-code trust |
| Workbench hides inputs/capabilities/outputs | Immutable bounded uploads, safe previews, tool schemas and MCP/file policy display | No hosted/multiuser or arbitrary HTML execution |
| Native composition is presented as a new workflow engine | prepareStep passthrough and workflow linkage; explicit native delegation/sequence | Application owns scheduling and native escape-hatch lifecycle |

The onboarding test exercises one current npm-packed external installation, all three template names, actual task execution, static dead-MCP behavior, explicit probe behavior and dotenv credential redaction. This is automated engineering evidence, not a newcomer study.

| Deferred item | Why it remains open |
| --- | --- |
| Live OpenAI/Anthropic/Google/vLLM/Ollama quality and compatibility trials | No usable live credentials or configured local inference server supplied; recipes are documentation |
| Independent human onboarding exercise | Requires real participants following the instructions; automation cannot substitute |
| npm publication / GitHub Release | Requires user authorization and release credentials; local tarball remains the supported artifact |
| OS sandbox, untrusted plugins and multiuser hosted execution | Current trust boundary is a local cooperative project |
| SQLite migration and multiworker scheduling | JSON records and one project lock remain the explicit scale/ownership model |
| Broad performance, token-cost or scientific benchmark superiority | Matched deterministic engineering comparison measures integration only |

An opt-in `npm run test:live` harness now exists for two real-provider application cases, including Skill/Python and native sourceEvidence use. It has not been run here. Controlled cancellation tests do not establish detached-process cleanup after SIGKILL or host failure; metadata recovery never replays those side effects.

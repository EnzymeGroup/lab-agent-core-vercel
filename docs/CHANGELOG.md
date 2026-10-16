# Changes and compatibility

## 0.1.0-rc.2

This remains an unpublished release candidate. The changes address source boundary and onboarding reviews while retaining native AI SDK execution and UI messages.

- Analysis is the default file-tool mode: writes are confined to the current task output. Existing projects that intentionally edit source must opt into development mode with explicit write roots. Environment/credential/internal metadata aliases remain protected. Trusted Python/native/MCP execution is not sandboxed.
- Run schema v2 records runtime versions, configured input and relevant code hashes, and artifact hashes. Rechecks append evidence observations and preserve originalDelivery. Old records remain readable without inventing missing provenance.
- Static inspect/models no longer connect MCP. Doctor exposes actual environment/MCP failures; model inference requires --probe-model. Optional MCP failures remain visible instead of blocking unrelated runtime capabilities.
- Config factories receive `{root, env}`. Project dotenv parsing no longer mutates process.env; existing object configs remain supported. Inherited explicit process variables take precedence over .env.
- basic and python templates are installed with the package; minimal remains a python alias. Creation uses `npx --package=lab-agent-core-vercel create-lab-agent`, or the current local tarball equivalent. There is no assumed separate create-lab-agent package.
- Workbench additions include uploads, bounded safe previews and detailed capabilities. One-project-one-active-operation semantics remain unchanged.
- Native prepareStep and run linkage metadata support application-owned workflows; no scheduler or separate execution protocol is added.

Observed automated results belong in [Validation](VALIDATION.md). [Review ledger](REVIEW-LEDGER.md) separates implementation changes from unavailable provider/human/publication evidence.

## 0.1.0-rc.1

Initial independent AI SDK implementation: persistent native UIMessage sessions, task execution/check separation, registered Python, Skills, MCP, CLI, installed static workbench, two source-preserving Python applications and deterministic integration fixtures.

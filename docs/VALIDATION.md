# Validation and evidence limits

This is an unpublished release candidate. Automated verification uses a deterministic local OpenAI-compatible HTTP server, real AI SDK streaming/tool calls, registered Python subprocesses, a real stdio MCP fixture, external npm-packed consumers and browser tests. The model fixture never creates delivery artifacts; Python does the analysis and independent validators reconstruct expected values from original inputs.

## Reproduce

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:browser
```

The verification command checks TypeScript, compiled package/client builds, runtime tests, external install consumers and documentation consistency. Browser checks use the built static client served through Core. GitHub Actions runs the same commands on Node 22 and uploads browser reports.

## Final local acceptance, 2026-10-16

| Check | Observed result |
| --- | --- |
| Strict Core/client type checking and Next.js production export | Passed |
| Runtime/resource/delivery/regression/terminal tests | 43/43 passed, no skipped cases on Linux |
| Packed external consumers | 1/1 integration suite passed, covering both complete Python applications |
| Chromium browser tests | 8/8 passed; 375, 768, 1024 and 1440 pixel viewports |
| Matched new/Pi framework comparison | 4/4 scenarios passed; 12 model requests, zero requests for rechecks |
| Documentation contract/link checks | 9 files passed |
| Production dependency audit using the npm registry | Zero reported vulnerabilities after updating yaml to 2.9.1 |

The runtime suite includes ten consecutive tool tasks on one session: all ten independent deliveries passed, full tool history remained stored, and the bounded model projection omitted older complete turns. It also kills an actual worker process and verifies recovery without tool replay, schedules competing stale-lock reclamation, exercises native stdio and HTTP MCP, rejects invalid checker JSON/directories/FIFOs/oversized reports, checks partial delivery exit code 2, and waits for a SIGTERM-ignoring Python process to die before releasing task ownership. The official terminal UI is exercised through a real POSIX pseudo-terminal and the same authenticated HTTP/session path as the browser.

Browser tests run genuine Python computation and verify downloads, source-derived checks, deliberate output tampering and recheck, authoritative history, keyboard multiline composition, theme/session reload, provider errors, reconnection, and reload followed by explicit cancellation of an accepted task. Task light/dark, running-toolbar and responsive screenshots were visually inspected. No page or browser-console errors were observed in the task workflow. The provider-error test deliberately produces an upstream error on server stderr.

Local evidence is in `.artifacts/verify.log`, `.artifacts/browser.log`, `.artifacts/npm-audit.json`, `.artifacts/comparison/`, `.artifacts/verification.json` and `test-results/`. Generated logs and screenshots are excluded from the source package. The installable tarball is built with `npm run pack:core` and includes the compiled workbench, complete application examples, templates and documents. No npm publication or hosted deployment was performed.

## Observed installed-consumer result

On 2026-10-16, `node --test tests/consumers/installed.test.mjs` passed 1/1 integration test on Node 22.22.0, npm 10.9.4 and Python 3.11.4. That test packed and installed the package in a temporary directory outside the repository, confirmed the installed package was not a workspace symlink, and executed both complete Python applications through the installed CLI. FASTA analysis retained four records; CSV analysis retained five rows. Both independent checks passed, and deliberate computed-output changes were rejected by CLI recheck.

The same test restored session/tool history, continued chat, ran the copied native delegation and explicit two-Agent examples, checked pre-abort propagation, loaded the installed static UI and authenticated state API, and created a project from the installed template. Documentation validation covers nine documents. A demo startup smoke check also used an external temporary project, observed `demo: true` from the authenticated state endpoint, and stopped cleanly on SIGTERM.

## Evidence categories

| Category | Required evidence | Scope |
| --- | --- | --- |
| Runtime | Real SDK requests, tools and terminal persisted records | Integration behavior under deterministic decisions |
| Delivery | Source-derived FASTA/CSV checks plus deliberately altered output rejection | Correctness of these bounded descriptive applications |
| Installed package | npm pack → fresh install outside repository without workspace links | Package exports, templates, docs, CLI and included UI assets |
| Persistence | Task/chat continuation and tool evidence after reload | Session serialization and shared execution path |
| Cancellation/failure | Aborted requests/process groups and failed/aborted terminal states | Observed controlled fault cases |
| Browser | Desktop/mobile interaction, tool evidence, session reload, cancellation, checks and artifacts | Automated functional UI behavior |
| Live provider | Real credential-backed inference | Not verified in the credential-free environment |
| Human usability | Independent new-user exercise | Not measured |

Exact passing test counts and artifact paths should be reported with the verification run, rather than inferred from test presence. A test file existing in the repository is not a passing result. CI status is authoritative for its specific revision and environment.

## Limits

No live-provider reasoning quality, cost/latency benchmark, wet-lab claim, scientific discovery claim or measured human usability is established by these fixtures. Trusted project config/Python/MCP execution is not a sandbox. Tool-loop integration and source-data-preserving arithmetic checks are engineering evidence within their stated tasks.

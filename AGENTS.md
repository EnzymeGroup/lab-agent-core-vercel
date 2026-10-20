# Development

This project implements scientific Agent assembly directly with AI SDK. Do not add Pi runtime dependencies, a custom model loop, a second message protocol, or a workflow scheduler.

Read `docs/REFERENCE.md` before changing cross-layer behavior and `docs/ARCHITECTURE.md` for source ownership and invariants. Core owns session/run lifecycle, cancellation, resource cleanup and checking; applications own domain tools and scientific acceptance.

Use native AI SDK tools and UIMessage types. Keep full durable history separate from bounded model context. Completed execution and accepted delivery are independent. Every accepted operation must leave an honest terminal record. Do not release operation ownership before tool processes settle.

Run `npm run verify` and, for UI changes, `npm run test:browser`. Verify the packed package outside the source tree. Build with `npm run build` before packing. Tests use explicitly labeled deterministic HTTP fixtures; never report these as live reasoning or human usability validation.

Trusted local code only. Registered Python and MCP are not sandboxed. Bind the workbench to loopback and preserve origin/token/path boundaries. Do not commit credentials, generated sessions, runs, node_modules, or test artifacts. Publishing requires the user's authorization.

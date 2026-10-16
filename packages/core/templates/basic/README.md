# Basic Agent

Install the current lab-agent-core-vercel tarball in this directory. Copy .env.example to .env and set the model and credential. Run `npx lab-agent doctor` (Node/config/MCP diagnostics; no inference by default), then `npm run run -- "Read data/notes.txt and describe the project"` or `npm run dev`.

This template needs Node 22.19+ and no Python. Customize AGENTS.md, .agents/skills and the native countText tool in agent.config.ts. Analysis mode permits file-tool writes only into the current task output directory. Trusted native code has host privileges and must cooperate with cancellation. There is no independent checker; completed execution has delivery not_checked.

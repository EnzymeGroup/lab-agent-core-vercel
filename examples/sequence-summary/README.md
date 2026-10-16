# Sequence summary

Install the package in this directory (`npm install /absolute/path/lab-agent-core-vercel-0.1.0-rc.3.tgz`), copy `.env.example` to `.env`, and set a model ID and credential. Run `python3 workflows/run.py` or `lab-agent dev --root .`. The Python driver invokes the installed CLI; it does not implement another Agent runtime. The fixture demo from the repository root needs no provider credential (`npm run demo`).

The input has four FASTA records, including a duplicate identifier and an empty sequence. The registered stdlib Python tool produces summary.json and report.md under runs/<id>/output. An independent validator reconstructs all records and counts from source, checks its SHA256 digest, and rejects modified results. The scripts can also run directly with AGENT_OUTPUT_DIR set to a temporary directory. No biological activity claim is made.

Computational Python is registered for task mode only. Chat may still use other trusted native/MCP tools. Bind actual task source paths with --input or runTask inputs; frozen baselines exclude unrelated later uploads.

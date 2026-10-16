# Sequence summary

Install the package in this directory (`npm install`), copy `.env.example` to `.env`, and set a model ID and credential. Run `python3 workflows/run.py` or `lab-agent dev --root .`. The Python driver invokes the installed CLI; it does not implement another Agent runtime. The fixture demo from the repository root needs no provider credential (`npm run demo`).

The input has four FASTA records, including a duplicate identifier and an empty sequence. The registered stdlib Python tool produces summary.json and report.md under runs/<id>/output. An independent validator reconstructs all records and counts from source, checks its SHA256 digest, and rejects modified results. The scripts can also run directly with AGENT_OUTPUT_DIR set to a temporary directory. No biological activity claim is made.

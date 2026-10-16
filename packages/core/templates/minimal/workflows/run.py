#!/usr/bin/env python3
"""Python drives the same persistent Core CLI used by the web workbench."""
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
task = " ".join(sys.argv[1:]) or "Summarize the supplied FASTA. Load sequence-summary, then run summarize. [skill:sequence-summary] [script:summarize]"
command = [os.environ.get("LAB_AGENT_CLI", "lab-agent"), "run", task, "--root", str(root), "--json"]
result = subprocess.run(command, text=True, capture_output=True)
if result.stderr:
    print(result.stderr, end="", file=sys.stderr)
if result.stdout:
    record = json.loads(result.stdout)
    print(json.dumps(record, indent=2))
raise SystemExit(result.returncode)

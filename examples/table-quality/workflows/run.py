#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
task = " ".join(sys.argv[1:]) or "Profile the CSV table. Load table-quality then run analyze. [skill:table-quality] [script:analyze]"
result = subprocess.run([os.environ.get("LAB_AGENT_CLI", "lab-agent"), "run", task, "--root", str(root), "--input", "data/input.csv", "--json"], text=True, capture_output=True)
if result.stderr:
    print(result.stderr, end="", file=sys.stderr)
if result.stdout:
    print(json.dumps(json.loads(result.stdout), indent=2))
raise SystemExit(result.returncode)

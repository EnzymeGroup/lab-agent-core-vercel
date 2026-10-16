#!/usr/bin/env python3
"""A fixed stdlib argument-driven script; retain raw cells and short rows."""
import argparse
import csv
import itertools
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--max-rows", required=True, type=int)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(os.environ["AGENT_ROOT"])
with (root / args.input).open(newline="") as handle:
    reader = csv.reader(handle)
    headers = next(reader)
    rows = list(itertools.islice(reader, args.max_rows))
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"source": args.input, "headers": headers, "rows": rows, "sampled_rows": len(rows), "max_rows": args.max_rows}, indent=2) + "\n")
print(json.dumps({"sampled_rows": len(rows), "artifact": output.name}))

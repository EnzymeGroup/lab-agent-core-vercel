#!/usr/bin/env python3
"""A fixed, stdlib-only FASTA analysis; no model or shell execution."""
import hashlib
import json
import os
from collections import Counter
from pathlib import Path

root = Path(os.environ.get("AGENT_ROOT", Path(__file__).resolve().parents[1]))
source = root / "data/input.fasta"
output = Path(os.environ.get("AGENT_OUTPUT_DIR", root / "output"))
output.mkdir(parents=True, exist_ok=True)
records = []
for line in source.read_text().splitlines():
    if line.startswith(">"):
        header = line[1:]
        records.append({"id": header.split()[0] if header.split() else "", "header": header, "sequence": ""})
    elif line.strip():
        if not records:
            raise ValueError("sequence before first FASTA header")
        records[-1]["sequence"] += line.strip()
for record in records:
    record["length"] = len(record["sequence"])
    record["characters"] = dict(sorted(Counter(record["sequence"]).items()))
summary = {"source": "data/input.fasta", "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "record_count": len(records), "records": records}
(output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
standard = set("ACDEFGHIKLMNPQRSTVWY")
lines = ["# Sequence summary", "", "Identifiers and source sequence values are retained; this is descriptive analysis.", "", "| Record | Identifier | Length | Nonstandard characters |", "| --- | --- | ---: | ---: |"]
for i, record in enumerate(records, 1):
    count = sum(c.upper() not in standard for c in record["sequence"])
    lines.append(f"| {i} | {record['id']} | {record['length']} | {count} |")
(output / "report.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"artifacts": ["summary.json", "report.md"], "record_count": len(records)}))

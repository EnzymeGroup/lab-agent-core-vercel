#!/usr/bin/env python3
"""Descriptive CSV profile retaining raw cells, empty strings and absent cells."""
import csv
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ.get("AGENT_ROOT", Path(__file__).resolve().parents[1]))
source = root / "data/input.csv"
output = Path(os.environ.get("AGENT_OUTPUT_DIR", root / "output"))
output.mkdir(parents=True, exist_ok=True)
with source.open(newline="") as handle:
    table = list(csv.reader(handle))
headers, rows = table[0], table[1:]
profiles = []
for index, name in enumerate(headers):
    present = [row[index] for row in rows if index < len(row)]
    profiles.append({"name": name, "empty_cells": present.count(""), "absent_cells": sum(index >= len(row) for row in rows), "distinct_present": len(set(value for value in present if value != ""))})
profile = {"source": "data/input.csv", "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "headers": headers, "rows": rows, "row_count": len(rows), "column_count": len(headers), "columns": profiles}
(output / "profile.json").write_text(json.dumps(profile, indent=2) + "\n")
lines = ["# Table quality", "", f"Rows: {len(rows)}. Columns: {len(headers)}. Raw values are retained; NA is a literal string.", "", "| Column | Empty | Absent | Distinct present |", "| --- | ---: | ---: | ---: |"]
for column in profiles:
    lines.append(f"| {column['name']} | {column['empty_cells']} | {column['absent_cells']} | {column['distinct_present']} |")
(output / "report.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"artifacts": ["profile.json", "report.md"], "row_count": len(rows)}))

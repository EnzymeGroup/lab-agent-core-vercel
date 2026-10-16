#!/usr/bin/env python3
"""Re-read the original CSV independently; never import the analysis script."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path

root = Path(os.environ.get("AGENT_ROOT", Path(__file__).resolve().parents[1]))
output = Path(os.environ.get("AGENT_OUTPUT_DIR", root / "output"))
checks, issues = [], []
def check(name, value):
    checks.append({"name": name, "status": "passed" if value else "failed"})
    if not value:
        issues.append(name)
try:
    raw = (root / "data/input.csv").read_bytes()
    records = iter(csv.reader(io.StringIO(raw.decode(), newline="")))
    header, rows = next(records), list(records)
    columns = []
    for i, name in enumerate(header):
        empty, absent, values = 0, 0, set()
        for row in rows:
            if len(row) <= i:
                absent += 1
            elif row[i] == "":
                empty += 1
            else:
                values.add(row[i])
        columns.append({"name": name, "empty_cells": empty, "absent_cells": absent, "distinct_present": len(values)})
    actual = json.loads((output / "profile.json").read_text())
    check("output schema", set(actual) == {"source", "source_sha256", "headers", "rows", "row_count", "column_count", "columns"})
    check("source digest", actual.get("source_sha256") == hashlib.sha256(raw).hexdigest())
    check("source path", actual.get("source") == "data/input.csv")
    check("unaltered ordered headers and raw cells", actual.get("headers") == header and actual.get("rows") == rows)
    check("table dimensions", actual.get("row_count") == len(rows) and actual.get("column_count") == len(header))
    check("source-derived missingness and distinct counts", actual.get("columns") == columns)
    report = (output / "report.md").read_text()
    expected_report = ["# Table quality", "", f"Rows: {len(rows)}. Columns: {len(header)}. Raw values are retained; NA is a literal string.", "", "| Column | Empty | Absent | Distinct present |", "| --- | ---: | ---: | ---: |"]
    for item in columns:
        expected_report.append(f"| {item['name']} | {item['empty_cells']} | {item['absent_cells']} | {item['distinct_present']} |")
    check("source-derived complete human report", report == "\n".join(expected_report) + "\n")
except Exception as error:
    check("readable complete artifacts", False)
    issues.append(str(error))
report = {"status": "failed" if issues else "passed", "checks": checks, "issues": issues}
target = Path(os.environ.get("AGENT_CHECK_FILE", output / "check.json"))
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
raise SystemExit(1 if issues else 0)

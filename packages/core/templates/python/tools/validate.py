#!/usr/bin/env python3
"""Independently reconstruct expected values from the original FASTA."""
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ.get("AGENT_ROOT", Path(__file__).resolve().parents[1]))
output = Path(os.environ.get("AGENT_OUTPUT_DIR", root / "output"))
checks = []
issues = []
def check(name, condition):
    checks.append({"name": name, "status": "passed" if condition else "failed"})
    if not condition:
        issues.append(name)
try:
    raw = (root / "data/input.fasta").read_bytes()
    expected = []
    for block in raw.decode().split(">"):
        if not block.strip():
            continue
        lines = block.splitlines()
        header = lines[0]
        sequence = "".join(part.strip() for part in lines[1:] if part.strip())
        counts = {character: sequence.count(character) for character in sorted(set(sequence))}
        expected.append({"id": header.split()[0] if header.split() else "", "header": header, "sequence": sequence, "length": len(sequence), "characters": counts})
    actual = json.loads((output / "summary.json").read_text())
    check("output schema", set(actual) == {"source", "source_sha256", "record_count", "records"})
    check("source digest", actual.get("source_sha256") == hashlib.sha256(raw).hexdigest())
    check("source path", actual.get("source") == "data/input.fasta")
    check("all source records and computed fields", actual.get("records") == expected)
    check("record count", actual.get("record_count") == len(expected))
    report = (output / "report.md").read_text()
    expected_report = ["# Sequence summary", "", "Identifiers and source sequence values are retained; this is descriptive analysis.", "", "| Record | Identifier | Length | Nonstandard characters |", "| --- | --- | ---: | ---: |"]
    for i, item in enumerate(expected, 1):
        ambiguous = len([character for character in item["sequence"] if character.upper() not in "ACDEFGHIKLMNPQRSTVWY"])
        expected_report.append(f"| {i} | {item['id']} | {len(item['sequence'])} | {ambiguous} |")
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

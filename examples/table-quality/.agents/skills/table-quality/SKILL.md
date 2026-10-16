---
name: table-quality
description: Profile a CSV without modifying identifiers, raw strings or missingness semantics.
---

Call runPython with script="analyze" and args=[]. The source is data/input.csv. Read references/output.md for field semantics when needed. The tool writes profile.json and report.md into the current run output. A blank string is an empty observed cell; a short row has an absent cell; NA is a literal string. Never pad or impute rows.

---
name: sequence-summary
description: Summarize the supplied FASTA while retaining headers, duplicate identifiers and empty sequences.
---

Read data/input.fasta using the registered summarize Python tool. Its fixed output contract is described in references/output.md. Do not edit source data. Call runPython with script="summarize" and args=[]. Report the generated artifact paths and any empty/ambiguous sequences. Only an independent delivery check can establish passed delivery.

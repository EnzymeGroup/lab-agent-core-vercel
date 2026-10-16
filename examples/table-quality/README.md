# Table quality

Install the package (`npm install`), copy `.env.example` to `.env`, and configure a model ID and credential. Run `python3 workflows/run.py` or `lab-agent dev --root .`. Both use Core's persistent execution path.

Five CSV rows include duplicate identifiers, empty cells, a literal NA, a quoted comma and a short row. Analysis retains raw row arrays and distinguishes empty from absent cells. The independent source-based checker detects altered values, counts and missingness. Artifacts are profile.json and report.md under runs/<id>/output. All Python code uses the standard library.

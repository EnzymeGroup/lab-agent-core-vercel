# rc.3 live-provider and external application trials

On 2026-10-16 the user supplied a project .env selecting the native OpenAI-compatible model `deepseek-v4-flash`. A real request completed, followed by the three application trials below. These are credential-backed executions, separate from the deterministic CI fixture. Credentials and endpoint details are excluded from records shared with the repository.

| Trial | Actual source | Independent delivery | Tokens reported by provider |
| --- | --- | --- | ---: |
| FASTA example | 4 original sequence records | passed | 8,204 |
| CSV example plus native sourceEvidence tool | 5 original rows | passed | 10,153 |
| External npm-installed reference audit | Existing ProteinGym reference table, 217 rows and 47 columns | passed | 13,163 |

The first two trials used the complete example applications, real native Skill/file/Python calls and their source-derived validators. Their report is `.artifacts/live/2026-10-16T14-29-01-824Z/results.json`. They demonstrate these bounded pipelines on one configured endpoint; they do not establish provider-wide compatibility or parity with another agent's reasoning.

The third trial installed the actual rc.3 tarball under `/tmp`, verified the installed Core was not a workspace symlink, and copied an existing `DMS_substitutions.csv` byte-for-byte from a separate local project. The input was 218,035 bytes with SHA256 `fb0b3b4e8a6e0a7261001d468ea9c1771c6f36f4d1b90048e7f6c8fae9b587ae`. The original project file remained unchanged. The model called native sourceEvidence, loaded the domain Skill and invoked registered Python; the independent validator reconstructed the expected ordered raw cells, missingness and report from the source.

The external trial made four model requests. Uploading unrelated sample B left the original run's frozen manifest and passed verdict intact. Deliberately replacing profile.json with {} failed recheck; restoring the original bytes passed. All three rechecks made zero additional model requests and preserved originalDelivery. This is a reference-data preservation/metadata audit, not protein-effect prediction or a new scientific finding. Evidence is `.artifacts/installed-live/2026-10-16T14-30-59-089Z/results.json`; the usable independent project is retained locally and a source/history snapshot is archived beside the report.

## Observed failure and correction

The first live FASTA trial failed its 12-step budget after successfully running Python. Raw Skill references and stdout artifact basenames lacked clear project-relative locations, so the model spent steps locating files. That run remains recorded as failed/not_checked in `.artifacts/live/2026-10-16T14-23-04-367Z/`; its successful computation was not relabeled as an accepted delivery. Core now returns explicit Skill source/directory/reference guidance and runPython cwd/outputDirectory metadata, while task instructions give exact project-relative output paths. The successful trials above are fresh executions after this change. There is no claim of a measured general efficiency gain from one before/after case.

## Reproduce explicitly

```sh
npm run build
npm run test:live
npm run pack:core
node scripts/validate-installed-live.mjs --source /absolute/existing/reference.csv --package .artifacts/lab-agent-core-vercel-0.1.0-rc.3.tgz --env-file .env
```

The live script reads the repository .env only when explicitly invoked; environment variables can override it. The installed trial keeps model configuration outside the copied project and never copies the credential file. These requests can consume provider tokens. Independent human onboarding remains unmeasured, and formal npm registry publication remains blocked by absent registry authentication. The separately measured [large-file benchmark](BENCHMARK.md) uses generated random bytes and zero model calls.

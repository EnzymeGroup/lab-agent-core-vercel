# Extras

`packages/extras` (`lab-agent-extras`) holds opt-in tool sets. Core never imports it: a project gets these tools only by adding them in `agent.config.ts`, and removing that line removes them. Each module is a subpath export, tested under `tests/extras/` (`npm run test:extras`). Tests use local HTTP fixtures; no real provider, website or cluster is contacted.

```ts
import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { webTools } from 'lab-agent-extras/web';

export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  tools: { ...webTools() },
}));
```

Extras tools are ordinary native AI SDK tools, so `approval`, tool switches, helpers and provenance apply to them like to any other tool.

## Web: `lab-agent-extras/web`

`webTools(options?)` returns:

| Tool | Input | Output |
| --- | --- | --- |
| `webSearch` | `{ query ≤400, maxResults 1–10 = 5 }` | `{ provider, query, results[{ title, url, snippet, publishedDate? }] }` |
| `webFetch` | `{ url, offset = 0 }` | `{ url, status, contentType, title?, text, offset, totalChars, nextOffset?, note? }` |

Options: `search` (a `SearchProvider`, default `tavily()`; `false` registers `webFetch` only), `maxFetchBytes` (default 2 MiB after decompression), `maxChars` per call (default 20000), `timeoutMs` (default 20000), `allowPrivate` (default `false`).

Search. `tavily({ apiKey?, env?, depth?, baseUrl?, timeoutMs? })` reads `TAVILY_API_KEY` when a search runs. The query is sent to Tavily: it leaves this machine. Another provider is any object `{ name, search(query, { maxResults, signal }) }`, passed as `webTools({ search })`.

Fetch. Only `http`/`https`, no embedded credentials, at most 5 redirects. Every hop is checked when it connects, against the DNS answer actually used, so a hostname cannot reach loopback, private, link-local (cloud metadata), shared, documentation, multicast or reserved addresses. `allowPrivate: true` lifts that for intranets and local fixtures. HTML becomes plain text (scripts, styles and comments dropped; headings, list items and link targets kept); JSON, XML and text are returned as is; other content types are refused. Long pages are read in slices with `offset`.

Page text is untrusted. The tool descriptions tell the model to treat it as data and cite URLs, but a page can still try to steer the model. For tools with side effects, keep them in `approval`.

Not verified: the Tavily request and response shape is implemented from its public API and tested against a local fixture only. No real search or website was contacted.

## HPC jobs: `lab-agent-extras/hpc`

Long jobs that outlive a turn. `submitJob` returns at once with a `jobId`; the model checks it in a later step or turn. There is no scheduler inside the agent and nothing polls in the background: the job record on disk is the only state. Like `runPython`, the model starts only job scripts registered in the config and passes arguments as argv. It never sends a shell command.

```ts
import { hpcTools, slurm } from 'lab-agent-extras/hpc';

tools: {
  ...hpcTools({
    root,
    env,
    adapter: slurm({ sbatch: ['--account=mylab', '--partition=cpu'] }),
    jobs: {
      align: { script: 'jobs/align.sh', description: 'Align reads: args are <sample> <reference>.', sbatch: ['--time=04:00:00', '--mem=32G', '--cpus-per-task=8'] },
    },
  }),
},
approval: ['submitJob', 'cancelJob'],
```

| Tool | Input | Output |
| --- | --- | --- |
| `submitJob` | `{ job, args ≤64 }` | The job record plus `outputDirectory` |
| `jobStatus` | `{ jobId?, waitSeconds 0–60 = 0 }` | One record (completed jobs list `outputs`), or the 20 most recent when `jobId` is omitted |
| `jobLogs` | `{ jobId, stream: stdout\|stderr, lines ≤500 = 100 }` | `{ text, truncated }` from the last 256 KiB |
| `cancelJob` | `{ jobId }` | The record after cancelling |

A record is `{ id, job, args, scheduler, schedulerId, status: queued|running|completed|failed|cancelled|unknown, exitCode?, detail?, submittedAt, updatedAt, finishedAt?, directory, script: { path, sha256 }, runId? }`. `runId` is set when a task submitted the job. `detail` keeps the scheduler's own state, such as `TIMEOUT` or `OUT_OF_MEMORY`, which count as `failed`.

Each job gets `<root>/jobs/<jobId>/` (`directory` option): `job.json`, `stdout.log`, `stderr.log` and `output/`. The script runs from the project root with `AGENT_ROOT`, `JOB_ID`, `JOB_DIR` and `JOB_OUTPUT_DIR` set, and should write its results to `JOB_OUTPUT_DIR`. The model can read that directory with `readFile`, and a later task can freeze it with `inputs: ['jobs/<jobId>/output']`. Add `jobs/` to the project's `.gitignore`.

Adapters:

- `slurm({ commands?, sbatch?, timeoutMs? })` calls `sbatch --parsable`, `squeue`, `sacct` and `scancel` without a shell. Options come from the adapter (every job) and the job definition, never from the model. `sbatch` exports the submitting environment, so `JOB_*` reach the job.
- `localJobs()` runs the script as a detached background process on this machine, for workstations and tests. It survives the agent process. Process IDs can be reused after a reboot, so a stale `running` record from before a reboot can be wrong.
- Any object `{ name, submit, status, cancel }` works as another scheduler (PBS, LSF, a remote API).

`maxActive` (default 4) limits unfinished jobs. Job scripts are trusted project code and are not sandboxed; a Slurm job runs with your cluster account. Keep `submitJob` in `approval` so a person sees each submission and its arguments; tools in `approval` are never given to helpers.

Not verified: the Slurm adapter is tested with stand-in `sbatch`/`squeue`/`sacct`/`scancel` scripts that return recorded output; this machine has no Slurm. Check it once on your login node, for example with a job that only runs `hostname`.

## Bioinformatics databases: `lab-agent-extras/bio`

Read-only lookups. `bioTools(options?)` returns:

| Tool | Input | Output |
| --- | --- | --- |
| `ncbiSearch` | `{ db, term ≤500, maxResults 1–50 = 10 }` | `{ count, ids, results[] }`: each result keeps the summary's plain fields (≤400 characters each), `organism` and the first five `authors` |
| `ncbiFetch` | `{ db, ids 1–20, format: fasta\|genbank\|abstract\|medline\|xml = fasta }` | `{ text, totalChars, truncated? }` |
| `uniprotSearch` | `{ query ≤500, maxResults 1–25 = 10 }` | `results[{ accession, entryName, reviewed, protein, genes, organism, length }]` |
| `uniprotEntry` | `{ accession, format: fasta\|text\|json = fasta }` | `{ text, … }` |
| `ensemblLookup` | `{ symbol \| id, species = homo_sapiens }` | id, name, description, biotype, assembly, location, strand, canonical transcript |
| `ensemblSequence` | `{ id, type: genomic\|cdna\|cds\|protein = genomic }` | FASTA `{ text, … }` |

`db` is one of gene, protein, nuccore, pubmed, pmc, snp, taxonomy, sra, biosample, bioproject, assembly, clinvar, gds, structure. Every result carries `source` (the request URL with the API key removed) and `retrievedAt`, since database records change. Text is cut at `maxChars` (default 20000); fetch fewer records, or download full data with a registered script.

Options: `ncbi: { apiKey?, email?, baseUrl? } | false` (key defaults to `NCBI_API_KEY`), `uniprot: { baseUrl? } | false`, `ensembl: { baseUrl? } | false`, `env`, `timeoutMs` (30000), `maxChars`. Requests to each service are spaced to its published rate (NCBI 3/s without a key and 10/s with one, Ensembl 15/s), and a 429 is retried twice. Identifiers are checked against `[A-Za-z0-9_.-]` before they enter a URL. Queries and identifiers are sent to NCBI and EBI.

Not verified: request and response shapes follow each service's public documentation and are tested against a local stand-in only.

## Large and binary files: `lab-agent-extras/files`

`inspectTools({ root, fileAccess? })` returns `inspectFile { path, lines 1–200 = 20 }`, a first look at a file of any size without loading it. It reads at most the first MiB (and decompresses at most 1 MiB of gzip or BGZF) through Core's file policy: secrets, `.lab-agent/`, hard links and paths outside `readRoots` are refused, as with `readFile`. Pass the same `fileAccess` as the config.

The result is `{ path, bytes, compression, format, sampledBytes, complete, preview, stats?, note }`:

| Format | `stats` |
| --- | --- |
| `fastq` | `readsSampled`, `length { min, max, mean }`, `gcPercent`, `qualityEncoding` |
| `fasta` | `recordsSampled`, `firstIds`, `length`, `gcPercent` |
| `vcf` | `headerLines`, `samples`, `firstSamples`, `recordsSampled`, `chromosomes` |
| `bam` | `header { headerLines, references, firstReferences[{ name, length }] }`; the preview is the SAM header text. Alignment records are not decoded |
| `sam`, `gff`, `bed`, `csv`, `tsv` | record or row and column counts |
| `json`, `text` | none |
| `cram`, `hdf5`, `parquet`, `png`, `pdf`, `sqlite`, `binary` | none; `magic` holds the first 16 bytes as hex |

bzip2, xz, zstd and zip are named (`format: compressed`) but not decompressed. Statistics cover only the sample unless `complete` is true; a record cut off at the sample's edge is not counted. Exact counts belong in a registered script, for example one that calls `samtools flagstat` or `seqkit stats`.

## Environment capture: `lab-agent-extras/env`

`envTools({ root, env?, conda?, python?, timeoutMs? })` returns `captureEnvironment { condaEnv? }`. It runs `conda env export` (the active environment from `CONDA_PREFIX`, or `-n condaEnv`) and `python -m pip freeze --all`, without a shell. `conda` defaults to `CONDA_EXE`, then `conda` on `PATH`; `python` defaults to `python3`. Pass the same interpreter as `config.python.command`.

In a task, `conda-environment.yml` and `pip-freeze.txt` are written to `<outputDirectory>/environment/` through Core's write policy, so they are listed in `run.artifacts` with hashes in `provenance.artifacts`. A project checker that rejects unexpected output files has to allow `environment/`. In chat the text is returned and nothing is saved. Whatever cannot be captured is explained in `notes`; the call fails only when nothing was captured. Core already records Node, platform, the Python version and `CONDA_DEFAULT_ENV` in every run's `provenance.environment`; this tool adds the full package lists.

Checked once against this machine's real conda and Python, outside the test suite; the tests use stand-in executables.

## Deep research: `lab-agent-extras/research`

Parallel helpers, quotes checked against each page, and a checker for the citations. It builds on Core's `runSubagent`: the SDK runs all tool calls of one step concurrently, so a model that starts several `researcher` helpers in the same step gets them in parallel. Nothing else schedules work.

```ts
import { webTools, tavily } from 'lab-agent-extras/web';
import { researchTools, researchSubagents, CITATIONS_CHECKER } from 'lab-agent-extras/research';

tools: { ...webTools({ search: tavily({ env }) }), ...researchTools({ root }) },
subagents: researchSubagents(),
validation: { command: ['node', CITATIONS_CHECKER], repairAttempts: 1 },
limits: { maxSteps: 40, timeoutMs: 1_800_000 },
```

Copy `skills/deep-research/` from this package (`RESEARCH_SKILL_DIR`) into the project's `.agents/skills/`. A complete project is in [packages/extras/examples/research](../packages/extras/examples/research/README.md).

| Tool | Input | Output |
| --- | --- | --- |
| `citeSource` | `{ url, quote 12–600, title? }` | `{ id, cite, url, title?, quotes, file }` |
| `listSources` | `{}` | `{ file, sources[] }` |

`citeSource` fetches the page (same rules as `webFetch`, including the private-address check), confirms the quote appears in it word for word (case, spacing, curly quotes and dashes are ignored), and records it in `<outputDirectory>/sources.json` as `{ id, url, title?, retrievedAt, sha256, quotes[] }`. A page keeps one id (`S1`, `S2`, …) however often it is cited; fragments are ignored. A paraphrase is rejected with a message telling the model to copy the sentence. Parallel helpers write through one queue per file, so no record is lost. It works in task mode only, where there is an output directory.

`researchSubagents({ tools?, model?, maxSteps? })` returns two helper presets for `subagents`. `researcher` (default tools `webSearch`, `webFetch`, `citeSource`; add database tools such as `ncbiSearch`) answers one sub-question and returns findings ending in `[S#]`. `verifier` (the same tools without search) reads the cited pages and reports unsupported claims. Helpers never get tools listed in `approval`, so keep these out of it.

The Skill tells the main agent to scope the question, split it into 3–5 sub-questions with `updatePlan`, start one researcher per sub-question in the same step, merge, research gaps once more if needed, write `report.md` with a citation on every factual sentence and a `## Sources` list from `listSources`, then run the verifier and fix what it finds.

`CITATIONS_CHECKER` is a Core checker. It fails when `report.md` or `sources.json` is missing or a cited id was never recorded or has no quote. It returns partial when fewer than `RESEARCH_MIN_SOURCES` (default 3) distinct sources are cited, or when a prose paragraph of 200+ characters cites nothing. `RESEARCH_REPORT` and `RESEARCH_SOURCES` rename the files. The checker lives in `node_modules`, outside the project, so it is not part of the run's code fingerprint; copy it into the project if it should be.

What this proves: each cited page contained the quoted sentence when it was read. It does not prove the report states the source correctly, that the source is right, or that important sources were not missed. The verifier helper and a person reading the report cover part of that.

Not verified: tested with local pages and the deterministic model fixture, which follows a scripted plan. How well a real model splits questions, judges sources and writes is untested.

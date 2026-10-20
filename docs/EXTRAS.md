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

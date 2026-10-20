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

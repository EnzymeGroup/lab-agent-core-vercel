# Research agent (extras example)

Deep research with `lab-agent-extras`: web search and fetch, NCBI and UniProt lookups, parallel `researcher` helpers, quotes checked against each page (`citeSource`), and a checker that rejects reports citing unknown or unquoted sources.

```bash
cp .env.example .env    # model settings and TAVILY_API_KEY
npx lab-agent dev
```

Ask a question with one of the starters, in Task mode. The run delivers `report.md` and `sources.json`. The checker passes when every `[S#]` in the report was recorded with a verified quote and at least three sources are cited (`RESEARCH_MIN_SOURCES`).

`.agents/skills/deep-research/SKILL.md` is a copy of `lab-agent-extras/skills/deep-research`; edit it here to change how this project researches.

Search queries go to Tavily and database queries to NCBI and EBI. A verified quote shows that a page said something when it was read, not that it is correct.

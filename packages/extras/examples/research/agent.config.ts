import { defineAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { webTools, tavily } from 'lab-agent-extras/web';
import { researchTools, researchSubagents, CITATIONS_CHECKER } from 'lab-agent-extras/research';
import { bioTools } from 'lab-agent-extras/bio';

// Deep research: parallel researcher helpers, verified [S#] citations and a citation checker.
// Needs TAVILY_API_KEY (search queries are sent to Tavily) and a tool-capable model.
export default defineAgent(({ root, env }) => ({
  root,
  model: modelFromEnv(env),
  env,
  tools: {
    ...webTools({ search: tavily({ env }) }),
    ...researchTools({ root }),
    ...bioTools({ env, ensembl: false }),
  },
  subagents: researchSubagents({ tools: ['webSearch', 'webFetch', 'citeSource', 'ncbiSearch', 'uniprotSearch'] }),
  validation: { command: ['node', CITATIONS_CHECKER], repairAttempts: 1 },
  // The main agent plans, starts helpers, merges, writes and verifies; helpers have their own step budget.
  limits: { maxSteps: 40, timeoutMs: 1_800_000 },
  ui: {
    title: 'Research Agent',
    tagline: 'Answers with sources: parallel helpers, quotes checked against each page, citations checked after delivery.',
    starters: [
      { title: 'State of the art', prompt: 'Use the deep-research skill: what are the current methods for single-cell RNA-seq batch correction, and how do they compare?' },
      { title: 'Gene background', prompt: 'Use the deep-research skill: summarize what is known about the function of TP53 in DNA damage response, with sources.' },
    ],
  },
}));

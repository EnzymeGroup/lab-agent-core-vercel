/**
 * lab-agent-extras: opt-in tool sets for lab-agent-core-vercel. Core never imports this package.
 * Each module is also a subpath export (lab-agent-extras/web, …) so a project loads only what it uses.
 */
export { webTools, tavily, htmlToText, type SearchProvider, type SearchResult, type TavilyOptions, type WebToolOptions } from './web.js';
export { hpcTools, slurm, localJobs, type HpcToolOptions, type JobAdapter, type JobDefinition, type JobRecord, type JobStatus, type SlurmOptions, type SubmitSpec } from './hpc.js';
export { bioTools, type BioToolOptions } from './bio.js';
export { inspectTools, inspect, type InspectToolOptions } from './files.js';
export { envTools, type EnvToolOptions } from './env.js';
export { guardedGet, isPrivateAddress, type GuardedRequestOptions, type GuardedResponse } from './net.js';

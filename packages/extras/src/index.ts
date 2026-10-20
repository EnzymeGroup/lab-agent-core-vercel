/**
 * lab-agent-extras: opt-in tool sets for lab-agent-core-vercel. Core never imports this package.
 * Each module is also a subpath export (lab-agent-extras/web, …) so a project loads only what it uses.
 */
export { webTools, tavily, htmlToText, type SearchProvider, type SearchResult, type TavilyOptions, type WebToolOptions } from './web.js';
export { guardedGet, isPrivateAddress, type GuardedRequestOptions, type GuardedResponse } from './net.js';

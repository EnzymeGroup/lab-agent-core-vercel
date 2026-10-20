import { AsyncLocalStorage } from 'node:async_hooks';
import { createProviderRegistry, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { InputError } from '../errors.js';
import type { AgentConfig, Usage } from '../types.js';

/**
 * modelFromEnv reads LAB_AGENT_PROVIDER / LAB_AGENT_MODEL / LAB_AGENT_API_KEY / LAB_AGENT_BASE_URL.
 * Any native AI SDK LanguageModel also works; this helper only covers the common case.
 */

type Provider = 'openai' | 'anthropic';

const PROVIDERS: Record<Provider, { keyVariable: string; urlVariable: string; defaultUrl: string }> = {
  openai: { keyVariable: 'OPENAI_API_KEY', urlVariable: 'OPENAI_BASE_URL', defaultUrl: 'https://api.openai.com/v1' },
  anthropic: { keyVariable: 'ANTHROPIC_API_KEY', urlVariable: 'ANTHROPIC_BASE_URL', defaultUrl: 'https://api.anthropic.com/v1' },
};

const projectEnvironment = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/** Scope config evaluation without changing process-global credentials. */
export function withModelEnvironment<T>(env: NodeJS.ProcessEnv, callback: () => T): T {
  return projectEnvironment.run(env, callback);
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Model base URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Model base URL must be HTTP(S) without credentials, query parameters or a fragment.');
  }
  return value;
}

/** Configuration errors surface here, before any turn can create work. */
export function modelFromEnv(env: NodeJS.ProcessEnv = projectEnvironment.getStore() ?? process.env): LanguageModel {
  const provider = (env.LAB_AGENT_PROVIDER ?? 'openai').trim().toLowerCase();
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`Unsupported LAB_AGENT_PROVIDER: ${provider}. Use openai or anthropic.`);
  }
  const settings = PROVIDERS[provider];
  const id = env.LAB_AGENT_MODEL?.trim();
  if (!id || /[\s\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error('LAB_AGENT_MODEL must specify a model identifier without whitespace.');
  }
  const apiKey = env.LAB_AGENT_API_KEY ?? env[settings.keyVariable];
  if (!apiKey?.trim() || /[\r\n\u0000]/u.test(apiKey)) {
    throw new Error(`Missing or invalid API key for ${provider}. Set LAB_AGENT_API_KEY or ${settings.keyVariable}.`);
  }
  const baseURL = parseBaseUrl(env.LAB_AGENT_BASE_URL ?? env[settings.urlVariable] ?? settings.defaultUrl);

  // OpenAI-compatible endpoints commonly implement Chat Completions. Selecting
  // chat explicitly also avoids the SDK's default Responses endpoint.
  const openai = createOpenAI({ apiKey, baseURL });
  const registry = createProviderRegistry({
    openai: { ...openai, languageModel: openai.chat },
    anthropic: createAnthropic({ apiKey, baseURL }),
  });
  return registry.languageModel(`${provider}:${id}`);
}

/** Provider and model ID only; never endpoint headers or credentials. */
export function modelInfo(model: LanguageModel): { provider: string; id: string } {
  if (typeof model === 'string') {
    const separator = model.indexOf(':');
    return separator < 0 ? { provider: 'gateway', id: model } : { provider: model.slice(0, separator), id: model.slice(separator + 1) };
  }
  return { provider: model.provider, id: model.modelId };
}

export const DEFAULT_MODEL = 'default';
export const MODEL_KEY = /^[A-Za-z0-9_-]{1,40}$/u;

/** Every model a session may use: "default" (config.model) first, then config.models. */
export function modelChoices(config: AgentConfig): Array<{ key: string; provider: string; id: string; default: boolean }> {
  return [
    { key: DEFAULT_MODEL, ...modelInfo(config.model), default: true },
    ...Object.entries(config.models ?? {}).map(([key, model]) => ({ key, ...modelInfo(model), default: false })),
  ];
}

/** Resolve a model key. Undefined or "default" selects config.model. */
export function selectModel(config: AgentConfig, key?: string): { key: string; model: LanguageModel } {
  if (key === undefined || key === DEFAULT_MODEL) return { key: DEFAULT_MODEL, model: config.model };
  if (!Object.hasOwn(config.models ?? {}, key)) throw new InputError(`Unknown model "${key}". Choose one of: ${modelChoices(config).map(choice => choice.key).join(', ')}.`);
  return { key, model: config.models![key] };
}

type SdkUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } };

/** Core's usage shape from an AI SDK usage object. */
export function usageOf(usage: SdkUsage | undefined): Usage {
  const result: Usage = { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, totalTokens: usage?.totalTokens };
  if (usage?.inputTokenDetails?.cacheReadTokens !== undefined) result.cachedInputTokens = usage.inputTokenDetails.cacheReadTokens;
  return result;
}

/** Field-wise sum; a field stays undefined only when both sides lack it. */
export function addUsage(total: Usage | undefined, next: Usage): Usage {
  const sum = (a?: number, b?: number) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const result: Usage = {
    inputTokens: sum(total?.inputTokens, next.inputTokens),
    outputTokens: sum(total?.outputTokens, next.outputTokens),
    totalTokens: sum(total?.totalTokens, next.totalTokens),
  };
  const cached = sum(total?.cachedInputTokens, next.cachedInputTokens);
  if (cached !== undefined) result.cachedInputTokens = cached;
  return result;
}

/** USD for one model's usage, or undefined when that model has no configured price. */
export function costOf(config: AgentConfig, modelKey: string, usage: Usage): number | undefined {
  const price = config.pricing?.[modelKey];
  if (!price) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(0, (usage.inputTokens ?? 0) - cached);
  return (fresh * price.input + cached * (price.cachedInput ?? price.input) + (usage.outputTokens ?? 0) * price.output) / 1_000_000;
}

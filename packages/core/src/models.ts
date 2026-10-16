import { createProviderRegistry, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { AsyncLocalStorage } from 'node:async_hooks';

const projectEnvironment = new AsyncLocalStorage<NodeJS.ProcessEnv>();
/** Scope config evaluation without changing process-global credentials. */
export function withModelEnvironment<T>(env: NodeJS.ProcessEnv, callback: () => T): T {
  return projectEnvironment.run(env, callback);
}

/** Explicit configuration errors are raised before a turn can create any work. */
export function modelFromEnv(env: NodeJS.ProcessEnv = projectEnvironment.getStore() ?? process.env): LanguageModel {
  const provider = (env.LAB_AGENT_PROVIDER ?? 'openai').trim().toLowerCase();
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`Unsupported LAB_AGENT_PROVIDER: ${provider}. Use openai or anthropic.`);
  }
  const id = env.LAB_AGENT_MODEL?.trim();
  if (!id || /[\s\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error('LAB_AGENT_MODEL must specify a model identifier without whitespace.');
  }
  const apiKey = env.LAB_AGENT_API_KEY ?? env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];
  if (!apiKey?.trim() || /[\r\n\u0000]/u.test(apiKey)) {
    throw new Error(`Missing or invalid API key for ${provider}. Set LAB_AGENT_API_KEY or ${provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}.`);
  }
  const baseURL = env.LAB_AGENT_BASE_URL ?? env[provider === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL']
    ?? (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error('Model base URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Model base URL must be HTTP(S) without credentials, query parameters or a fragment.');
  }

  // OpenAI-compatible endpoints commonly implement Chat Completions. Selecting
  // chat explicitly also avoids the SDK's default Responses endpoint.
  const openai = createOpenAI({ apiKey, baseURL });
  const registry = createProviderRegistry({
    openai: { ...openai, languageModel: openai.chat },
    anthropic: createAnthropic({ apiKey, baseURL }),
  });
  return registry.languageModel(`${provider}:${id}`);
}

/** Never exposes endpoint headers, credentials or the provider configuration. */
export function modelInfo(model: LanguageModel): { provider: string; id: string } {
  if (typeof model === 'string') {
    const separator = model.indexOf(':');
    return separator < 0 ? { provider: 'gateway', id: model } : { provider: model.slice(0, separator), id: model.slice(separator + 1) };
  }
  return { provider: model.provider, id: model.modelId };
}

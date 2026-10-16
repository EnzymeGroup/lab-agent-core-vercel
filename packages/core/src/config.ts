import { relative, resolve } from 'node:path';
import { realpath, lstat, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createJiti } from 'jiti';
import type { AgentConfig } from './types.js';
import { withModelEnvironment } from './models.js';
import { within } from './storage.js';

export interface AgentConfigContext { root: string; env: NodeJS.ProcessEnv }
export type AgentConfigFactory = (context: AgentConfigContext) => AgentConfig | Promise<AgentConfig>;

export function defineAgent<const T extends AgentConfig | AgentConfigFactory>(config: T): T {
  if (typeof config === 'function') return config;
  if (!config.root || !config.model) throw new Error('Agent config requires root and a native AI SDK model.');
  const limits = config.limits;
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`limits.${key} must be a positive integer.`);
  }
  if (limits?.maxSteps && limits.maxSteps > 100) throw new Error('maxSteps must be at most 100.');
  if (config.validation && (!Array.isArray(config.validation.command) || !config.validation.command.length ||
    config.validation.command.some(item => typeof item !== 'string' || !item || item.includes('\0')))) {
    throw new Error('validation.command must be a nonempty argv array.');
  }
  if (config.validation?.timeoutMs !== undefined && (!Number.isSafeInteger(config.validation.timeoutMs) || config.validation.timeoutMs <= 0)) {
    throw new Error('validation.timeoutMs must be a positive integer.');
  }
  if (config.python?.args?.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('python.args must contain valid string argv.');
  for (const [name, script] of Object.entries(config.python?.scripts ?? {})) {
    if (script.modes !== undefined && (!Array.isArray(script.modes) || script.modes.some(mode => mode !== 'chat' && mode !== 'task'))) {
      throw new Error(`python.scripts.${name}.modes must be an array containing chat and/or task. Omit modes to allow both; [] disables this script.`);
    }
  }
  return config;
}

/** Process environment wins over .env, matching normal explicit CLI overrides. */
export async function loadProjectEnvironment(projectRoot: string): Promise<NodeJS.ProcessEnv> {
  const file = resolve(projectRoot, '.env');
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (info?.isSymbolicLink()) throw new Error('.env must not be a symlink.');
  if (info && !info.isFile()) throw new Error('.env must be a regular file.');
  if (info && info.size > 131_072) throw new Error('.env exceeds 128 KiB.');
  return { ...(info ? parseEnv(await readFile(file, 'utf8')) : {}), ...process.env };
}

/** Config is executable trusted project code. Never accept a browser-supplied config path. */
export async function loadAgentConfig(projectRoot: string, configFile = 'agent.config.ts'): Promise<AgentConfig> {
  const root = await realpath(resolve(projectRoot));
  const env = await loadProjectEnvironment(root);
  const file = resolve(root, configFile);
  if (!within(root, file)) throw new Error('Config file must be inside the selected project.');
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const config = await withModelEnvironment(env, async () => {
    const imported = await jiti.import<{ default?: AgentConfig | AgentConfigFactory }>(file);
    const exported = imported.default ?? imported as unknown as AgentConfig | AgentConfigFactory;
    return defineAgent(typeof exported === 'function' ? await exported({ root, env }) : exported);
  });
  if (await realpath(resolve(config.root)) !== root) throw new Error('agent.config.ts root must match the selected project root.');
  return { ...config, root, env: { ...env, ...config.env }, provenance: { ...config.provenance, code: [...new Set([...(config.provenance?.code ?? []), relative(root, file)])] } };
}
export async function readInstructions(config: AgentConfig): Promise<string> {
  if (typeof config.instructions === 'object') return config.instructions.text;
  const path = resolve(config.root, config.instructions ?? 'AGENTS.md');
  const text = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT' && config.instructions === undefined) return '';
    throw error;
  });
  if (text.length > 128_000) throw new Error('Instructions exceed 128000 characters.');
  return text;
}

import { relative, resolve } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createJiti } from 'jiti';
import { ifExists, within } from '../store/files.js';
import { DEFAULT_MODEL, MODEL_KEY, withModelEnvironment } from './models.js';
import type { AgentConfig } from '../types.js';

export interface AgentConfigContext { root: string; env: NodeJS.ProcessEnv }
export type AgentConfigFactory = (context: AgentConfigContext) => AgentConfig | Promise<AgentConfig>;

const MAX_STEPS = 100;
const MAX_RETRIES = 10;
const MAX_REPAIRS = 5;
const APPROVAL_PATTERN = /^(?:\*|[A-Za-z0-9_-]{1,64}\*?)$/u;
const DEFAULT_LIMITS = { maxSteps: 20, timeoutMs: 600_000, maxContextChars: 120_000, maxRetries: 2 };

/** Effective turn limits: config.limits over Core defaults. Optional token budgets appear only when set. */
export function limitsOf(config: AgentConfig) {
  const { maxSteps, timeoutMs, maxContextChars, maxRetries, maxContextTokens, maxTurnTokens } = { ...DEFAULT_LIMITS, ...config.limits };
  return { maxSteps, timeoutMs, maxContextChars, maxRetries, ...(maxContextTokens ? { maxContextTokens } : {}), ...(maxTurnTokens ? { maxTurnTokens } : {}) };
}
const MAX_ENV_BYTES = 131_072;
const MAX_INSTRUCTION_CHARS = 128_000;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

const isArgv = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item && !item.includes('\0'));

function validateUi(ui: AgentConfig['ui']): void {
  if (ui === undefined) return;
  if (ui.title !== undefined && (typeof ui.title !== 'string' || !ui.title.trim() || ui.title.length > 60)) throw new Error('ui.title must contain 1–60 characters.');
  if (ui.tagline !== undefined && (typeof ui.tagline !== 'string' || ui.tagline.length > 200)) throw new Error('ui.tagline must contain at most 200 characters.');
  if (ui.accent !== undefined && (typeof ui.accent !== 'string' || !HEX_COLOR.test(ui.accent))) throw new Error('ui.accent must be a #rrggbb color.');
  if (ui.starters !== undefined) {
    if (!Array.isArray(ui.starters) || ui.starters.length > 6) throw new Error('ui.starters must be an array of at most 6 entries.');
    for (const starter of ui.starters) {
      if (typeof starter?.title !== 'string' || !starter.title.trim() || starter.title.length > 80 ||
        typeof starter.prompt !== 'string' || !starter.prompt.trim() || starter.prompt.length > 4000 ||
        (starter.mode !== undefined && starter.mode !== 'chat' && starter.mode !== 'task')) {
        throw new Error('Each ui.starters entry needs a title (≤80), a prompt (≤4000) and an optional chat/task mode.');
      }
    }
  }
}

const modelKeyKnown = (config: AgentConfig, key: string) => key === DEFAULT_MODEL || Object.hasOwn(config.models ?? {}, key);

/** approval, subagents, pricing, memory and compaction. Subagent tool names are checked once the tool set exists. */
function validateHarness(config: AgentConfig): void {
  if (config.approval !== undefined && (!Array.isArray(config.approval) || config.approval.some(item => typeof item !== 'string' || !APPROVAL_PATTERN.test(item)))) {
    throw new Error('approval must list tool names, optionally ending in * (for example "mcp_*").');
  }
  for (const [name, helper] of Object.entries(config.subagents ?? {})) {
    if (!MODEL_KEY.test(name)) throw new Error(`subagents.${name}: use 1–40 letters, digits, _ or -.`);
    if (typeof helper?.description !== 'string' || !helper.description.trim() || helper.description.length > 500) throw new Error(`subagents.${name}.description must contain 1–500 characters.`);
    if (typeof helper.instructions !== 'string' || !helper.instructions.trim() || helper.instructions.length > MAX_INSTRUCTION_CHARS) throw new Error(`subagents.${name}.instructions must be nonempty text.`);
    if (helper.tools !== undefined && (!Array.isArray(helper.tools) || helper.tools.some(tool => typeof tool !== 'string'))) throw new Error(`subagents.${name}.tools must be an array of tool names.`);
    if (helper.model !== undefined && !modelKeyKnown(config, helper.model)) throw new Error(`subagents.${name}.model "${helper.model}" is not "default" or a config.models key.`);
    if (helper.maxSteps !== undefined && (!Number.isSafeInteger(helper.maxSteps) || helper.maxSteps < 1 || helper.maxSteps > MAX_STEPS)) throw new Error(`subagents.${name}.maxSteps must be 1–100.`);
  }
  for (const [key, price] of Object.entries(config.pricing ?? {})) {
    if (!modelKeyKnown(config, key)) throw new Error(`pricing.${key} is not "default" or a config.models key.`);
    const values = [price?.input, price?.output, ...(price?.cachedInput === undefined ? [] : [price.cachedInput])];
    if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`pricing.${key} needs nonnegative input and output prices (USD per million tokens).`);
  }
  if (config.memory !== undefined && typeof config.memory !== 'boolean') throw new Error('memory must be true or false.');
  const compaction = config.compaction;
  if (compaction !== undefined && compaction !== false) {
    if (typeof compaction !== 'object' || !compaction) throw new Error('compaction must be an object or false.');
    if (compaction.at !== undefined && (typeof compaction.at !== 'number' || compaction.at < 0.2 || compaction.at > 0.95)) throw new Error('compaction.at must be between 0.2 and 0.95.');
    if (compaction.keepTurns !== undefined && (!Number.isSafeInteger(compaction.keepTurns) || compaction.keepTurns < 1 || compaction.keepTurns > 20)) throw new Error('compaction.keepTurns must be 1–20.');
    if (compaction.model !== undefined && !modelKeyKnown(config, compaction.model)) throw new Error(`compaction.model "${compaction.model}" is not "default" or a config.models key.`);
  }
}

/** Type helper and validator for agent.config.ts. Accepts a config object or a `({root, env}) => config` factory. */
export function defineAgent<const T extends AgentConfig | AgentConfigFactory>(config: T): T {
  if (typeof config === 'function') return config;
  if (!config.root || !config.model) throw new Error('Agent config requires root and a native AI SDK model.');
  if (config.models !== undefined) {
    if (!config.models || typeof config.models !== 'object' || Array.isArray(config.models)) throw new Error('models must map names to native AI SDK models.');
    for (const [key, model] of Object.entries(config.models)) {
      if (!MODEL_KEY.test(key) || key === DEFAULT_MODEL) throw new Error(`models.${key}: use 1–40 letters, digits, _ or -; "default" is reserved for config.model.`);
      if (!model) throw new Error(`models.${key} must be a native AI SDK model.`);
    }
  }
  for (const [key, value] of Object.entries(config.limits ?? {})) {
    // maxRetries: 0 disables provider retries; every other limit must be positive.
    if (!Number.isSafeInteger(value) || value < (key === 'maxRetries' ? 0 : 1)) throw new Error(`limits.${key} must be a ${key === 'maxRetries' ? 'nonnegative' : 'positive'} integer.`);
  }
  if ((config.limits?.maxSteps ?? 0) > MAX_STEPS) throw new Error('maxSteps must be at most 100.');
  if ((config.limits?.maxRetries ?? 0) > MAX_RETRIES) throw new Error('limits.maxRetries must be at most 10.');
  if (config.validation && !isArgv(config.validation.command)) throw new Error('validation.command must be a nonempty argv array.');
  if (config.validation?.timeoutMs !== undefined && (!Number.isSafeInteger(config.validation.timeoutMs) || config.validation.timeoutMs <= 0)) {
    throw new Error('validation.timeoutMs must be a positive integer.');
  }
  const repairs = config.validation?.repairAttempts;
  if (repairs !== undefined && (!Number.isSafeInteger(repairs) || repairs < 0 || repairs > MAX_REPAIRS)) throw new Error('validation.repairAttempts must be an integer from 0 to 5.');
  validateHarness(config);
  if (config.python?.args?.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('python.args must contain valid string argv.');
  for (const [name, script] of Object.entries(config.python?.scripts ?? {})) {
    if (script.modes !== undefined && (!Array.isArray(script.modes) || script.modes.some(mode => mode !== 'chat' && mode !== 'task'))) {
      throw new Error(`python.scripts.${name}.modes must be an array containing chat and/or task. Omit modes to allow both; [] disables this script.`);
    }
  }
  validateUi(config.ui);
  return config;
}

/** Parse the project .env without mutating process.env. Explicit process variables win. */
export async function loadProjectEnvironment(projectRoot: string): Promise<NodeJS.ProcessEnv> {
  const file = resolve(projectRoot, '.env');
  const info = await ifExists(lstat(file));
  if (info?.isSymbolicLink()) throw new Error('.env must not be a symlink.');
  if (info && !info.isFile()) throw new Error('.env must be a regular file.');
  if (info && info.size > MAX_ENV_BYTES) throw new Error('.env exceeds 128 KiB.');
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
  // The config file itself is part of every run's code fingerprint.
  const code = [...new Set([...(config.provenance?.code ?? []), relative(root, file)])];
  return { ...config, root, env: { ...env, ...config.env }, provenance: { ...config.provenance, code } };
}

/** Project instructions: inline text, a configured file, or AGENTS.md when present. */
export async function readInstructions(config: AgentConfig): Promise<string> {
  if (typeof config.instructions === 'object') return config.instructions.text;
  const path = resolve(config.root, config.instructions ?? 'AGENTS.md');
  const text = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT' && config.instructions === undefined) return '';
    throw error;
  });
  if (text.length > MAX_INSTRUCTION_CHARS) throw new Error('Instructions exceed 128000 characters.');
  return text;
}

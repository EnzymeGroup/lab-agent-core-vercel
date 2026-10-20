import { stat } from 'node:fs/promises';
import { generateText } from 'ai';
import { loadAgentConfig, loadProjectEnvironment, readInstructions } from '../config/load.js';
import { modelChoices, modelInfo } from '../config/models.js';
import { errorMessage } from '../errors.js';
import { createWorkspace } from '../workspace/workspace.js';
import { runCommand } from '../workspace/process.js';
import { discoverSkills } from '../tools/skills.js';
import { createTools } from '../tools/index.js';
import { describeTools } from '../tools/describe.js';
import { connectMcp, type McpStatus } from '../tools/mcp.js';
import { createSessionStore } from '../store/sessions.js';
import { createRunStore } from '../runs/store.js';
import { lockOwner } from '../store/lock.js';
import { listProjectMcp, mergeMcpServers } from '../store/mcp.js';
import type { AgentConfig } from '../types.js';

/**
 * inspect: static view of a config. Makes no MCP or model connection.
 * doctor:  checks Node, Python, scripts and MCP. Only --probe-model calls the model.
 */

export interface DiagnosticCheck { name: string; status: 'passed' | 'failed' | 'warning' | 'skipped'; message: string }
export interface DoctorOptions { root: string; configFile?: string; probeModel?: boolean }

export async function inspectConfig(config: AgentConfig) {
  const workspace = await createWorkspace(config.root, config.fileAccess);
  const skills = await discoverSkills(workspace, config.skillsDir);
  await readInstructions(config);
  const [toolDetails, sessions, runs, owner] = await Promise.all([
    describeTools(createTools(workspace, config, skills)), createSessionStore(config.root).list(), createRunStore(config).list(), lockOwner(config.root),
  ]);
  const mcp: McpStatus[] = Object.entries(mergeMcpServers(config.mcp, await listProjectMcp(config.root))).map(([name, server]) => ({ name, transport: server.transport, optional: !!server.optional, status: 'configured' }));
  return {
    project: config.root, model: modelInfo(config.model), models: modelChoices(config), skills, tools: toolDetails.map(tool => tool.name), toolDetails, mcp,
    fileAccess: { mode: config.fileAccess?.mode ?? 'analysis', readRoots: config.fileAccess?.readRoots ?? ['.'], writeRoots: config.fileAccess?.writeRoots ?? [] },
    ui: config.ui ?? {},
    busy: !!owner, active: undefined, sessions: sessions.sessions.map(({ messages: _messages, ...record }) => record), runs: runs.runs,
    issues: [...sessions.issues, ...runs.issues],
    note: 'Static configuration only; MCP tools are discovered when explicitly diagnosed or connected at runtime.',
  };
}

const nodeCheck = (): DiagnosticCheck => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 19);
  return { name: 'node', status: ok ? 'passed' : 'failed', message: `Node ${process.versions.node}; requires >=22.19.0` };
};

async function pythonChecks(config: AgentConfig, env: NodeJS.ProcessEnv): Promise<DiagnosticCheck[]> {
  const python = config.python!;
  const checks: DiagnosticCheck[] = [];
  try {
    const result = await runCommand(python.command ?? 'python3', [...(python.args ?? []), '--version'], { cwd: config.root, env, timeoutMs: 5000, maxOutputBytes: 16_384 });
    const version = (result.stdout || result.stderr).trim();
    const match = /Python (\d+)\.(\d+)/u.exec(version);
    const compatible = !!match && (+match[1] > 3 || (+match[1] === 3 && +match[2] >= 10));
    checks.push({ name: 'python', status: result.code === 0 && compatible ? 'passed' : 'failed', message: errorMessage(version || `Python exited ${result.code}.`, env) });
  } catch (error) {
    checks.push({ name: 'python', status: 'failed', message: errorMessage(error, env) });
  }
  const workspace = await createWorkspace(config.root, config.fileAccess);
  for (const [name, script] of Object.entries(python.scripts)) {
    try {
      const file = await workspace.resolve(script.path, { internal: true });
      if (!file.endsWith('.py') || !(await stat(file)).isFile()) throw new Error('Registered script must be a regular .py file inside the project.');
      checks.push({ name: `python-script:${name}`, status: 'passed', message: `Registered script exists: ${script.path}` });
    } catch (error) {
      checks.push({ name: `python-script:${name}`, status: 'failed', message: errorMessage(error, env) });
    }
  }
  return checks;
}

async function mcpStatuses(config: AgentConfig, env: NodeJS.ProcessEnv): Promise<McpStatus[]> {
  const statuses: McpStatus[] = [];
  for (const [name, server] of Object.entries(mergeMcpServers(config.mcp, await listProjectMcp(config.root)))) {
    try {
      const connection = await connectMcp({ [name]: server }, { cwd: config.root, env, timeoutMs: 5000 });
      try {
        for (const status of connection.statuses) statuses.push({ ...status, ...(status.error ? { error: errorMessage(status.error, env) } : {}) });
      } finally {
        await connection.close();
      }
    } catch (error) {
      statuses.push({ name, transport: server.transport, optional: !!server.optional, status: 'unavailable', error: errorMessage(error, env) });
    }
  }
  return statuses;
}

async function modelCheck(config: AgentConfig | undefined, probe: boolean, env: NodeJS.ProcessEnv): Promise<DiagnosticCheck> {
  if (!probe) return { name: 'model', status: 'skipped', message: 'Inference was not requested. Use doctor --probe-model for one explicit, potentially billable request.' };
  if (!config) return { name: 'model', status: 'skipped', message: 'Config unavailable; model was not probed.' };
  try {
    const result = await generateText({ model: config.model, prompt: 'Reply with OK.', maxOutputTokens: 8, maxRetries: 0, abortSignal: AbortSignal.timeout(10_000) });
    return { name: 'model', status: result.text.trim() ? 'passed' : 'failed', message: `One model request finished (${result.finishReason}); this is connectivity evidence, not reasoning-quality validation.` };
  } catch (error) {
    return { name: 'model', status: 'failed', message: errorMessage(error, env) };
  }
}

export async function doctor(options: DoctorOptions) {
  const checks: DiagnosticCheck[] = [nodeCheck()];
  let env: NodeJS.ProcessEnv = process.env;
  let config: AgentConfig | undefined;
  try {
    env = await loadProjectEnvironment(options.root);
    config = await loadAgentConfig(options.root, options.configFile);
    env = config.env ?? env;
    await inspectConfig(config);
    checks.push({ name: 'config', status: 'passed', message: 'Trusted project config, instructions, Skills and native tool schemas loaded.' });
  } catch (error) {
    checks.push({ name: 'config', status: 'failed', message: errorMessage(error, env) });
    config = undefined;
  }
  if (config?.python) checks.push(...await pythonChecks(config, env));
  else checks.push({ name: 'python', status: 'skipped', message: config ? 'No registered Python tools.' : 'Config unavailable; Python command is unknown.' });
  const mcp = config ? await mcpStatuses(config, env) : [];
  for (const server of mcp) {
    const status = server.status === 'connected' ? 'passed' : server.optional ? 'warning' : 'failed';
    checks.push({ name: `mcp:${server.name}`, status, message: server.error ?? 'Connected, listed tools and closed transport.' });
  }
  checks.push(await modelCheck(config, !!options.probeModel, env));
  const status = checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'warning') ? 'warning' : 'passed';
  return { status, project: options.root, modelProbeRequested: !!options.probeModel, checks, mcp };
}

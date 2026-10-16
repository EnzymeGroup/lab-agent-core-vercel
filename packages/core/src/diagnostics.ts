import { asSchema, generateText, type ToolSet } from 'ai';
import { loadAgentConfig, loadProjectEnvironment, readInstructions } from './config.js';
import { modelInfo } from './models.js';
import { createWorkspace } from './workspace.js';
import { discoverSkills } from './skills.js';
import { createTools } from './tools.js';
import { createSessionStore } from './session.js';
import { createRunStore } from './delivery.js';
import { errorMessage, lockOwner } from './storage.js';
import { connectMcp, type McpStatus } from './mcp.js';
import { runCommand } from './process.js';
import { stat } from 'node:fs/promises';
import type { AgentConfig } from './types.js';

export interface ToolDetail { name: string; description: string; inputSchema: unknown }
export async function describeTools(tools: ToolSet): Promise<ToolDetail[]> {
  return Promise.all(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)).map(async ([name, definition]) => ({
    name, description: typeof definition.description === 'string' ? definition.description : definition.description ? '[Dynamic description; evaluated by the SDK during execution.]' : '', inputSchema: await asSchema(definition.inputSchema).jsonSchema,
  })));
}

/** Redact scoped project credentials, which deliberately never enter process.env. */
export function redactDiagnostic(message: string, env: NodeJS.ProcessEnv = process.env): string {
  return errorMessage(new Error(message), env);
}

/** Config evaluation is trusted local code; inspection itself makes no connections. */
export async function inspectConfig(config: AgentConfig) {
  const workspace = await createWorkspace(config.root, config.fileAccess);
  const skills = await discoverSkills(workspace, config.skillsDir);
  await readInstructions(config);
  const local = createTools(workspace, config, skills);
  const [toolDetails, sessions, runs, owner] = await Promise.all([
    describeTools(local), createSessionStore(config.root).list(), createRunStore(config).list(), lockOwner(config.root),
  ]);
  const mcp: McpStatus[] = Object.entries(config.mcp ?? {}).map(([name, server]) => ({ name, transport: server.transport, optional: !!server.optional, status: 'configured' }));
  return { project: config.root, model: modelInfo(config.model), skills, tools: toolDetails.map(tool => tool.name), toolDetails, mcp,
    fileAccess: { mode: config.fileAccess?.mode ?? 'analysis', readRoots: config.fileAccess?.readRoots ?? ['.'], writeRoots: config.fileAccess?.writeRoots ?? [] },
    busy: !!owner, active: undefined, sessions: sessions.sessions.map(({ messages: _messages, ...record }) => record), runs: runs.runs,
    issues: [...sessions.issues, ...runs.issues], note: 'Static configuration only; MCP tools are discovered when explicitly diagnosed or connected at runtime.' };
}

export interface DiagnosticCheck { name: string; status: 'passed' | 'failed' | 'warning' | 'skipped'; message: string }
export interface DoctorOptions { root: string; configFile?: string; probeModel?: boolean }
export async function doctor(options: DoctorOptions) {
  const checks: DiagnosticCheck[] = [];
  const mcp: McpStatus[] = [];
  let env: NodeJS.ProcessEnv = process.env;
  let config: AgentConfig | undefined;
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push({ name: 'node', status: major > 22 || major === 22 && minor >= 19 ? 'passed' : 'failed', message: `Node ${process.versions.node}; requires >=22.19.0` });
  try {
    env = await loadProjectEnvironment(options.root);
    config = await loadAgentConfig(options.root, options.configFile);
    env = config.env ?? env;
    await inspectConfig(config);
    checks.push({ name: 'config', status: 'passed', message: 'Trusted project config, instructions, Skills and native tool schemas loaded.' });
  } catch (error) {
    checks.push({ name: 'config', status: 'failed', message: redactDiagnostic(error instanceof Error ? error.message : String(error), env) });
    config = undefined;
  }
  if (config?.python) {
    try {
      const result = await runCommand(config.python.command ?? 'python3', [...(config.python.args ?? []), '--version'], { cwd: config.root, env, timeoutMs: 5000, maxOutputBytes: 16_384 });
      const version = (result.stdout || result.stderr).trim();
      const match = /Python (\d+)\.(\d+)/u.exec(version);
      const compatible = !!match && (+match[1] > 3 || +match[1] === 3 && +match[2] >= 10);
      checks.push({ name: 'python', status: result.code === 0 && compatible ? 'passed' : 'failed', message: redactDiagnostic(version || `Python exited ${result.code}.`, env) });
    } catch (error) { checks.push({ name: 'python', status: 'failed', message: redactDiagnostic(error instanceof Error ? error.message : String(error), env) }); }
    const workspace = await createWorkspace(config.root, config.fileAccess);
    for (const [name, script] of Object.entries(config.python.scripts)) {
      try {
        const file = await workspace.resolve(script.path, { internal: true });
        if (!file.endsWith('.py') || !(await stat(file)).isFile()) throw new Error('Registered script must be a regular .py file inside the project.');
        checks.push({ name: `python-script:${name}`, status: 'passed', message: `Registered script exists: ${script.path}` });
      } catch (error) { checks.push({ name: `python-script:${name}`, status: 'failed', message: redactDiagnostic(error instanceof Error ? error.message : String(error), env) }); }
    }
  } else checks.push({ name: 'python', status: 'skipped', message: config ? 'No registered Python tools.' : 'Config unavailable; Python command is unknown.' });
  if (config) {
    for (const [name, server] of Object.entries(config.mcp ?? {})) {
      try {
        const connection = await connectMcp({ [name]: server }, { cwd: config.root, env, timeoutMs: 5000 });
        try {
          for (const status of connection.statuses) mcp.push({ ...status, ...(status.error ? { error: redactDiagnostic(status.error, env) } : {}) });
        } finally { await connection.close(); }
      } catch (error) { mcp.push({ name, transport: server.transport, optional: !!server.optional, status: 'unavailable', error: redactDiagnostic(error instanceof Error ? error.message : String(error), env) }); }
    }
  }
  for (const server of mcp) checks.push({ name: `mcp:${server.name}`, status: server.status === 'connected' ? 'passed' : server.optional ? 'warning' : 'failed', message: server.error ?? 'Connected, listed tools and closed transport.' });
  if (!options.probeModel) checks.push({ name: 'model', status: 'skipped', message: 'Inference was not requested. Use doctor --probe-model for one explicit, potentially billable request.' });
  else if (!config) checks.push({ name: 'model', status: 'skipped', message: 'Config unavailable; model was not probed.' });
  else {
    try {
      const result = await generateText({ model: config.model, prompt: 'Reply with OK.', maxOutputTokens: 8, maxRetries: 0, abortSignal: AbortSignal.timeout(10_000) });
      checks.push({ name: 'model', status: result.text.trim() ? 'passed' : 'failed', message: `One model request finished (${result.finishReason}); this is connectivity evidence, not reasoning-quality validation.` });
    } catch (error) { checks.push({ name: 'model', status: 'failed', message: redactDiagnostic(error instanceof Error ? error.message : String(error), env) }); }
  }
  return { status: checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'warning') ? 'warning' : 'passed', project: options.root, modelProbeRequested: !!options.probeModel, checks, mcp };
}

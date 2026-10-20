import { z } from 'zod';
import { InputError, NotFoundError } from '../errors.js';
import { listProjectMcp, saveProjectMcp, toServerConfig, MCP_SERVER_NAME, type ProjectMcpServer } from '../store/mcp.js';
import { connectMcp, type McpStatus } from '../tools/mcp.js';
import { describeTools } from '../tools/describe.js';
import type { AgentResources } from './resources.js';

/**
 * Workbench MCP management. Config servers (agent.config.ts) are read-only here;
 * project servers are HTTP(S) endpoints stored in .lab-agent/mcp.json.
 * Changes run under the operation gate and swap the tool set between turns.
 */

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/u;

const draftSchema = z.object({
  name: z.string().regex(MCP_SERVER_NAME, 'Server name: 1–32 letters, digits, _ or -.'),
  url: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'URL must be http(s) without embedded credentials.'),
  headers: z.record(z.string().regex(HEADER_NAME), z.string().max(4096).regex(/^[^\r\n\0]*$/u)).optional(),
});

export type McpDraft = z.infer<typeof draftSchema>;

export interface McpServerView extends McpStatus {
  source: 'config' | 'project';
  /** Project servers only; config URLs may embed secrets and are never returned. */
  url?: string;
  /** Header names only. Values are never returned. */
  headerNames?: string[];
}

function parseDraft(value: unknown): McpDraft {
  const result = draftSchema.safeParse(value);
  if (!result.success) throw new InputError(result.error.issues.map(issue => issue.message).join(' '));
  return result.data;
}

export async function listMcp(res: AgentResources): Promise<{ servers: McpServerView[]; issues: string[] }> {
  let project: ProjectMcpServer[] = [];
  const issues: string[] = [];
  try {
    project = await listProjectMcp(res.root);
  } catch (error) {
    issues.push(`.lab-agent/mcp.json: ${res.errorMessage(error)}`);
  }
  const servers = res.mcp.statuses.map(status => {
    const stored = Object.hasOwn(res.config.mcp ?? {}, status.name) ? undefined : project.find(server => server.name === status.name);
    return stored
      ? { ...status, source: 'project' as const, url: stored.url, headerNames: Object.keys(stored.headers ?? {}) }
      : { ...status, source: 'config' as const };
  });
  return { servers, issues };
}

/** Connect once, list tools, disconnect. Changes nothing. */
export async function testMcp(res: AgentResources, input: unknown) {
  const draft = parseDraft(input);
  const connection = await connectMcp({ [draft.name]: toServerConfig({ ...draft, addedAt: new Date().toISOString() }) }, { cwd: res.root, env: res.config.env });
  try {
    const status = connection.statuses[0];
    const tools = status.status === 'connected' ? await describeTools(connection.tools) : [];
    return { ...status, error: status.error && res.errorMessage(status.error), tools: tools.map(({ name, description }) => ({ name, description })) };
  } finally {
    await connection.close().catch(() => {});
  }
}

/** Persist the new list, then reconnect; the previous list is restored if reconnecting fails. */
async function replaceProjectMcp(res: AgentResources, previous: ProjectMcpServer[], next: ProjectMcpServer[]): Promise<void> {
  await saveProjectMcp(res.root, next);
  try {
    await res.reloadTools();
  } catch (error) {
    await saveProjectMcp(res.root, previous);
    throw new InputError(`MCP servers could not be applied: ${res.errorMessage(error)}`);
  }
}

export async function addMcp(res: AgentResources, input: unknown) {
  const draft = parseDraft(input);
  const lease = await res.gate.acquire();
  try {
    const project = await listProjectMcp(res.root);
    if (Object.hasOwn(res.config.mcp ?? {}, draft.name) || project.some(server => server.name === draft.name)) {
      throw new InputError(`An MCP server named ${draft.name} already exists.`);
    }
    await replaceProjectMcp(res, project, [...project, { ...draft, addedAt: new Date().toISOString() }]);
  } finally {
    await lease.release();
  }
  return listMcp(res);
}

export async function removeMcp(res: AgentResources, name: string) {
  if (Object.hasOwn(res.config.mcp ?? {}, name)) throw new InputError(`${name} is defined in agent.config.ts. Remove it there.`);
  const lease = await res.gate.acquire();
  try {
    const project = await listProjectMcp(res.root);
    if (!project.some(server => server.name === name)) throw new NotFoundError(`No project MCP server named ${name}.`);
    await replaceProjectMcp(res, project, project.filter(server => server.name !== name));
  } finally {
    await lease.release();
  }
  return listMcp(res);
}

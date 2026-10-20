import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJSON, ifExists, readJSON, storagePath } from './files.js';
import type { McpServerConfig } from '../types.js';

/**
 * HTTP MCP servers added from the workbench, stored in .lab-agent/mcp.json.
 * Only HTTP(S) endpoints: the browser can never register a local command.
 * Header values may hold credentials; they stay in this file and are never returned by the API.
 */

const FILE = '.lab-agent/mcp.json';
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;

const serverSchema = z.object({
  name: z.string().regex(MCP_SERVER_NAME),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  addedAt: z.iso.datetime(),
});
const fileSchema = z.object({ servers: z.array(serverSchema).max(50) });

export type ProjectMcpServer = z.infer<typeof serverSchema>;

export async function listProjectMcp(root: string): Promise<ProjectMcpServer[]> {
  if (!(await ifExists(lstat(await storagePath(root, FILE))))) return [];
  return fileSchema.parse(await readJSON(root, FILE)).servers;
}

export async function saveProjectMcp(root: string, servers: ProjectMcpServer[]): Promise<void> {
  await atomicJSON(root, FILE, fileSchema.parse({ servers }));
}

/** Project servers are always optional: a broken endpoint is reported, never blocks the agent. */
export function toServerConfig(server: ProjectMcpServer): McpServerConfig {
  return { transport: 'http', url: server.url, headers: server.headers, optional: true };
}

/** Config servers first; a project server never shadows a config server of the same name. */
export function mergeMcpServers(config: Record<string, McpServerConfig> = {}, project: ProjectMcpServer[]): Record<string, McpServerConfig> {
  const merged = { ...config };
  for (const server of project) if (!Object.hasOwn(merged, server.name)) merged[server.name] = toServerConfig(server);
  return merged;
}

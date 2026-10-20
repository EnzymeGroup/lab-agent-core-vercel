import { createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { McpServerConfig } from '../types.js';

/**
 * Connects configured MCP servers and exposes their tools as `mcp_<server>_<tool>`.
 * MCP programs and endpoints are trusted configuration, never model input.
 */

export interface McpConnection {
  tools: ToolSet;
  statuses: McpStatus[];
  close(): Promise<void>;
}

export interface McpStatus {
  name: string;
  transport: 'stdio' | 'http';
  optional: boolean;
  status: 'configured' | 'connected' | 'unavailable';
  error?: string;
  /** Namespaced tool names this server contributed, when connected. */
  tools?: string[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_TOOL_NAME = 64;

function connectionError(error: unknown, server: McpServerConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [server.url, ...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {})]) {
    if (value && value.length > 3) message = message.split(value).join('[redacted]');
  }
  return message;
}

function createTransport(name: string, server: McpServerConfig, options: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  if (server.transport === 'stdio') {
    if (!server.command?.trim() || server.command.includes('\0') || server.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error(`MCP server ${name} requires a command and valid string argv.`);
    }
    const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env, ...server.env })
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    return new Experimental_StdioMCPTransport({ command: server.command, args: server.args, env, cwd: options.cwd, stderr: 'inherit' });
  }
  if (server.transport === 'http') {
    let url: URL;
    try { url = new URL(server.url ?? ''); } catch { throw new Error(`MCP server ${name} requires an absolute HTTP(S) URL.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`MCP server ${name} requires an HTTP(S) URL without embedded credentials.`);
    }
    return { type: 'http', url: url.toString(), headers: server.headers } satisfies MCPClientConfig['transport'];
  }
  throw new Error(`Unsupported MCP transport for ${name}.`);
}

/** Provider tool-name limits require normalization; collisions are rejected, never overwritten. */
async function listNamespacedTools(name: string, client: MCPClient, timeout: number, existing: ToolSet): Promise<ToolSet> {
  const definitions = await client.listTools({ options: { timeout } });
  const originalNames = new Set<string>();
  for (const definition of definitions.tools) {
    if (originalNames.has(definition.name)) throw new Error(`Duplicate MCP tool name on server ${name}: ${definition.name}`);
    originalNames.add(definition.name);
  }
  const additions: ToolSet = Object.create(null) as ToolSet;
  for (const [original, nativeTool] of Object.entries(client.toolsFromDefinitions(definitions))) {
    const toolName = `mcp_${name}_${original.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
    if (toolName.length > MAX_TOOL_NAME || !original) throw new Error(`MCP tool name is empty or exceeds the provider limit on server ${name}.`);
    if (Object.hasOwn(existing, toolName) || Object.hasOwn(additions, toolName)) throw new Error(`Ambiguous MCP tool name: ${toolName}`);
    additions[toolName] = nativeTool;
  }
  return additions;
}

export async function connectMcp(
  servers: Record<string, McpServerConfig> = {},
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<McpConnection> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw new Error('MCP timeoutMs must be 1–60000.');
  const clients: MCPClient[] = [];
  const statuses: McpStatus[] = [];
  const tools: ToolSet = Object.create(null) as ToolSet;

  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled([...clients].reverse().map(client => client.close()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Unable to close every MCP server.');
  })();

  try {
    for (const [name, server] of Object.entries(servers)) {
      if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
      let client: MCPClient | undefined;
      let transport: ReturnType<typeof createTransport> | undefined;
      try {
        transport = createTransport(name, server, options);
        client = await createMCPClient({ transport, clientName: 'lab-agent-core-vercel', initializationOptions: { timeout }, maxRetries: 0 });
        const added = await listNamespacedTools(name, client, timeout, tools);
        Object.assign(tools, added);
        clients.push(client);
        statuses.push({ name, transport: server.transport, optional: !!server.optional, status: 'connected', tools: Object.keys(added) });
      } catch (error) {
        try {
          if (client) await client.close();
          else if (transport instanceof Experimental_StdioMCPTransport) await transport.close();
        } catch { /* The original startup failure remains the primary diagnostic. */ }
        if (!server.optional) throw error;
        statuses.push({ name, transport: server.transport, optional: true, status: 'unavailable', error: connectionError(error, server) });
      }
    }
    return { tools, statuses, close };
  } catch (error) {
    try { await close(); } catch (closeError) { throw new AggregateError([error, closeError], 'MCP startup failed and cleanup reported an error.'); }
    throw error;
  }
}

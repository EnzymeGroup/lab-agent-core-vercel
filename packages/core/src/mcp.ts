import { createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { McpServerConfig } from './types.js';

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
}

function connectionError(error: unknown, server: McpServerConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [server.url, ...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {})]) {
    if (value && value.length > 3) message = message.split(value).join('[redacted]');
  }
  return message;
}

/** MCP programs and endpoints are trusted configuration, never model input. */
export async function connectMcp(servers: Record<string, McpServerConfig> = {}, options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<McpConnection> {
  const clients: MCPClient[] = [];
  const statuses: McpStatus[] = [];
  const tools: ToolSet = Object.create(null) as ToolSet;
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('MCP timeoutMs must be 1–60000.');
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      const results = await Promise.allSettled([...clients].reverse().map(client => client.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Unable to close every MCP server.');
    })();
    return closePromise;
  };
  try {
    for (const [name, server] of Object.entries(servers)) {
      if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
      let client: MCPClient | undefined;
      let stdio: Experimental_StdioMCPTransport | undefined;
      try {
      let transport: MCPClientConfig['transport'];
      if (server.transport === 'stdio') {
        if (!server.command?.trim() || server.command.includes('\0') || server.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
          throw new Error(`MCP server ${name} requires a command and valid string argv.`);
        }
        const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env, ...server.env }).filter((entry): entry is [string, string] => entry[1] !== undefined));
        transport = stdio = new Experimental_StdioMCPTransport({ command: server.command, args: server.args, env, cwd: options.cwd, stderr: 'inherit' });
      } else if (server.transport === 'http') {
        let url: URL;
        try { url = new URL(server.url ?? ''); } catch { throw new Error(`MCP server ${name} requires an absolute HTTP(S) URL.`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`MCP server ${name} requires an HTTP(S) URL without embedded credentials.`);
        transport = { type: 'http', url: url.toString(), headers: server.headers };
      } else throw new Error(`Unsupported MCP transport for ${name}.`);
      client = await createMCPClient({
        transport,
        clientName: 'lab-agent-core-vercel',
        initializationOptions: { timeout },
        maxRetries: 0,
      });
      const definitions = await client.listTools({ options: { timeout } });
      const originalNames = new Set<string>();
      for (const definition of definitions.tools) {
        if (originalNames.has(definition.name)) throw new Error(`Duplicate MCP tool name on server ${name}: ${definition.name}`);
        originalNames.add(definition.name);
      }
      const nativeTools = client.toolsFromDefinitions(definitions);
      const additions: ToolSet = Object.create(null) as ToolSet;
      for (const [original, nativeTool] of Object.entries(nativeTools)) {
        // Providers constrain tool names. Normalization is deterministic, and
        // collisions are rejected rather than silently overwriting a tool.
        const toolName = `mcp_${name}_${original.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
        if (toolName.length > 64 || !original) throw new Error(`MCP tool name is empty or exceeds the provider limit on server ${name}.`);
        if (Object.hasOwn(tools, toolName) || Object.hasOwn(additions, toolName)) throw new Error(`Ambiguous MCP tool name: ${toolName}`);
        additions[toolName] = nativeTool;
      }
      Object.assign(tools, additions);
      clients.push(client);
      statuses.push({ name, transport: server.transport, optional: !!server.optional, status: 'connected' });
      } catch (error) {
        try { if (client) await client.close(); else await stdio?.close(); }
        catch { /* Original startup failure remains the primary diagnostic. */ }
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

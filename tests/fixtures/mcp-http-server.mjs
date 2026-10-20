import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** A deterministic local Streamable HTTP MCP server (labeled fixture). Requires `Authorization: Bearer <token>` when token is set. */
export async function startMcpHttpServer({ token } = {}) {
  const server = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    // Stateless mode: one MCP server and transport per request.
    const mcp = new McpServer({ name: 'lab-agent-http-fixture', version: '1.0.0' });
    mcp.registerTool('echo', { description: 'Return a deterministic HTTP MCP echo.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `HTTP echo: ${text}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'lab-agent-local-fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'Return a deterministic local MCP echo.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `MCP echo: ${text}` }] }));
await server.connect(new StdioServerTransport());

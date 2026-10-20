import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { errorMessage } from '../errors.js';
import { createRequestHandler } from './routes.js';
import type { LabAgent } from '../agent/create.js';

/**
 * Loopback-only Node HTTP server for the workbench and its API.
 * One per agent; a per-process bearer token guards every API call.
 */

export interface ServerOptions { port?: number; assets?: string; token?: string; demo?: boolean; browserOrigin?: string }

const MIN_TOKEN_CHARS = 24;
const DEFAULT_ASSETS = fileURLToPath(new URL('../../workbench', import.meta.url));

function toRequest(base: string, incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = incoming.method ?? 'GET';
  const body = method !== 'GET' && method !== 'HEAD' ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {};
  return new Request(`${base}${incoming.url ?? '/'}`, { method, headers, ...body } as RequestInit);
}

/** Stream a web Response to Node with backpressure; stop reading if the client leaves. */
async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.flushHeaders();
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  let disconnected = false;
  const onClose = () => { disconnected = true; void reader.cancel().catch(() => {}); };
  outgoing.once('close', onClose);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || disconnected) break;
      if (!outgoing.write(Buffer.from(chunk.value))) {
        await new Promise<void>(accept => {
          const done = () => { outgoing.off('drain', done); outgoing.off('close', done); accept(); };
          outgoing.once('drain', done);
          outgoing.once('close', done);
        });
      }
    }
  } finally {
    outgoing.off('close', onClose);
    reader.releaseLock();
    if (!disconnected) outgoing.end();
  }
}

export async function createHttpServer(agent: LabAgent, options: ServerOptions = {}) {
  const browserOrigin = options.browserOrigin === undefined ? undefined : new URL(options.browserOrigin);
  if (browserOrigin && (browserOrigin.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(browserOrigin.hostname)
    || browserOrigin.username || browserOrigin.password || browserOrigin.pathname !== '/'
    || browserOrigin.search || browserOrigin.hash)) {
    throw new Error('browserOrigin must be an HTTP loopback origin without credentials, path, query or fragment.');
  }
  const token = options.token ?? randomBytes(32).toString('hex');
  if (token.length < MIN_TOKEN_CHARS) throw new Error('Workbench token must contain at least 24 characters.');
  let handler: ReturnType<typeof createRequestHandler>;
  let browserHandler: ReturnType<typeof createRequestHandler> | undefined;
  let url = '';

  const server = createServer((incoming, outgoing) => {
    const forwarded = browserHandler && incoming.headers.host === browserOrigin?.host;
    const requestHandler = forwarded ? browserHandler : handler;
    const requestOrigin = forwarded ? browserOrigin!.origin : url;
    void (async () => sendResponse(await requestHandler!(toRequest(requestOrigin, incoming)), outgoing))().catch(error => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: { message: errorMessage(error) } }));
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', accept);
  });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  handler = createRequestHandler(agent, { origin: url, token, demo: options.demo, assets: options.assets ?? DEFAULT_ASSETS });
  if (browserOrigin) {
    browserHandler = createRequestHandler(agent, { origin: browserOrigin.origin, token, demo: options.demo, assets: options.assets ?? DEFAULT_ASSETS });
  }

  let closed: Promise<void> | undefined;
  return {
    url,
    token,
    /** Stop accepting requests, close the agent, then drop open connections. */
    close() {
      return closed ??= (async () => {
        const stopped = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
        try {
          await agent.close();
        } finally {
          server.closeAllConnections();
          await stopped;
        }
      })();
    },
  };
}

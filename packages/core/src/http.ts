import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';
import type { LabAgent } from './agent.js';
import { BusyError, errorMessage, InputError, NotFoundError, storagePath } from './storage.js';
import { importUpload, listUploads, openArtifact, previewArtifact, uploadExtensions, uploadLimit } from './files.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new InputError('Send application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Request body is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const value = await reader.read(); if (value.done) break;
      size += value.value.byteLength;
      if (size > 256_000) { await reader.cancel(); throw new InputError('Request exceeds 256000 bytes.'); }
      chunks.push(value.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('Request body must contain valid JSON.'); }
}
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InputError(result.error.message);
  return result.data;
}
export interface ServerOptions { port?: number; assets?: string; token?: string; demo?: boolean }
export function createRequestHandler(agent: LabAgent, options: { origin: string; token: string; assets: string; demo?: boolean }) {
  const protect = (request: Request) => {
    const url = new URL(request.url);
    if (url.origin !== options.origin || request.headers.get('host') && request.headers.get('host') !== new URL(options.origin).host ||
      request.headers.get('origin') && request.headers.get('origin') !== options.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return false;
    }
    return true;
  };
  return async (request: Request): Promise<Response> => {
    try {
      if (!protect(request)) return json({ error: { message: 'Only this local origin is allowed.' } }, 403);
      const url = new URL(request.url);
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json({ token: options.token, demo: !!options.demo });
      if (url.pathname.startsWith('/api/')) {
        const received = Buffer.from(request.headers.get('authorization') ?? '');
        const expected = Buffer.from(`Bearer ${options.token}`);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) return json({ error: { message: 'Invalid local workbench token.' } }, 403);
        if (request.method === 'GET' && url.pathname === '/api/state') return json({ ...await agent.inspect(), demo: !!options.demo });
        if (request.method === 'GET' && url.pathname === '/api/session') return json(await agent.sessions.load(url.searchParams.get('id') ?? ''));
        if (request.method === 'GET' && url.pathname === '/api/run') {
          const id = url.searchParams.get('id') ?? '';
          return json({ run: await agent.runs.load(id), check: await agent.runs.report(id) });
        }
        if (request.method === 'GET' && url.pathname === '/api/uploads') return json({ files: await listUploads(agent.config.root), maxBytes: uploadLimit, extensions: uploadExtensions });
        if (request.method === 'POST' && url.pathname === '/api/uploads') return json(await importUpload(agent.config.root, url.searchParams.get('name') ?? '', request), 201);
        if (request.method === 'GET' && url.pathname === '/api/preview') return json(await previewArtifact(agent, url.searchParams.get('runId') ?? '', url.searchParams.get('path') ?? ''));
        if (request.method === 'GET' && url.pathname === '/api/artifact') {
          const artifact = await openArtifact(agent, url.searchParams.get('runId') ?? '', url.searchParams.get('path') ?? '');
          return new Response(Readable.toWeb(artifact.handle.createReadStream()) as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, 'X-Content-Type-Options': 'nosniff' } });
        }
        if (request.method === 'POST' && url.pathname === '/api/sessions') {
          const input = parseInput(z.object({ title: z.string().max(160).optional() }), await body(request));
          return json(await agent.sessions.create(input.title), 201);
        }
        if (request.method === 'POST' && url.pathname === '/api/chat') {
          const input = parseInput(z.object({ sessionId: z.string(), mode: z.enum(['chat', 'task']).default('chat'),
            workflowId: z.string().optional(), parentRunId: z.string().optional(),
            messages: z.array(z.object({ id: z.string(), role: z.string(), parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough()).min(1),
          }), await body(request));
          const last = input.messages.at(-1)!;
          if (last.role !== 'user' || last.parts.some(part => part.type !== 'text')) throw new InputError('Send a user message containing text parts only.');
          const turn = await agent.streamTurn({ sessionId: input.sessionId, messageId: last.id, message: last.parts.map(part => part.text ?? '').join('\n'), mode: input.mode, workflowId: input.workflowId, parentRunId: input.parentRunId });
          return createUIMessageStreamResponse({ stream: turn.stream, headers: { 'x-lab-session-id': turn.sessionId, ...(turn.runId ? { 'x-lab-run-id': turn.runId } : {}) } });
        }
        if (request.method === 'POST' && url.pathname === '/api/cancel') return json({ canceled: agent.cancel() });
        if (request.method === 'POST' && url.pathname === '/api/check') {
          const input = parseInput(z.object({ runId: z.string() }), await body(request));
          return json(await agent.runs.check(input.runId));
        }
        return json({ error: { message: 'Unknown API endpoint.' } }, 404);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: { message: 'Method not allowed.' } }, 405);
      const name = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = await storagePath(options.assets, name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return json({ error: { message: 'Workbench asset not found. Build the project before launching the UI.' } }, 404);
      return new Response(request.method === 'HEAD' ? null : await readFile(file), { headers: { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
        'Cache-Control': name.startsWith('_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store' } });
    } catch (error) {
      const status = error instanceof BusyError ? 409 : error instanceof NotFoundError ? 404 :
        error instanceof InputError || error instanceof URIError ? 400 : 500;
      return json({ error: { message: errorMessage(error, agent.config.env) } }, status);
    }
  };
}
export async function createHttpServer(agent: LabAgent, options: ServerOptions = {}) {
  const token = options.token ?? randomBytes(32).toString('hex');
  if (token.length < 24) throw new Error('Workbench token must contain at least 24 characters.');
  let handler: ReturnType<typeof createRequestHandler>;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const method = incoming.method ?? 'GET';
      const request = new Request(`${url}${incoming.url ?? '/'}`, { method, headers,
        ...(method !== 'GET' && method !== 'HEAD' ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}) } as RequestInit);
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.flushHeaders();
      if (!response.body) { outgoing.end(); return; }
      const reader = response.body.getReader();
      let disconnected = false;
      const onClose = () => { disconnected = true; void reader.cancel().catch(() => {}); };
      outgoing.once('close', onClose);
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done || disconnected) break;
          if (!outgoing.write(Buffer.from(chunk.value))) await new Promise<void>(accept => {
            const done = () => { outgoing.off('drain', done); outgoing.off('close', done); accept(); };
            outgoing.once('drain', done); outgoing.once('close', done);
          });
        }
      } finally { outgoing.off('close', onClose); reader.releaseLock(); if (!disconnected) outgoing.end(); }
    })().catch(error => {
      if (!outgoing.headersSent) { outgoing.writeHead(500, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ error: { message: errorMessage(error) } })); }
      else outgoing.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', accept); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  handler = createRequestHandler(agent, { origin: url, token, demo: options.demo, assets: options.assets ?? fileURLToPath(new URL('../workbench', import.meta.url)) });
  let closed: Promise<void> | undefined;
  return { url, token, close() {
    return closed ??= (async () => {
      const stopped = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
      try { await agent.close(); }
      finally { server.closeAllConnections(); await stopped; }
    })();
  } };
}

import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';
import { BusyError, errorMessage, InputError, NotFoundError } from '../errors.js';
import { storagePath } from '../store/files.js';
import { importUpload, listUploads, openArtifact, previewArtifact, readBody, uploadExtensions, uploadLimit } from './files.js';
import { decisionsFromMessage } from '../agent/approval.js';
import type { LabAgent } from '../agent/create.js';
import type { TurnStream } from '../types.js';

/**
 * The workbench API. Every /api route except /api/bootstrap needs
 * `Authorization: Bearer <token>`. All requests must come from this exact origin.
 */

const MAX_JSON_BYTES = 256_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (message: string, status: number) => json({ error: { message } }, status);

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new InputError('Send application/json.');
  const body = await readBody(request, MAX_JSON_BYTES, 'Request exceeds 256000 bytes.');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new InputError('Request body must contain valid JSON.');
  }
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readJson(request));
  if (!result.success) throw new InputError(result.error.message);
  return result.data;
}

const chatSchema = z.object({
  sessionId: z.string(),
  mode: z.enum(['chat', 'task']).default('chat'),
  model: z.string().max(40).optional(),
  workflowId: z.string().optional(),
  parentRunId: z.string().optional(),
  inputs: z.array(z.string().min(1)).max(256).optional(),
  attachments: z.array(z.string().min(1)).max(8).optional(),
  messages: z.array(z.object({
    id: z.string(), role: z.string(),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  }).passthrough()).min(1),
});

type Route = (request: Request, url: URL) => Promise<Response>;

function apiRoutes(agent: LabAgent, demo: boolean): Record<string, Route> {
  const param = (url: URL, name: string) => url.searchParams.get(name) ?? '';
  return {
    'GET /api/state': async () => json({ ...await agent.inspect(), demo }),
    'GET /api/session': async (_, url) => json(await agent.sessions.load(param(url, 'id'))),
    'POST /api/sessions': async request => {
      const { title } = await parseBody(request, z.object({ title: z.string().max(160).optional() }));
      return json(await agent.sessions.create(title), 201);
    },
    // Only the newest message is read; history is loaded server-side. A user message starts a
    // turn. An assistant message carrying approval responses (useChat addToolApprovalResponse)
    // answers the paused turn; only its decisions are used, never its parts.
    'POST /api/chat': async request => {
      const input = await parseBody(request, chatSchema);
      const last = input.messages.at(-1)!;
      let turn: TurnStream;
      const decisions = decisionsFromMessage(last);
      if (decisions.length) {
        turn = await agent.respond({ sessionId: input.sessionId, approvals: decisions });
      } else {
        if (last.role !== 'user' || last.parts.some(part => part.type !== 'text')) throw new InputError('Send a user message containing text parts only.');
        turn = await agent.streamTurn({
          sessionId: input.sessionId, messageId: last.id, message: last.parts.map(part => part.text ?? '').join('\n'),
          mode: input.mode, model: input.model, workflowId: input.workflowId, parentRunId: input.parentRunId, inputs: input.inputs,
          attachments: input.attachments,
        });
      }
      return createUIMessageStreamResponse({ stream: turn.stream, headers: { 'x-lab-session-id': turn.sessionId, ...(turn.runId ? { 'x-lab-run-id': turn.runId } : {}) } });
    },
    'POST /api/steer': async request => {
      const { sessionId, text } = await parseBody(request, z.object({ sessionId: z.string(), text: z.string() }));
      return json(agent.steer(sessionId, text), 202);
    },
    'POST /api/compact': async request => {
      const { sessionId } = await parseBody(request, z.object({ sessionId: z.string() }));
      const session = await agent.compact(sessionId);
      return json({ summary: session.summary, usage: session.usage });
    },
    'POST /api/cancel': async () => json({ canceled: agent.cancel() }),
    'GET /api/skill': async (_, url) => json(await agent.skills.read(param(url, 'name'))),
    'POST /api/mcp/test': async request => json(await agent.mcp.test(await readJson(request))),
    'POST /api/mcp': async request => json(await agent.mcp.add(await readJson(request)), 201),
    'DELETE /api/mcp': async (_, url) => json(await agent.mcp.remove(param(url, 'name'))),
    'PUT /api/tools': async request => json(await agent.tools.update(await readJson(request))),
    'GET /api/memory': async (_, url) => json(await agent.memory.read(param(url, 'name'))),
    'DELETE /api/memory': async (_, url) => {
      await agent.memory.forget(param(url, 'name'));
      return json({ forgotten: param(url, 'name') });
    },
    'GET /api/run': async (_, url) => {
      const id = param(url, 'id');
      return json({ run: await agent.runs.load(id), check: await agent.runs.report(id) });
    },
    'POST /api/check': async request => {
      const { runId } = await parseBody(request, z.object({ runId: z.string() }));
      return json(await agent.runs.check(runId));
    },
    'GET /api/uploads': async () => json({ files: await listUploads(agent.config.root), maxBytes: uploadLimit, extensions: uploadExtensions }),
    'POST /api/uploads': async (request, url) => json(await importUpload(agent.config.root, param(url, 'name'), request), 201),
    'GET /api/preview': async (_, url) => json(await previewArtifact(agent, param(url, 'runId'), param(url, 'path'))),
    'GET /api/artifact': async (_, url) => {
      const artifact = await openArtifact(agent, param(url, 'runId'), param(url, 'path'));
      return new Response(Readable.toWeb(artifact.handle.createReadStream()) as ReadableStream<Uint8Array>, {
        headers: {
          'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        },
      });
    },
  };
}

async function serveAsset(assets: string, request: Request, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('Method not allowed.', 405);
  const decoded = decodeURIComponent(url.pathname);
  const name = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = await storagePath(assets, name);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return fail('Workbench asset not found. Build the project before launching the UI.', 404);
  return new Response(request.method === 'HEAD' ? null : await readFile(file), {
    headers: {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Cache-Control': name.startsWith('_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store',
    },
  });
}

function statusFor(error: unknown): number {
  if (error instanceof BusyError) return 409;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof InputError || error instanceof URIError) return 400;
  return 500;
}

export function createRequestHandler(agent: LabAgent, options: { origin: string; token: string; assets: string; demo?: boolean }) {
  const host = new URL(options.origin).host;
  const expected = Buffer.from(`Bearer ${options.token}`);
  const routes = apiRoutes(agent, !!options.demo);

  const sameOrigin = (request: Request) => {
    const headers = request.headers;
    return new URL(request.url).origin === options.origin
      && (!headers.get('host') || headers.get('host') === host)
      && (!headers.get('origin') || headers.get('origin') === options.origin)
      && headers.get('sec-fetch-site') !== 'cross-site';
  };
  const authorized = (request: Request) => {
    const received = Buffer.from(request.headers.get('authorization') ?? '');
    return received.length === expected.length && timingSafeEqual(received, expected);
  };

  return async (request: Request): Promise<Response> => {
    try {
      if (!sameOrigin(request)) return fail('Only this local origin is allowed.', 403);
      const url = new URL(request.url);
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json({ token: options.token, demo: !!options.demo });
      if (!url.pathname.startsWith('/api/')) return await serveAsset(options.assets, request, url);
      if (!authorized(request)) return fail('Invalid local workbench token.', 403);
      const route = routes[`${request.method} ${url.pathname}`];
      return route ? await route(request, url) : fail('Unknown API endpoint.', 404);
    } catch (error) {
      return fail(errorMessage(error, agent.config.env), statusFor(error));
    }
  };
}

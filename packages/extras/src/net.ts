import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * Outbound HTTP for tools that take a URL from the model. Every hop, including redirects,
 * is checked at connect time (the DNS answer actually used), so a hostname cannot resolve
 * to loopback, private, link-local or metadata addresses unless allowPrivate is set.
 */

export interface GuardedResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** The body was cut at maxBytes. */
  truncated: boolean;
}

export interface GuardedRequestOptions {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  allowPrivate?: boolean;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 3],
];

function v4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

/** Loopback, private, shared, link-local (cloud metadata), documentation, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = v4Number(address);
    return PRIVATE_V4.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/u.exec(lower);
  if (mapped) {
    const v4 = mapped[1] ?? [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
    return isPrivateAddress(v4);
  }
  return lower === '::' || lower === '::1' || /^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower) || /^ff/u.test(lower) || lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8');
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const list = addresses as LookupAddress[];
      const blocked = !allowPrivate && list.find(item => isPrivateAddress(item.address));
      if (blocked || !list.length) {
        const denied: NodeJS.ErrnoException = new Error(`${hostname} resolves to a private or reserved address (${blocked ? blocked.address : 'none'}); refused.`);
        denied.code = 'EPRIVATE';
        return callback(denied, '');
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

function decoded(stream: Readable, encoding: string | undefined): Readable {
  if (encoding === 'gzip' || encoding === 'x-gzip') return stream.pipe(createGunzip());
  if (encoding === 'deflate') return stream.pipe(createInflate());
  if (encoding === 'br') return stream.pipe(createBrotliDecompress());
  return stream;
}

function requestOnce(url: URL, options: GuardedRequestOptions, signal: AbortSignal): Promise<{ status: number; location?: string; contentType: string; body: Buffer; truncated: boolean }> {
  return new Promise((accept, reject) => {
    const allowPrivate = !!options.allowPrivate;
    const literal = url.hostname.replace(/^\[|\]$/gu, '');
    if (isIP(literal) && !allowPrivate && isPrivateAddress(literal)) {
      reject(new Error(`${literal} is a private or reserved address; refused.`));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET', signal, lookup: guardedLookup(allowPrivate) as never,
      headers: { 'user-agent': 'lab-agent-extras/0.1 (+webFetch)', accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br', ...options.headers },
    }, response => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers['content-type'] ?? '');
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        accept({ status, location: response.headers.location, contentType, body: Buffer.alloc(0), truncated: false });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const body = decoded(response, response.headers['content-encoding']);
      body.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = options.maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          truncated = true;
          response.destroy();
          accept({ status, contentType, body: Buffer.concat(chunks), truncated });
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      body.on('end', () => accept({ status, contentType, body: Buffer.concat(chunks), truncated }));
      body.on('error', error => { if (!truncated) reject(error); });
    });
    request.on('error', reject);
    request.end();
  });
}

/** GET a public http(s) URL, following at most maxRedirects redirects, each one re-checked. */
export async function guardedGet(input: string, options: GuardedRequestOptions): Promise<GuardedResponse> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  let url = new URL(input);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https URLs can be fetched: ${url.protocol}`);
    if (url.username || url.password) throw new Error('URLs with embedded credentials are refused.');
    const response = await requestOnce(url, options, signal);
    if (response.location) {
      if (hop >= (options.maxRedirects ?? 5)) throw new Error(`Too many redirects (last: ${url.href}).`);
      url = new URL(response.location, url);
      continue;
    }
    return { url: url.href, status: response.status, contentType: response.contentType, body: response.body, truncated: response.truncated };
  }
}

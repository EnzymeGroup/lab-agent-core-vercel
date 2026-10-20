'use client';

import { useState } from 'react';
import { ChevronRight, Plug, Trash2 } from 'lucide-react';
import { api, errorMessage, type McpServer, type McpTestResult } from '../lib/api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/**
 * MCP servers: status and tools for every server, plus adding, testing and removing
 * project HTTP servers. stdio servers can only be configured in agent.config.ts.
 */

const statusTone = (status: McpServer['status']) => status === 'connected' ? 'success' : status === 'unavailable' ? 'danger' : 'neutral';
const field = 'h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs placeholder:text-muted-foreground disabled:opacity-50';

/** "Name: value" per line → header record. */
function parseHeaders(text: string): Record<string, string> | undefined {
  const entries = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`Header lines need "Name: value": ${line}`);
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function ServerItem({ server, disabled, onRemove }: { server: McpServer; disabled: boolean; onRemove(): void }) {
  return (
    <li className="rounded-md border p-3 text-xs">
      <div className="flex items-center gap-2">
        <strong className="font-medium">{server.name}</strong>
        <Badge tone={statusTone(server.status)}>{server.status}</Badge>
        <span className="text-muted-foreground">{server.transport} · {server.source === 'project' ? 'added in workbench' : 'agent.config.ts'}</span>
        {server.source === 'project' && (
          <Button variant="ghost" size="icon-sm" className="ml-auto" disabled={disabled} onClick={onRemove} aria-label={`Remove MCP server ${server.name}`} title="Remove"><Trash2 /></Button>
        )}
      </div>
      {server.url && <code className="mt-1 block font-mono text-[11px] break-all text-muted-foreground">{server.url}</code>}
      {server.headerNames?.length ? <p className="mt-1 text-muted-foreground">Headers: {server.headerNames.join(', ')} (values hidden)</p> : null}
      {server.error && <p className="mt-1 break-words text-destructive">{server.error}</p>}
      {server.tools?.length ? (
        <details className="group mt-2">
          <summary className="flex items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronRight className="size-3 transition-transform group-open:rotate-90" />{server.tools.length} tool{server.tools.length === 1 ? '' : 's'}</summary>
          <ul className="mt-1.5 space-y-0.5 pl-4">{server.tools.map(name => <li key={name}><code className="font-mono">{name}</code></li>)}</ul>
        </details>
      ) : null}
    </li>
  );
}

export default function McpServers({ token, servers, busy, onChanged }: { token: string; servers: McpServer[]; busy: boolean; onChanged(): Promise<unknown> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [result, setResult] = useState<McpTestResult>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'' | 'test' | 'add' | 'remove'>('');
  const disabled = busy || !!pending;

  async function run(kind: 'test' | 'add' | 'remove', action: () => Promise<unknown>) {
    setPending(kind);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending('');
    }
  }
  const draft = () => JSON.stringify({ name: name.trim(), url: url.trim(), headers: parseHeaders(headers) });
  const test = () => run('test', async () => {
    setResult(undefined);
    setResult(await api<McpTestResult>(token, '/api/mcp/test', { method: 'POST', body: draft() }));
  });
  const add = () => run('add', async () => {
    await api(token, '/api/mcp', { method: 'POST', body: draft() });
    setName(''); setUrl(''); setHeaders(''); setResult(undefined);
    await onChanged();
  });
  const remove = (server: string) => run('remove', async () => {
    await api(token, `/api/mcp?name=${encodeURIComponent(server)}`, { method: 'DELETE' });
    await onChanged();
  });

  return (
    <div className="space-y-3">
      {servers.length
        ? <ul className="capability-list grid gap-2">{servers.map(server => <ServerItem key={server.name} server={server} disabled={disabled} onRemove={() => { void remove(server.name); }} />)}</ul>
        : <p className="text-xs text-muted-foreground">No MCP servers configured.</p>}

      <form className="space-y-2 rounded-md border p-3 text-xs" onSubmit={event => { event.preventDefault(); void add(); }}>
        <p className="flex items-center gap-1.5 font-medium"><Plug className="size-3.5 text-muted-foreground" />Add an HTTP MCP server</p>
        <p className="text-muted-foreground">Streamable HTTP endpoints only. Local stdio servers run programs on this machine, so they can only be added in agent.config.ts.</p>
        <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
          <label className="sr-only" htmlFor="mcp-name">Server name</label>
          <input id="mcp-name" className={field} placeholder="name" value={name} onChange={event => setName(event.target.value)} disabled={disabled} />
          <label className="sr-only" htmlFor="mcp-url">Server URL</label>
          <input id="mcp-url" className={`${field} font-mono`} placeholder="https://example.com/mcp" value={url} onChange={event => setUrl(event.target.value)} disabled={disabled} />
        </div>
        <label className="sr-only" htmlFor="mcp-headers">Request headers</label>
        <textarea id="mcp-headers" rows={2} className={`${field} h-auto py-1.5 font-mono`} placeholder={'Authorization: Bearer …   (optional, one per line)'} value={headers} onChange={event => setHeaders(event.target.value)} disabled={disabled} />
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || !name.trim() || !url.trim()} onClick={() => { void test(); }}>{pending === 'test' ? 'Testing…' : 'Test connection'}</Button>
          <Button type="submit" size="sm" disabled={disabled || !name.trim() || !url.trim()}>{pending === 'add' ? 'Adding…' : 'Add server'}</Button>
        </div>
        {busy && <p className="text-muted-foreground">An operation is active. MCP changes apply between turns.</p>}
        {error && <p role="alert" className="break-words text-destructive">{error}</p>}
        {result && (
          <div role="status" className="rounded-md bg-muted p-2.5">
            <p className="flex items-center gap-2"><Badge tone={statusTone(result.status)}>{result.status}</Badge>{result.status === 'connected' ? `${result.tools.length} tool(s) found` : result.error}</p>
            {result.tools.length > 0 && <ul className="mt-1.5 space-y-1">{result.tools.map(tool => <li key={tool.name}><code className="font-mono">{tool.name}</code> <span className="text-muted-foreground">{tool.description}</span></li>)}</ul>}
          </div>
        )}
      </form>
    </div>
  );
}

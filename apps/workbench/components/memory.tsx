'use client';

import { useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { api, errorMessage, type MemoryEntry } from '../lib/api';
import { Markdown } from './markdown';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/** Project memory entries: the body on demand, and delete. The agent writes them with saveMemory. */

function MemoryItem({ token, entry, onForget }: { token: string; entry: MemoryEntry; onForget(): Promise<void> }) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function load() {
    if (content !== undefined) return;
    try {
      setContent((await api<{ content: string }>(token, `/api/memory?name=${encodeURIComponent(entry.name)}`)).content);
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function forget() {
    setPending(true);
    try {
      await onForget();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <li className="rounded-md border text-xs">
      <details className="group" onToggle={event => { if ((event.target as HTMLDetailsElement).open) void load(); }}>
        <summary className="flex items-start gap-2 p-3 hover:bg-accent/60">
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2"><strong className="font-medium">{entry.name}</strong><Badge>{entry.type}</Badge></span>
            <span className="mt-0.5 block text-muted-foreground">{entry.description}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">Updated {new Date(entry.updatedAt).toLocaleString()}</span>
          </span>
          <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Forget memory ${entry.name}`} title="Forget"
            onClick={event => { event.preventDefault(); void forget(); }}><Trash2 /></Button>
        </summary>
        <div className="border-t px-4 py-3">
          {error ? <p role="alert" className="text-destructive">{error}</p>
            : content === undefined ? <p role="status" className="text-muted-foreground">Loading…</p>
              : <Markdown>{content}</Markdown>}
        </div>
      </details>
    </li>
  );
}

export default function Memory({ token, entries, onChanged }: { token: string; entries: MemoryEntry[] | false | undefined; onChanged(): Promise<unknown> }) {
  if (entries === undefined) return <p className="text-xs text-muted-foreground">Memory is not reported by this server.</p>;
  if (entries === false) return <p className="text-xs text-muted-foreground">Memory is off (memory: false in agent.config.ts).</p>;
  if (!entries.length) return <p className="text-xs text-muted-foreground">No memories yet. The agent saves durable facts, preferences and lessons here with saveMemory; later sessions see them.</p>;
  const forget = async (name: string) => {
    await api(token, `/api/memory?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await onChanged();
  };
  return <ul className="memory-list capability-list grid gap-2">{entries.map(entry => <MemoryItem key={entry.name} token={token} entry={entry} onForget={() => forget(entry.name)} />)}</ul>;
}

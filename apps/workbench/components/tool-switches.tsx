'use client';

import { useState } from 'react';
import { api, errorMessage, type ToolDetail } from '../lib/api';

/**
 * Per-project switches for one tool: turn it off for the model, or (for tools in
 * config.approval) stop asking. Saved in .lab-agent/tools.json; applies from the next step.
 */
export default function ToolSwitches({ token, tool, busy, onChanged }: { token: string; tool: ToolDetail; busy: boolean; onChanged(): Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Shown until the refreshed state arrives, so a checkbox never snaps back mid-request.
  const [optimistic, setOptimistic] = useState<{ enabled?: boolean; alwaysAllow?: boolean }>({});
  if (tool.enabled === undefined) return null;
  const enabled = optimistic.enabled ?? tool.enabled;
  const alwaysAllow = optimistic.alwaysAllow ?? !!tool.alwaysAllow;

  async function change(body: { enabled?: boolean; alwaysAllow?: boolean }) {
    setPending(true);
    setError('');
    setOptimistic(previous => ({ ...previous, ...body }));
    try {
      await api(token, '/api/tools', { method: 'PUT', body: JSON.stringify({ name: tool.name, ...body }) });
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setOptimistic({});
      setPending(false);
    }
  }

  const disabled = pending || busy;
  return (
    <div className="tool-switches mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" className="accent-primary" checked={enabled} disabled={disabled}
          aria-label={`Enable ${tool.name}`} onChange={event => { void change({ enabled: event.target.checked }); }} />
        Enabled
      </label>
      {tool.needsApproval && (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-primary" checked={alwaysAllow} disabled={disabled}
            aria-label={`Always allow ${tool.name}`} onChange={event => { void change({ alwaysAllow: event.target.checked }); }} />
          Always allow
        </label>
      )}
      {busy && <span className="text-muted-foreground">Available when no turn is running.</span>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>
  );
}

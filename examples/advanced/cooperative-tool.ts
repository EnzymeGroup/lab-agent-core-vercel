import { tool } from 'ai';
import { z } from 'zod';

/** endpoint is trusted configuration; the model can choose only an entry ID. */
export function createLookupTool(endpoint: string) {
  return tool({
    description: 'Retrieve one record from the configured project service.',
    inputSchema: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }),
    execute: async ({ id }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const url = new URL(`records/${encodeURIComponent(id)}`, endpoint);
      const response = await fetch(url, { signal: abortSignal });
      if (!response.ok) throw new Error(`Project service returned ${response.status}`);
      const record: unknown = await response.json();
      abortSignal?.throwIfAborted();
      return record;
    },
  });
}

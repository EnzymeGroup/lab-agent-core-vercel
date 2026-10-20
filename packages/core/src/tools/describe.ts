import { asSchema, type ToolSet } from 'ai';

export interface ToolDetail { name: string; description: string; inputSchema: unknown }

/** Name, description and JSON schema for every tool, sorted by name. */
export async function describeTools(tools: ToolSet): Promise<ToolDetail[]> {
  const entries = Object.entries(tools).sort(([a], [b]) => a.localeCompare(b));
  return Promise.all(entries.map(async ([name, definition]) => ({
    name,
    description: typeof definition.description === 'string'
      ? definition.description
      : definition.description ? '[Dynamic description; evaluated by the SDK during execution.]' : '',
    inputSchema: await asSchema(definition.inputSchema).jsonSchema,
  })));
}

import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFromEnv } from '../../packages/core/dist/index.js';

// Shared test setup. Deterministic local fixtures only; nothing here is live model inference.

export const repository = fileURLToPath(new URL('../../', import.meta.url));

/** Generated state that never belongs in a copied example. */
const GENERATED = /(?:^|\/)(?:runs|\.lab-agent|node_modules|__pycache__)(?:\/|$)/u;

/** Copy examples/<name> into a new temp directory and return it. The caller removes it. */
export async function copyExample(prefix, name = 'sequence-summary') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(path.join(repository, 'examples', name), root, { recursive: true, filter: source => !GENERATED.test(source) });
  return root;
}

/** An OpenAI-compatible model pointed at tests/fixtures/model-server.mjs. */
export function fixtureModel(url, id = 'fixture') {
  return modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: id, LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: url });
}

/** Call a native tool the way the SDK does: parse the input with its schema first, so defaults apply. */
export function callTool(tools, name, input = {}, options = {}) {
  return tools[name].execute(tools[name].inputSchema.parse(input), { toolCallId: 'test', messages: [], ...options });
}

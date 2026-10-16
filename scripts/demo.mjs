import { cp, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgent, loadAgentConfig, createHttpServer, modelFromEnv } from 'lab-agent-core-vercel';
import { startModelServer } from '../tests/fixtures/model-server.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const project = path.resolve(value('--root') ?? process.env.LAB_AGENT_DEMO_ROOT ?? path.join(repository, '.artifacts/demo-project'));
const port = Number(value('--port') ?? process.env.LAB_AGENT_DEMO_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
await mkdir(project, { recursive: true });
if (!await access(path.join(project, 'agent.config.ts')).then(() => true, () => false)) {
  await cp(path.join(repository, 'examples/sequence-summary'), project, { recursive: true });
  // A demo directory may be anywhere; point this copied config at this build.
  const configFile = path.join(project, 'agent.config.ts');
  const config = await readFile(configFile, 'utf8');
  await writeFile(configFile, config.replace("'lab-agent-core-vercel'", JSON.stringify(pathToFileURL(path.join(repository, 'packages/core/dist/index.js')).href)));
}
const model = await startModelServer();
const fixtureEnv = { LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'deterministic-demo', LAB_AGENT_API_KEY: 'local-fixture-only', LAB_AGENT_BASE_URL: model.url };
Object.assign(process.env, fixtureEnv);
let agent;
let server;
try {
  agent = await createAgent({ ...await loadAgentConfig(project), model: modelFromEnv(fixtureEnv) });
  server = await createHttpServer(agent, { port, assets: path.join(repository, 'packages/core/workbench'), demo: true });
} catch (error) {
  await agent?.close();
  await model.close();
  throw error;
}
console.log('Deterministic local demo: real AI SDK HTTP/tool loop; no live model inference.');
console.log(`Project and persistent sessions: ${project}`);
console.log(`Open ${server.url}`);
console.log('Try: Summarize the FASTA and validate the artifacts.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await agent.close();
  await model.close();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

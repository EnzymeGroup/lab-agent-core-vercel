#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createAgent, RunError } from './agent.js';
import { loadAgentConfig } from './config.js';
import { createHttpServer } from './http.js';
import { scaffold } from './scaffold.js';
import { errorMessage } from './storage.js';

const help = `lab-agent — scientific Agent execution with AI SDK

  init <directory>                 Create an independent Agent project
  run <task> [--session ID]         Execute a task, write outputs and check delivery
  chat [--session ID]              Official interactive terminal UI
  check <run-id|runs/path>          Recheck existing outputs without model inference
  dev | serve [--port N]           Open the local browser workbench
  sessions                        List durable sessions
  inspect | models                Inspect loaded configuration (no inference)
  recover                         Record interrupted runs, never replay tools

Options: --root DIR --config FILE --json --session ID --port N --help
Config and registered scripts are trusted project code. Server binds loopback.
`;
export async function main(args = process.argv.slice(2)): Promise<number> {
  let jsonOutput = args.includes('--json');
  let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
  let server: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  const cancel = () => agent?.cancel();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      root: { type: 'string', default: '.' }, config: { type: 'string', default: 'agent.config.ts' },
      session: { type: 'string' }, json: { type: 'boolean', default: false }, port: { type: 'string' }, help: { type: 'boolean', default: false },
    } });
    jsonOutput = parsed.values.json;
    const [command, ...positionals] = parsed.positionals;
    if (parsed.values.help || !command) { process.stdout.write(help); return 0; }
    if (command === 'init') {
      if (positionals.length !== 1) throw new Error('Usage: lab-agent init <directory>');
      const root = await scaffold(positionals[0]);
      process.stdout.write(jsonOutput ? `${JSON.stringify({ root })}\n` : `Created ${root}\nInstall lab-agent-core-vercel, configure .env, then run npm run run -- "your task".\n`);
      return 0;
    }
    if (!['run', 'chat', 'check', 'dev', 'serve', 'sessions', 'inspect', 'models', 'recover'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const config = await loadAgentConfig(resolve(parsed.values.root), parsed.values.config);
    agent = await createAgent(config);
    const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, jsonOutput ? 0 : 2)}\n`);
    if (command === 'run') {
      if (!positionals.length) throw new Error('Usage: lab-agent run <task> [--session ID]');
      const run = await agent.runTask(positionals.join(' '), { sessionId: parsed.values.session });
      print(run);
      return run.delivery === 'failed' ? 1 : run.delivery === 'partial' ? 2 : 0;
    }
    if (command === 'check') {
      if (positionals.length !== 1) throw new Error('Usage: lab-agent check <run-id|runs/path>');
      const run = await agent.runs.check(positionals[0]); print(run);
      return run.delivery === 'failed' ? 1 : run.delivery === 'partial' ? 2 : 0;
    }
    if (command === 'sessions') { print((await agent.inspect()).sessions); return 0; }
    if (command === 'recover') { print({ recovered: await agent.recover() }); return 0; }
    if (command === 'inspect') { print(await agent.inspect()); return 0; }
    if (command === 'models') { print({ model: (await agent.inspect()).model, note: 'Supply any native AI SDK model in agent.config.ts, or configure LAB_AGENT_PROVIDER and LAB_AGENT_MODEL.' }); return 0; }
    const port = parsed.values.port === undefined ? 8787 : Number(parsed.values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
    server = await createHttpServer(agent, { port: command === 'chat' ? 0 : port });
    if (command === 'chat') {
      const session = parsed.values.session ? await agent.sessions.load(parsed.values.session) : await agent.sessions.create('Terminal conversation');
      const { DefaultChatTransport } = await import('ai');
      const { runAgentTUI } = await import('@ai-sdk/tui');
      await runAgentTUI({ title: `Lab Agent · ${session.id}`, transport: new DefaultChatTransport({ api: `${server.url}/api/chat`, headers: { Authorization: `Bearer ${server.token}` }, body: { sessionId: session.id, mode: 'chat' } }) });
      return 0;
    }
    process.stdout.write(`${jsonOutput ? JSON.stringify({ url: server.url }) : `Lab Agent workbench: ${server.url}\nProject: ${config.root}`}\n`);
    await new Promise<void>(accept => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); accept(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
    return 0;
  } catch (error) {
    if (error instanceof RunError) {
      process.stdout.write(`${JSON.stringify(error.run, null, jsonOutput ? 0 : 2)}\n`);
      if (!jsonOutput) process.stderr.write(`${errorMessage(error)}\n`);
    } else if (jsonOutput) process.stdout.write(`${JSON.stringify({ error: { message: errorMessage(error) } })}\n`);
    else process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (server) await server.close(); else await agent?.close();
  }
}
process.exitCode = await main();

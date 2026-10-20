#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createAgent, type LabAgent } from '../agent/create.js';
import { loadAgentConfig, loadProjectEnvironment } from '../config/load.js';
import { errorMessage, RunError } from '../errors.js';
import { createHttpServer } from '../server/http.js';
import { checkRun } from '../runs/check.js';
import { loadEvalFile, runEvals } from '../agent/eval.js';
import { forgetMemory, listMemory, readMemory } from '../store/memory.js';
import { doctor, inspectConfig } from './doctor.js';
import { nextSteps, scaffold, templates } from './scaffold.js';
import type { RunRecord } from '../types.js';

const help = `lab-agent — build and run AI SDK agents with persistent sessions and checked deliveries

  init <directory> --template NAME  Create a project (${templates.join(' or ')})
  dev | serve [--port N]            Open the local browser workbench (default port 8787)
  chat [--session ID]               Interactive terminal UI
  run <task> [--input PATH]         Run a task; repeat --input to freeze its inputs
  approve --session ID [--deny]     Answer the tool calls a paused turn waits for, then continue it
  eval [FILE] [--repeat N]          Run evals.json cases and grade them with the checker
  check <run-id|runs/path>          Recheck a run's outputs without calling the model
  memory [NAME] [--forget]          List project memory, show one entry, or delete it
  sessions                          List saved sessions
  inspect | models                  Show the configuration; no MCP or model connection
  doctor [--probe-model]            Check Node, Python and MCP; --probe-model sends one request
  recover                           Mark interrupted work after a crash; never replays tools

Options: --root DIR --config FILE --json --session ID --port N --template NAME --reason TEXT --forget --help
Config and registered scripts are trusted project code. The server binds to 127.0.0.1.
`;

const PROJECT_COMMANDS = new Set(['run', 'approve', 'eval', 'memory', 'chat', 'check', 'dev', 'serve', 'sessions', 'inspect', 'models', 'doctor', 'recover']);
/** A task paused for approval exits 3 so scripts can tell it from success and failure. */
const AWAITING_EXIT_CODE = 3;
const DEFAULT_PORT = 8787;

/** 0 passed/not_checked, 2 partial, 1 failed. */
const deliveryExitCode = (run: RunRecord) => run.delivery === 'failed' ? 1 : run.delivery === 'partial' ? 2 : 0;

function parseCli(args: string[]) {
  return parseArgs({
    args, allowPositionals: true, strict: true, options: {
      root: { type: 'string', default: '.' }, config: { type: 'string', default: 'agent.config.ts' },
      session: { type: 'string' }, json: { type: 'boolean', default: false }, port: { type: 'string' },
      help: { type: 'boolean', default: false }, template: { type: 'string', default: 'python' },
      'probe-model': { type: 'boolean', default: false }, input: { type: 'string', multiple: true },
      deny: { type: 'boolean', default: false }, reason: { type: 'string' }, repeat: { type: 'string' },
      forget: { type: 'boolean', default: false },
    },
  });
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  return port;
}

const waitForSignal = () => new Promise<void>(accept => {
  const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); accept(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});

export async function main(args = process.argv.slice(2)): Promise<number> {
  let jsonOutput = args.includes('--json');
  let agent: LabAgent | undefined;
  let server: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  let env: NodeJS.ProcessEnv = process.env;
  const commandController = new AbortController();
  const cancel = () => {
    agent?.cancel();
    commandController.abort(new DOMException('Canceled by user.', 'AbortError'));
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  try {
    const { values, positionals: [command, ...rest] } = parseCli(args);
    jsonOutput = values.json;
    const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, jsonOutput ? 0 : 2)}\n`);
    if (values.help || !command) {
      process.stdout.write(help);
      return 0;
    }

    if (command === 'init') {
      if (rest.length !== 1) throw new Error('Usage: lab-agent init <directory>');
      const root = await scaffold(rest[0], { template: values.template });
      process.stdout.write(jsonOutput ? `${JSON.stringify({ root })}\n` : `Created ${root}\n${nextSteps}\n`);
      return 0;
    }
    if (!PROJECT_COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
    if (values['probe-model'] && command !== 'doctor') throw new Error('--probe-model is only valid for doctor.');
    if (values.input && command !== 'run') throw new Error('--input is only valid for run.');
    if ((values.deny || values.reason) && command !== 'approve') throw new Error('--deny and --reason are only valid for approve.');
    if (values.repeat && command !== 'eval') throw new Error('--repeat is only valid for eval.');
    if (values.forget && command !== 'memory') throw new Error('--forget is only valid for memory.');
    const root = resolve(values.root);

    if (command === 'doctor') {
      const report = await doctor({ root, configFile: values.config, probeModel: values['probe-model'] });
      print(report);
      return report.status === 'failed' ? 1 : 0;
    }

    env = await loadProjectEnvironment(root);
    const config = await loadAgentConfig(root, values.config);
    env = config.env ?? env;
    if (command === 'inspect') {
      print(await inspectConfig(config));
      return 0;
    }
    if (command === 'models') {
      print({ model: (await inspectConfig(config)).model, note: 'Static configuration only. Native AI SDK models are accepted; use doctor --probe-model for explicit inference.' });
      return 0;
    }
    // Memory files need no model or MCP connection.
    if (command === 'memory') {
      if (rest.length > 1 || (values.forget && !rest.length)) throw new Error('Usage: lab-agent memory [NAME] [--forget]');
      if (!rest.length) {
        const { entries, issues } = await listMemory(config.root);
        print({ entries: entries.map(({ content: _content, ...entry }) => entry), issues });
      } else if (values.forget) {
        await forgetMemory(config.root, rest[0]);
        print({ forgotten: rest[0] });
      } else {
        print(await readMemory(config.root, rest[0]));
      }
      return 0;
    }
    if (command === 'check') {
      if (rest.length !== 1) throw new Error('Usage: lab-agent check <run-id|runs/path>');
      const run = await checkRun(config, rest[0], { signal: commandController.signal });
      print(run);
      return deliveryExitCode(run);
    }

    agent = await createAgent(config);
    if (command === 'run') {
      if (!rest.length) throw new Error('Usage: lab-agent run <task> [--session ID] [--input PATH]');
      const run = await agent.runTask(rest.join(' '), { sessionId: values.session, inputs: values.input });
      print(run);
      if (run.execution === 'awaiting_approval') {
        if (!jsonOutput) process.stderr.write(`Paused for tool approval. Continue with: lab-agent approve --session ${run.session.id} [--deny]\n`);
        return AWAITING_EXIT_CODE;
      }
      return deliveryExitCode(run);
    }
    if (command === 'approve') {
      if (!values.session) throw new Error('Usage: lab-agent approve --session ID [--deny] [--reason TEXT]');
      const result = await agent.approve(values.session, !values.deny, values.reason);
      print(result.run ?? { session: result.session.id, text: result.text, error: result.error, pendingApprovals: result.pendingApprovals });
      if (result.pendingApprovals) return AWAITING_EXIT_CODE;
      if (result.run) return result.run.execution === 'completed' ? deliveryExitCode(result.run) : 1;
      return result.error ? 1 : 0;
    }
    if (command === 'eval') {
      const repeat = values.repeat === undefined ? undefined : Number(values.repeat);
      if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)) throw new Error('--repeat must be an integer from 1 to 20.');
      const report = await runEvals(agent, await loadEvalFile(config.root, rest[0]), { repeat });
      print(jsonOutput ? report : { summary: report.summary, report: report.file });
      return report.summary.passed === report.summary.total ? 0 : 1;
    }
    if (command === 'sessions') {
      print((await agent.inspect()).sessions);
      return 0;
    }
    if (command === 'recover') {
      print({ recovered: await agent.recover() });
      return 0;
    }

    const port = parsePort(values.port);
    server = await createHttpServer(agent, { port: command === 'chat' ? 0 : port });
    if (command === 'chat') {
      const session = values.session ? await agent.sessions.load(values.session) : await agent.sessions.create('Terminal conversation');
      const { DefaultChatTransport } = await import('ai');
      const { runAgentTUI } = await import('@ai-sdk/tui');
      const title = config.ui?.title ?? 'Lab Agent';
      await runAgentTUI({
        title: `${title} · ${session.id}`,
        transport: new DefaultChatTransport({ api: `${server.url}/api/chat`, headers: { Authorization: `Bearer ${server.token}` }, body: { sessionId: session.id, mode: 'chat' } }),
      });
      return 0;
    }
    process.stdout.write(`${jsonOutput ? JSON.stringify({ url: server.url }) : `Workbench: ${server.url}\nProject:   ${config.root}`}\n`);
    await waitForSignal();
    return 0;
  } catch (error) {
    if (error instanceof RunError) {
      // A failed task still has an honest terminal record; print it.
      process.stdout.write(`${JSON.stringify(error.run, null, jsonOutput ? 0 : 2)}\n`);
      if (!jsonOutput) process.stderr.write(`${errorMessage(error, env)}\n`);
    } else if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({ error: { message: errorMessage(error, env) } })}\n`);
    } else {
      process.stderr.write(`${errorMessage(error, env)}\n`);
    }
    return 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    if (server) await server.close();
    else await agent?.close();
  }
}

process.exitCode = await main();

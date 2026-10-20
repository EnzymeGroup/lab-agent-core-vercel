import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, createHttpServer, modelFromEnv, loadEvalFile, runEvals, InputError } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';

// Deterministic local HTTP model fixture. Not live model inference.
const repository = fileURLToPath(new URL('../', import.meta.url));

/** Writes AGENT_CHECK_FILE: fails the first `failures` checks, then passes. */
const CHECKER = `import json, os, pathlib
counter = pathlib.Path(os.environ['AGENT_ROOT']) / 'check-count.txt'
count = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(count))
failures = int(os.environ.get('FIXTURE_FAILURES', '0'))
status = 'failed' if count <= failures else 'passed'
issues = ['summary.json is missing'] if status == 'failed' else []
pathlib.Path(os.environ['AGENT_CHECK_FILE']).write_text(json.dumps({'status': status, 'checks': [{'name': 'fixture', 'status': status}], 'issues': issues}))
`;

async function setup(t, { fixture: fixtureOptions, config = {}, checkerFailures } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-agent-harness-'));
  await cp(path.join(repository, 'examples/sequence-summary'), root, { recursive: true,
    filter: source => !/(?:^|\/)(?:runs|\.lab-agent|__pycache__)(?:\/|$)/.test(source) });
  await writeFile(path.join(root, 'tools/fixture_check.py'), CHECKER);
  const fixture = await startModelServer(fixtureOptions);
  const model = modelFromEnv({ LAB_AGENT_PROVIDER: 'openai', LAB_AGENT_MODEL: 'fixture-default', LAB_AGENT_API_KEY: 'fixture-only', LAB_AGENT_BASE_URL: fixture.url });
  const calls = [];
  const stamp = tool({
    description: 'Stamp a note (side effect that needs approval in these tests).',
    inputSchema: z.object({ note: z.string() }),
    execute: async ({ note }) => { calls.push(note); return { stamped: note }; },
  });
  const agent = await createAgent({
    root, model, tools: { stamp },
    env: { ...process.env, FIXTURE_FAILURES: String(checkerFailures ?? 0) },
    validation: { command: ['python3', 'tools/fixture_check.py'] },
    ...config,
  });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  return { root, agent, fixture, calls };
}

const completions = fixture => fixture.requests.filter(request => request.path === '/v1/chat/completions');
const toolParts = (session, name) => session.messages.flatMap(message => message.parts).filter(part => part.type === `tool-${name}`);

test('approval: a configured tool pauses the turn; approve runs it, deny never does', async t => {
  const { agent, calls } = await setup(t, { fixture: { plan: [{ name: 'stamp', args: { note: 'first' } }] }, config: { approval: ['stamp'], validation: undefined } });
  const state = await agent.inspect();
  assert.equal(state.toolDetails.find(detail => detail.name === 'stamp').needsApproval, true);
  assert.equal(state.toolDetails.find(detail => detail.name === 'readFile').needsApproval, false);

  const paused = await agent.chat('[chat-only] stamp it');
  assert.equal(paused.session.state, 'awaiting_approval');
  assert.equal(paused.pendingApprovals.length, 1);
  assert.equal(paused.pendingApprovals[0].toolName, 'stamp');
  assert.deepEqual(calls, [], 'nothing runs before approval');
  await assert.rejects(agent.chat('[chat-only] something else', { sessionId: paused.session.id }), InputError);
  await assert.rejects(agent.respond({ sessionId: paused.session.id, approvals: [{ approvalId: 'forged', approved: true }] }), /No pending approval/);

  const approved = await agent.approve(paused.session.id, true);
  assert.equal(approved.session.state, 'idle');
  assert.deepEqual(calls, ['first']);
  assert.equal(toolParts(approved.session, 'stamp')[0].state, 'output-available');
  assert.equal(approved.session.messages.filter(message => message.role === 'assistant').length, 1, 'the same assistant message continues');
  assert.equal(approved.session.usage.turns, 1, 'a continuation is not a new turn');

  // Task mode: the run waits (not terminal, not recovered) and finishes after a denial.
  const run = await agent.runTask('[chat-only] stamp in a task');
  assert.equal(run.execution, 'awaiting_approval');
  assert.deepEqual(await agent.recover(), [], 'a paused run is not crash debris');
  const denied = await agent.approve(run.session.id, false, 'Not today');
  assert.equal(denied.run.execution, 'completed');
  assert.equal(toolParts(denied.session, 'stamp')[0].state, 'output-denied');
  assert.deepEqual(calls, ['first']);
  assert.equal(denied.run.steps.length, 2, 'steps from both halves are kept');
});

test('retries: a transient provider failure is retried; maxRetries 0 fails at once', async t => {
  const { agent, fixture } = await setup(t, { fixture: { failFirst: 1, plan: [] } });
  const result = await agent.chat('hello');
  assert.equal(result.error, undefined);
  assert.equal(completions(fixture).length, 2);

  const strict = await setup(t, { fixture: { failFirst: 1, plan: [] }, config: { limits: { maxRetries: 0 } } });
  await assert.rejects(strict.agent.chat('hello'), /transient failure/);
});

test('tool-call repair: a misspelled tool name runs the matching tool', async t => {
  const { agent } = await setup(t, { fixture: { plan: [{ name: 'list_files', args: { path: '.' } }] } });
  const { session } = await agent.chat('look around');
  const [call] = toolParts(session, 'listFiles');
  assert.equal(call.state, 'output-available');
  assert.equal(toolParts(session, 'list_files').length, 0, 'the stored part names the real tool');
  // The session stays compatible with the tool set for the next turn.
  await agent.chat('[chat-only] again', { sessionId: session.id });
});

test('compaction: older turns become a summary in the model view; history stays complete', async t => {
  const { agent, fixture } = await setup(t, { fixture: { plan: [] }, config: { limits: { maxContextChars: 4000 }, compaction: { at: 0.5, keepTurns: 1 } } });
  const long = '[chat-only] ' + 'x'.repeat(1500);
  const first = await agent.chat(long);
  assert.equal(first.session.summary, undefined);
  const second = await agent.chat(long, { sessionId: first.session.id });
  const session = second.session;
  assert.equal(session.messages.length, 4, 'history is never rewritten');
  assert.equal(session.summary.messageCount, 2);
  assert.equal(session.summary.throughMessageId, session.messages[1].id);
  const summaryRequest = completions(fixture).at(-2).body;
  assert.equal(summaryRequest.tools, undefined);
  const firstUser = completions(fixture).at(-1).body.messages.find(message => message.role === 'user');
  assert.match(firstUser.content, /^\[Summary of 2 earlier messages/);
  assert.equal(session.messages.at(-1).metadata.context.summarizedMessages, 2);
  assert.equal(session.usage.turns, 2);
  assert.equal(session.usage.totalTokens, 60, 'two turns plus one summary call');
});

test('readToolOutput pages through a result that was clipped in the model view', async t => {
  const big = tool({ description: 'Big output', inputSchema: z.object({}), execute: async () => 'y'.repeat(30_000) });
  const { agent } = await setup(t, {
    fixture: { plan: [{ name: 'big', args: {} }, { name: 'readToolOutput', args: { toolCallId: 'call_1', offset: 2000, length: 100 } }] },
    config: { tools: { big }, limits: { maxContextChars: 24_000 } },
  });
  const { session } = await agent.chat('read the big thing');
  const [read] = toolParts(session, 'readToolOutput');
  assert.equal(read.state, 'output-available');
  assert.equal(read.output.text, 'y'.repeat(100));
  assert.ok(read.output.total > 30_000 && read.output.more);
});

test('repair loop: a failed check goes back to the agent until the checker passes', async t => {
  const { agent, fixture } = await setup(t, { fixture: { plan: [] }, config: { validation: { command: ['python3', 'tools/fixture_check.py'], repairAttempts: 2 } }, checkerFailures: 1 });
  const run = await agent.runTask('write the summary');
  assert.equal(run.delivery, 'passed');
  assert.equal(run.repairs, 1);
  assert.deepEqual(run.checks.map(check => [check.kind, check.delivery]), [['initial', 'failed'], ['repair', 'passed']]);
  assert.equal(run.originalDelivery.delivery, 'failed', 'the first verdict is kept');
  const session = await agent.sessions.load(run.session.id);
  const repair = session.messages.find(message => message.metadata?.source === 'repair');
  assert.match(repair.parts[0].text, /Automatic repair 1 of 2[\s\S]*summary\.json is missing/);
  assert.equal(completions(fixture).length, 2);
});

test('repair loop stops at repairAttempts and keeps the honest verdict', async t => {
  const { agent } = await setup(t, { fixture: { plan: [] }, config: { validation: { command: ['python3', 'tools/fixture_check.py'], repairAttempts: 1 } }, checkerFailures: 5 });
  const run = await agent.runTask('write the summary');
  assert.equal(run.delivery, 'failed');
  assert.equal(run.repairs, 1);
  assert.equal(run.checks.length, 2);
});

test('subagents: runSubagent delegates to a helper with its own tools; only its answer returns', async t => {
  const plan = input => (input.tools ?? []).some(item => item.function.name === 'runSubagent')
    ? [{ name: 'runSubagent', args: { agent: 'scout', task: 'List the project files.' } }]
    : [{ name: 'listFiles', args: { path: '.' } }];
  const { agent, fixture } = await setup(t, {
    fixture: { plan },
    config: { validation: undefined, approval: ['stamp'], subagents: { scout: { description: 'Looks at project files.', instructions: 'List files and report briefly.', tools: ['listFiles'] } } },
  });
  const state = await agent.inspect();
  assert.deepEqual(state.subagents.map(item => [item.name, item.tools]), [['scout', ['listFiles']]]);
  const run = await agent.runTask('delegate');
  const session = await agent.sessions.load(run.session.id);
  const [call] = toolParts(session, 'runSubagent');
  assert.equal(call.state, 'output-available');
  assert.equal(call.output.status, 'done');
  assert.deepEqual(call.output.tools, ['listFiles']);
  assert.ok(run.steps.some(step => step.agent === 'scout'));
  const helperRequest = completions(fixture).find(request => request.body.tools?.length === 1);
  assert.equal(helperRequest.body.tools[0].function.name, 'listFiles');

  await assert.rejects(createAgent({ root: agent.config.root, model: agent.config.model, tools: agent.config.tools, approval: ['stamp'], subagents: { bad: { description: 'x', instructions: 'y', tools: ['stamp'] } } }), /needs approval/);
});

test('updatePlan records a checklist', async t => {
  const items = [{ step: 'Read inputs', status: 'done' }, { step: 'Write report', status: 'in_progress' }];
  const { agent } = await setup(t, { fixture: { plan: [{ name: 'updatePlan', args: { items } }] } });
  const { session } = await agent.chat('plan it');
  const [call] = toolParts(session, 'updatePlan');
  assert.deepEqual(call.output, { items, done: 1, total: 2 });
});

test('steering: a message sent mid-turn reaches the next step and is stored as a user message', async t => {
  const plan = input => JSON.stringify(input.messages).includes('STEER') ? [] : [{ name: 'listFiles', args: { path: '.' } }];
  const { agent, fixture } = await setup(t, { fixture: { plan, delayMs: 800 } });
  const session = await agent.sessions.create();
  assert.throws(() => agent.steer(session.id, 'nothing running'), InputError);
  const turn = await agent.streamTurn({ sessionId: session.id, message: '[wait] start' });
  void turn.stream.cancel();
  while (!completions(fixture).length) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(agent.steer(session.id, 'STEER also note the data folder'), { queued: 1 });
  const result = await turn.completed;
  assert.equal(result.error, undefined);
  assert.equal(completions(fixture).length, 2, 'injected at the next step, no extra segment');
  assert.equal(completions(fixture)[1].body.messages.at(-1).content, 'STEER also note the data folder');
  assert.deepEqual(result.session.messages.map(message => [message.role, message.metadata?.source]), [['user', undefined], ['assistant', undefined], ['user', 'steer'], ['assistant', undefined]]);
  assert.ok(!result.session.messages.some(message => message.parts.some(part => part.type === 'data-steer')));
});

test('steering after the last step becomes a follow-up segment', async t => {
  const { agent, fixture } = await setup(t, { fixture: { plan: [], delayMs: 800 } });
  const session = await agent.sessions.create();
  const turn = await agent.streamTurn({ sessionId: session.id, message: '[wait] [chat-only] start' });
  void turn.stream.cancel();
  while (!completions(fixture).length) await new Promise(resolve => setTimeout(resolve, 20));
  agent.steer(session.id, 'one more thing');
  const result = await turn.completed;
  assert.equal(completions(fixture).length, 2);
  assert.deepEqual(result.session.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(result.session.messages[2].metadata.source, 'steer');
});

test('telemetry: runs record each model call with tools, usage and cost; sessions add them up', async t => {
  const { agent } = await setup(t, { fixture: { plan: [{ name: 'listFiles', args: { path: '.' } }] }, config: { validation: undefined, pricing: { default: { input: 1, output: 2 } } } });
  const run = await agent.runTask('look');
  assert.equal(run.steps.length, 2);
  assert.deepEqual(run.steps.map(step => [step.agent, step.model, step.finishReason]), [['main', 'default', 'tool-calls'], ['main', 'default', 'stop']]);
  assert.equal(run.steps[0].tools[0].name, 'listFiles');
  assert.equal(typeof run.steps[0].tools[0].ms, 'number');
  assert.equal(run.usage.totalTokens, 40);
  assert.ok(Math.abs(run.costUsd - 2 * (12 * 1 + 8 * 2) / 1e6) < 1e-12);
  const session = await agent.sessions.load(run.session.id);
  assert.equal(session.usage.totalTokens, 40);
  assert.equal(session.usage.turns, 1);
  assert.ok(Math.abs(session.usage.costUsd - run.costUsd) < 1e-12);
});

test('limits.maxTurnTokens stops the loop with an explicit budget error', async t => {
  const { agent, fixture } = await setup(t, { fixture: { plan: [1, 2, 3, 4].map(() => ({ name: 'listFiles', args: { path: '.' } })) }, config: { limits: { maxTurnTokens: 30 } } });
  await assert.rejects(agent.chat('loop'), /token budget/);
  assert.equal(completions(fixture).length, 2);
});

test('evals: every case is run and graded by the checker; approvals are denied unattended', async t => {
  const { root, agent, calls } = await setup(t, { fixture: { plan: [{ name: 'stamp', args: { note: 'eval' } }] }, config: { approval: ['stamp'] } });
  await writeFile(path.join(root, 'evals.json'), JSON.stringify({ cases: [{ name: 'one', task: 'first case' }, { name: 'two', task: 'second case', repeat: 2 }] }));
  const cases = await loadEvalFile(root);
  const report = await runEvals(agent, cases);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.passed, 3);
  assert.deepEqual(report.summary.cases, [{ name: 'one', passed: 1, total: 1 }, { name: 'two', passed: 2, total: 2 }]);
  assert.ok(report.attempts.every(item => item.deniedApprovals === 1));
  assert.deepEqual(calls, []);
  await access(path.join(root, report.file));
  const saved = JSON.parse(await readFile(path.join(root, report.file), 'utf8'));
  assert.equal(saved.summary.passRate, 1);
  await assert.rejects(loadEvalFile(root, '../outside.json'), InputError);
});

test('HTTP: approval through /api/chat, steer and compact routes', async t => {
  const { agent, calls } = await setup(t, { fixture: { plan: [{ name: 'stamp', args: { note: 'http' } }] }, config: { approval: ['stamp'], validation: undefined } });
  const server = await createHttpServer(agent);
  t.after(() => server.close());
  const call = (route, body) => fetch(`${server.url}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const state = await (await fetch(`${server.url}/api/state`, { headers: { Authorization: `Bearer ${server.token}` } })).json();
  assert.deepEqual(state.approval, ['stamp']);
  assert.equal(state.compaction.at, 0.75);

  const paused = await agent.chat('stamp');
  const assistant = paused.session.messages.at(-1);
  const part = assistant.parts.find(item => item.type === 'tool-stamp');
  const response = await call('/api/chat', { sessionId: paused.session.id, messages: [{ ...assistant, parts: [{ ...part, state: 'approval-responded', approval: { ...part.approval, approved: true } }] }] });
  assert.equal(response.status, 200);
  await response.text();
  while ((await agent.inspect()).busy) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['http']);
  assert.equal((await agent.sessions.load(paused.session.id)).state, 'idle');

  assert.equal((await call('/api/steer', { sessionId: paused.session.id, text: 'hi' })).status, 400, 'nothing running');
  assert.equal((await call('/api/compact', { sessionId: paused.session.id })).status, 400, 'nothing old enough');
});

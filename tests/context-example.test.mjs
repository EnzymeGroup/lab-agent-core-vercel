import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAgent, modelFromEnv } from '../packages/core/dist/index.js';
import { createScientificContextPolicy } from '../examples/advanced/context-policy.ts';
import { createCsvHeadTool } from '../examples/advanced/python-arguments.ts';
import { startModelServer } from './fixtures/model-server.mjs';

test('native prepareStep retains stable rules and saved references when old complete turns are removed', async t => {
  const fixture = await startModelServer({ text: 'Deterministic context example verified.' });
  t.after(() => fixture.close());
  const notices = [];
  const policy = createScientificContextPolicy({ stableRules: 'SCIENTIFIC_RULE: preserve missingness; never invent measurements.', savedArtifacts: () => [{ path: 'runs/prior/output/intermediate.json', note: 'Saved arithmetic; read before relying on it.' }], maxContextChars: 800, onNearBudget: notice => notices.push(notice) });
  const messages = [{ role: 'user', content: 'OLD_TURN_PAYLOAD '.repeat(120) }, { role: 'assistant', content: 'Old response.' }, { role: 'user', content: 'Explain current source limits.' }];
  const before = JSON.stringify(messages);
  const agent = new ToolLoopAgent({ model: createOpenAI({ apiKey: 'local-fixture-only', baseURL: fixture.url }).chat('context-fixture'), instructions: 'STABLE_BASE_INSTRUCTIONS', prepareStep: policy, stopWhen: isStepCount(3) });
  assert.match((await agent.generate({ messages })).text, /context example verified/);
  const request = fixture.requests[0].body;
  const system = JSON.stringify(request.messages.filter(message => message.role === 'system' || message.role === 'developer'));
  assert.match(system, /STABLE_BASE_INSTRUCTIONS/);
  assert.match(system, /SCIENTIFIC_RULE/);
  assert.match(system, /runs\/prior\/output\/intermediate.json/);
  assert.match(system, /Context is near/);
  assert.doesNotMatch(JSON.stringify(request.messages), /OLD_TURN_PAYLOAD/);
  assert.equal(JSON.stringify(messages), before, 'durable input evidence is not mutated');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].droppedMessages, 2);
});

async function project(t, slow = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-native-python-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../examples/advanced/tools', import.meta.url), path.join(root, 'tools'), { recursive: true });
  await cp(new URL('../examples/advanced/data', import.meta.url), path.join(root, 'data'), { recursive: true });
  if (slow) await writeFile(path.join(root, 'tools/csv-arguments.py'), "import os,time\nfrom pathlib import Path\nPath(os.environ['AGENT_ROOT'],'started').write_text('yes')\ntime.sleep(60)\n");
  const fixture = await startModelServer({ plan: [{ name: 'csvHead', args: { input: 'data/input.csv', maxRows: 2 } }] });
  t.after(() => fixture.close());
  const native = createCsvHeadTool(root);
  const agent = await createAgent({ root, instructions: { text: 'Use the bounded CSV sample tool.' }, model: modelFromEnv({ LAB_AGENT_MODEL: 'native-python-fixture', LAB_AGENT_API_KEY: 'local-fixture-only', LAB_AGENT_BASE_URL: fixture.url }), tools: { csvHead: native }, provenance: { inputs: ['data/input.csv'], code: ['tools/csv-arguments.py'] }, limits: { maxSteps: 3, timeoutMs: 10_000 } });
  t.after(() => agent.close());
  return { root, agent, native };
}

test('native Tool + Zod dispatches validated Python argv and preserves empty CSV cells', async t => {
  const { agent, native } = await project(t);
  assert.throws(() => native.inputSchema.parse({ input: '../.env', maxRows: 2 }));
  assert.throws(() => native.inputSchema.parse({ input: 'data/input.csv', maxRows: 2000 }));
  const run = await agent.runTask('Save two raw CSV rows.');
  assert.equal(run.execution, 'completed');
  const sampled = JSON.parse(await readFile(path.join(run.directory, 'output/sample.json'), 'utf8'));
  assert.equal(sampled.sampled_rows, 2);
  assert.deepEqual(sampled.rows[1], ['sample-B', '', 'baseline']);
  await assert.rejects(native.execute({ input: 'data/input.csv', maxRows: 1 }, { toolCallId: 'outside-task', messages: [], context: {} }), /active Core task/);
});

test('native Python argument tool propagates AbortSignal to a real subprocess', async t => {
  const { root, agent } = await project(t, true);
  const pending = agent.runTask('Run the sample tool, then cancel.').catch(error => error.run);
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await readFile(path.join(root, 'started'), 'utf8').catch(() => '') === 'yes') break;
    if (Date.now() > deadline) throw new Error('Python tool did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(agent.cancel(), true);
  assert.equal((await pending).execution, 'aborted');
  assert.equal((await agent.inspect()).busy, false);
});

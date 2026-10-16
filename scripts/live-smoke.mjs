import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, defineAgent, modelFromEnv, modelInfo } from '../packages/core/dist/index.js';

// Explicit opt-in only. Never replace missing credentials with a fixture.
const model = modelFromEnv();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = fileURLToPath(new URL(`../.artifacts/live/${stamp}/`, import.meta.url));
await mkdir(destination, { recursive: true });
const results = { kind: 'live-provider-smoke', startedAt: new Date().toISOString(), model: modelInfo(model), cases: [],
  limits: 'Two example tasks on one configured model; no scientific discovery, quality parity, latency advantage or human usability claim.' };
try {
  for (const [name, script, task] of [
    ['sequence-summary', 'summarize', 'Load the sequence-summary Skill and run the registered summarize Python script on data/input.fasta. Produce its JSON and Markdown outputs, preserving source identifiers and sequences.'],
    ['table-quality', 'analyze', 'First call sourceEvidence to confirm the input source. Load the table-quality Skill, then run the registered analyze Python script on data/input.csv. Produce its JSON and Markdown outputs without imputing or relabeling missing values.'],
  ]) {
    const root = path.join(destination, name);
    await cp(new URL(`../examples/${name}/`, import.meta.url), root, { recursive: true,
      filter: file => !/(?:^|\/)(?:runs|node_modules|\.lab-agent|__pycache__)(?:\/|$)/u.test(file) });
    const tools = name === 'table-quality' ? { sourceEvidence: tool({ description: 'Read exact source CSV bytes for provenance; no imputation or inference.',
      inputSchema: z.object({}), execute: async (_input, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        return { path: 'data/input.csv', source: await readFile(path.join(root, 'data/input.csv'), 'utf8') };
      } }) } : undefined;
    const config = defineAgent({ root, model, tools, python: { scripts: { [script]: { path: `tools/${script === 'summarize' ? 'summarize' : 'analyze'}.py`, description: `Source-preserving ${name} analysis` } } },
      validation: { command: ['python3', 'tools/validate.py'] }, limits: { maxSteps: 12, timeoutMs: 180_000 } });
    const agent = await createAgent(config);
    try {
      const run = await agent.runTask(task);
      assert.equal(run.execution, 'completed'); assert.equal(run.delivery, 'passed');
      const history = await agent.sessions.load(run.session.id);
      const calls = history.messages.flatMap(message => message.parts).filter(part => part.type.startsWith('tool-') && part.state === 'output-available').map(part => part.type.slice(5));
      assert.ok(calls.includes('loadSkill'), `${name}: Skill was not used.`);
      assert.ok(calls.includes('runPython'), `${name}: registered Python was not used.`);
      if (tools) assert.ok(calls.includes('sourceEvidence'), 'Native extension tool was not used.');
      results.cases.push({ name, status: 'passed', runId: run.id, directory: run.directory, usage: run.usage, toolCalls: calls });
    } catch (error) {
      results.cases.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { await agent.close(); }
  }
  results.status = 'passed';
} catch (error) {
  results.status = 'failed';
  process.exitCode = 1;
  // SDK/provider messages may contain request data; detailed records stay in
  // the local ignored directory, and stdout only reports case status.
  process.stderr.write(`Live-provider smoke failed. Inspect ${destination}\n`);
} finally {
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(destination, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: results.status, cases: results.cases.map(({ name, status }) => ({ name, status })), report: path.join(destination, 'results.json') })}\n`);
}

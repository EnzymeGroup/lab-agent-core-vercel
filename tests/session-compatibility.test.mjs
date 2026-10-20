import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, SessionCompatibilityError } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';
import { fixtureModel } from './fixtures/project.mjs';

test('removed or changed native tool schemas yield actionable errors without rewriting session history', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-history-schema-'));
  const fixture = await startModelServer({ plan: [{ name: 'format', args: { value: 'source-text' } }] });
  const model = fixtureModel(fixture.url, 'history-fixture');
  t.after(async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const original = await createAgent({ root, model, tools: { format: tool({ inputSchema: z.object({ value: z.string() }), execute: ({ value }) => value.trim() }) } });
  const result = await original.chat('Use the format tool.');
  await original.close();
  const file = path.join(root, '.lab-agent/sessions', `${result.session.id}.json`);
  const bytes = await readFile(file);
  const requests = fixture.requests.length;
  for (const tools of [{}, { format: tool({ inputSchema: z.object({ value: z.number() }), execute: ({ value }) => value + 1 }) }]) {
    const current = await createAgent({ root, model, tools });
    try {
      await assert.rejects(current.runTask('Continue existing evidence.', { sessionId: result.session.id }), error => {
        assert.ok(error instanceof SessionCompatibilityError);
        assert.equal(error.sessionId, result.session.id);
        assert.ok(error.incompatibleTools.includes('format'));
        assert.match(error.message, /Restore compatible tool schemas or start a new session/);
        return true;
      });
      assert.deepEqual(await readFile(file), bytes);
      assert.equal((await current.runs.list()).runs.length, 0);
      assert.equal(fixture.requests.length, requests);
    } finally { await current.close(); }
  }
});

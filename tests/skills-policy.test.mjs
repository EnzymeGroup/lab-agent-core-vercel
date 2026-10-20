import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, createWorkspace, defineAgent, runWithExecutionContext } from '../packages/core/dist/index.js';
import { discoverSkills, loadSkill, snapshotSkills } from '../packages/core/dist/index.js';
import { createTools, pythonToolAllowed } from '../packages/core/dist/index.js';
import { startModelServer } from './fixtures/model-server.mjs';
import { fixtureModel } from './fixtures/project.mjs';

const options = { toolCallId: 'skills-policy-test', messages: [], context: {} };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const skillText = (name, body = 'Preserve measured evidence. 保留未知值。') => `---\nname: ${name}\ndescription: Inspect the original measurements.\n---\n${body}\n`;
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-skills-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, file, bytes) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}
async function fixtureAgent(t, root, plan, extra = {}) {
  const fixture = await startModelServer({ plan, text: 'Native fixture completed; inspect stored evidence.' });
  const model = fixtureModel(fixture.url, 'skills-policy-fixture');
  const agent = await createAgent({ root, model, ...extra });
  t.after(async () => { await agent.close(); await fixture.close(); });
  return { agent, fixture };
}

test('task-start Skill snapshots fingerprint exact canonical bytes and distinguish actual loading', async t => {
  const root = await temporary(t);
  const content = `\uFEFF${skillText('evidence')}`;
  const actual = await put(root, 'procedures/evidence.md', content);
  await mkdir(path.join(root, '.agents/skills/evidence'), { recursive: true });
  await symlink(actual, path.join(root, '.agents/skills/evidence/SKILL.md'));
  const workspace = await createWorkspace(root, { readRoots: ['data'] });
  const skills = await discoverSkills(workspace);
  const baselines = await snapshotSkills(workspace, skills);
  assert.deepEqual(baselines, [{ name: 'evidence', path: 'procedures/evidence.md', sha256: hash(Buffer.from(content)), bytes: Buffer.byteLength(content), loaded: false }]);
  const observed = [];
  await runWithExecutionContext({ mode: 'task', skillBaselines: baselines, onSkillLoad: async value => { observed.push({ ...value }); } }, async () => {
    const loaded = await loadSkill(workspace, skills, 'evidence');
    assert.ok(loaded.endsWith(content));
    assert.match(loaded, /Skill source \(project-relative\): "procedures\/evidence\.md"/);
    assert.match(loaded, /Skill directory \(project-relative\): "procedures"/);
    assert.match(loaded, /"references\/output\.md" means "procedures\/references\/output\.md"/);
    assert.equal(await loadSkill(workspace, skills, 'evidence'), loaded);
  });
  assert.equal(observed.length, 2);
  assert.equal(observed[0].loaded, true);
  assert.ok(Number.isFinite(Date.parse(observed[0].loadedAt)));
  assert.equal(observed[0].loadedAt, observed[1].loadedAt, 'Repeated loading retains the first actual-use time.');
  assert.equal(baselines[0].loaded, true);
});

test('mid-task Skill edits and canonical retargeting are refused before actual-use persistence', async t => {
  const root = await temporary(t);
  const content = skillText('evidence');
  const original = await put(root, 'procedures/original.md', content);
  const replacement = await put(root, 'procedures/replacement.md', content);
  const declared = path.join(root, '.agents/skills/evidence/SKILL.md');
  await mkdir(path.dirname(declared), { recursive: true });
  await symlink(original, declared);
  const workspace = await createWorkspace(root);
  const skills = await discoverSkills(workspace);
  const baselines = await snapshotSkills(workspace, skills);
  let loaded = 0;
  const context = { mode: 'task', skillBaselines: baselines, onSkillLoad: async () => { loaded++; } };
  await writeFile(original, `${content}MIDRUN_NEW_RULE\n`);
  await runWithExecutionContext(context, () => assert.rejects(loadSkill(workspace, skills, 'evidence'), /changed since task acceptance/));
  await writeFile(original, content);
  await rm(declared); await symlink(replacement, declared);
  await runWithExecutionContext(context, () => assert.rejects(loadSkill(workspace, skills, 'evidence'), /changed since task acceptance/));
  assert.equal(loaded, 0);
  assert.equal(baselines[0].loaded, false);
  await runWithExecutionContext({ mode: 'task', skillBaselines: [] }, () => assert.rejects(loadSkill(workspace, skills, 'evidence'), /no task-start fingerprint/));
});

test('Skill instructions do not return when durable actual-use recording fails', async t => {
  const root = await temporary(t);
  await put(root, '.agents/skills/evidence/SKILL.md', skillText('evidence'));
  const workspace = await createWorkspace(root);
  const skills = await discoverSkills(workspace);
  const baselines = await snapshotSkills(workspace, skills);
  await runWithExecutionContext({ mode: 'task', skillBaselines: baselines, onSkillLoad: async () => { throw new Error('durable storage unavailable'); } }, () =>
    assert.rejects(loadSkill(workspace, skills, 'evidence'), /durable storage unavailable/));
  assert.equal(baselines[0].loaded, false);
});

test('Python modes validate explicitly, default to both and allow an empty disabled selection', () => {
  const base = { root: '/tmp', model: 'openai:fixture' };
  for (const modes of [['unknown'], 'task', {}, [null]]) {
    assert.throws(() => defineAgent({ ...base, python: { scripts: { compute: { path: 'compute.py', description: 'compute', modes } } } }), /modes/);
  }
  const configured = modes => ({ ...base, python: { scripts: { compute: { path: 'compute.py', description: 'compute', ...(modes === undefined ? {} : { modes }) } } } });
  assert.equal(pythonToolAllowed(configured(undefined), 'chat'), true);
  assert.equal(pythonToolAllowed(configured(undefined), 'task'), true);
  assert.equal(pythonToolAllowed(configured(['task']), 'chat'), false);
  assert.equal(pythonToolAllowed(configured(['task']), 'task'), true);
  assert.equal(pythonToolAllowed(defineAgent(configured([])), 'task'), false);
  assert.equal(pythonToolAllowed(base, 'chat'), false);
});

test('named Python execution enforces context mode even when the caller supplies a forged mode argument', async t => {
  const root = await temporary(t);
  await put(root, 'compute.py', 'print("computed")\n');
  const workspace = await createWorkspace(root);
  const tools = createTools(workspace, { root, model: 'openai:fixture', python: { scripts: { compute: { path: 'compute.py', description: 'compute', modes: ['task'] } } } });
  await runWithExecutionContext({ mode: 'chat' }, () => assert.rejects(tools.runPython.execute({ script: 'compute', args: [], mode: 'task' }, options), /not allowed in chat/));
  const result = await runWithExecutionContext({ mode: 'task' }, () => tools.runPython.execute({ script: 'compute', args: [] }, options));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'computed\n');
});

test('Python result identifies the exact artifact base for tasks and the absence of a chat output directory', async t => {
  const root = await temporary(t);
  await put(root, 'compute.py', 'import os,json\nfrom pathlib import Path\noutput=os.getenv("AGENT_OUTPUT_DIR")\nif output: Path(output,"result.txt").write_text("computed")\nprint(json.dumps({"artifacts":["result.txt"] if output else []}))\n');
  const output = path.join(root, 'runs/context-test/output');
  await mkdir(output, { recursive: true });
  const workspace = await createWorkspace(root);
  const tools = createTools(workspace, { root, model: 'openai:fixture', python: { scripts: { compute: { path: 'compute.py', description: 'Return artifact basenames' } } } });
  const result = await runWithExecutionContext({ mode: 'task', runId: 'context-test', outputDirectory: output }, () => tools.runPython.execute({ script: 'compute', args: [] }, options));
  assert.equal(result.cwd, '.');
  assert.equal(result.outputDirectory, 'runs/context-test/output');
  assert.equal(result.code, 0);
  assert.equal(typeof result.stderr, 'string');
  assert.equal(typeof result.durationMs, 'number');
  const artifact = JSON.parse(result.stdout).artifacts[0];
  assert.equal(await workspace.read(`${result.outputDirectory}/${artifact}`), 'computed');
  const chat = await runWithExecutionContext({ mode: 'chat' }, () => tools.runPython.execute({ script: 'compute', args: [] }, options));
  assert.equal(chat.cwd, '.');
  assert.equal(chat.outputDirectory, null);
  assert.deepEqual(JSON.parse(chat.stdout).artifacts, []);
});

test('actual SDK task records loaded Skill identity and rechecks only used instructions', async t => {
  const root = await temporary(t);
  await put(root, '.agents/skills/evidence/SKILL.md', skillText('evidence', 'PINNED_INSTRUCTIONS_USED'));
  await put(root, '.agents/skills/unrelated/SKILL.md', skillText('unrelated', 'UNUSED_INSTRUCTIONS'));
  const { agent, fixture } = await fixtureAgent(t, root, [{ name: 'loadSkill', args: { name: 'evidence' } }]);
  const run = await agent.runTask('Load the registered evidence instructions.');
  const used = run.provenance.skills.find(value => value.name === 'evidence');
  const unused = run.provenance.skills.find(value => value.name === 'unrelated');
  assert.equal(used.loaded, true);
  assert.ok(Number.isFinite(Date.parse(used.loadedAt)));
  assert.equal(used.path, '.agents/skills/evidence/SKILL.md');
  assert.equal(used.sha256, hash(await readFile(path.join(root, used.path))));
  assert.equal(unused.loaded, false);
  assert.equal(unused.loadedAt, undefined);
  const history = (await agent.sessions.load(run.session.id)).messages;
  assert.match(JSON.stringify(history), /PINNED_INSTRUCTIONS_USED/);
  const loadedPart = history.flatMap(message => message.parts).find(part => part.type === 'tool-loadSkill' && part.state === 'output-available');
  assert.match(loadedPart.output, /Skill directory \(project-relative\): "\.agents\/skills\/evidence"/);
  assert.match(loadedPart.output, /\.agents\/skills\/evidence\/references\/output\.md/);
  const calls = fixture.requests.length;
  await put(root, unused.path, skillText('unrelated', 'Unused edit must not alter this task baseline.'));
  assert.equal((await agent.runs.check(run.id)).delivery, 'not_checked');
  await put(root, used.path, skillText('evidence', 'Changed used scientific procedure.'));
  const changed = await agent.runs.check(run.id);
  assert.equal(changed.delivery, 'failed');
  assert.match((await agent.runs.report(run.id)).issues.join(' '), /skill|SKILL\.md/i);
  assert.equal(fixture.requests.length, calls, 'Rechecks make no model calls.');
  assert.equal(changed.provenance.skills.find(value => value.name === 'evidence').sha256, used.sha256);
});

test('actual SDK refuses instructions edited by a tool after task acceptance', async t => {
  const root = await temporary(t);
  const file = await put(root, '.agents/skills/evidence/SKILL.md', skillText('evidence', 'Original frozen procedure.'));
  const { agent } = await fixtureAgent(t, root, [{ name: 'mutateSkill', args: {} }, { name: 'loadSkill', args: { name: 'evidence' } }], {
    tools: { mutateSkill: tool({ inputSchema: z.object({}), execute: async () => { await writeFile(file, skillText('evidence', 'MIDRUN_RULE_MUST_NOT_REACH_MODEL')); return 'Edited host fixture file.'; } }) },
  });
  const run = await agent.runTask('Attempt to change and then load a scientific procedure.');
  const history = JSON.stringify((await agent.sessions.load(run.session.id)).messages);
  assert.match(history, /changed since task acceptance/);
  assert.doesNotMatch(history, /MIDRUN_RULE_MUST_NOT_REACH_MODEL/);
  assert.equal(run.provenance.skills.find(value => value.name === 'evidence').loaded, false);
});

test('actual SDK generic readFile records registered Skill use and cannot bypass a later edit refusal', async t => {
  const root = await temporary(t);
  const original = skillText('evidence', 'ORIGINAL_RULE_LOADED_THROUGH_READFILE');
  const file = await put(root, '.agents/skills/evidence/SKILL.md', original);
  const { agent } = await fixtureAgent(t, root, [
    { name: 'readFile', args: { path: '.agents/skills/evidence/SKILL.md' } },
    { name: 'mutateSkill', args: {} },
    { name: 'readFile', args: { path: '.agents/skills/evidence/SKILL.md' } },
  ], { tools: { mutateSkill: tool({ inputSchema: z.object({}), execute: async () => {
    await writeFile(file, skillText('evidence', 'NEW_RULE_CANNOT_BYPASS_USING_READFILE'));
    return 'Edited fixture instructions.';
  } }) } });
  const run = await agent.runTask('Read the registered procedure through a generic file tool, then attempt a changed read.');
  const messages = (await agent.sessions.load(run.session.id)).messages;
  const readPart = messages.flatMap(message => message.parts).find(part => part.type === 'tool-readFile' && part.state === 'output-available');
  assert.equal(readPart.output, original, 'Generic readFile preserves the exact raw source text.');
  const history = JSON.stringify(messages);
  assert.match(history, /ORIGINAL_RULE_LOADED_THROUGH_READFILE/);
  assert.match(history, /changed since task acceptance/);
  assert.doesNotMatch(history, /NEW_RULE_CANNOT_BYPASS_USING_READFILE/);
  assert.equal(run.provenance.skills.find(value => value.name === 'evidence').loaded, true);
  assert.equal(run.delivery, 'failed', 'Changing a used Skill remains visible to independent delivery checking.');
});

test('actual SDK hides task-only Python in chat and executes it in tasks', async t => {
  const root = await temporary(t);
  await put(root, 'compute.py', 'import os\nfrom pathlib import Path\nPath(os.environ["AGENT_ROOT"],"python-started").write_text("started")\nPath(os.environ["AGENT_OUTPUT_DIR"],"result.txt").write_text("computed")\nprint("computed")\n');
  const { agent, fixture } = await fixtureAgent(t, root, [{ name: 'runPython', args: { script: 'compute', args: [] } }], {
    python: { scripts: { compute: { path: 'compute.py', description: 'Task-only computation', modes: ['task'] } } },
  });
  try { await agent.chat('A malicious provider response requests task-only computation.'); }
  catch (error) { assert.match(error.message, /tool|allowed|Python/i); }
  await assert.rejects(readFile(path.join(root, 'python-started')), { code: 'ENOENT' });
  assert.ok(fixture.requests.length > 0);
  assert.ok(fixture.requests.every(request => !(request.body.tools ?? []).some(value => value.function?.name === 'runPython')));
  const run = await agent.runTask('Perform the task-only computation.');
  assert.equal(run.execution, 'completed');
  assert.equal(await readFile(path.join(run.directory, 'output/result.txt'), 'utf8'), 'computed');
  const python = (await agent.sessions.load(run.session.id)).messages.flatMap(message => message.parts).find(part => part.type === 'tool-runPython' && part.state === 'output-available');
  assert.equal(python.output.cwd, '.');
  assert.equal(python.output.outputDirectory, `runs/${run.id}/output`);
  assert.ok(fixture.requests.some(request => (request.body.tools ?? []).some(value => value.function?.name === 'runPython')));
});

test('actual SDK blocks a task-only script while another registered Python script is allowed in chat', async t => {
  const root = await temporary(t);
  await put(root, 'compute.py', 'from pathlib import Path\nPath("forbidden-chat-side-effect").write_text("bad")\n');
  await put(root, 'inspect.py', 'print("read-only host inspection")\n');
  const { agent, fixture } = await fixtureAgent(t, root, [{ name: 'runPython', args: { script: 'compute', args: [] } }], {
    python: { scripts: { compute: { path: 'compute.py', description: 'Task-only', modes: ['task'] }, inspect: { path: 'inspect.py', description: 'Chat inspection', modes: ['chat'] } } },
  });
  const result = await agent.chat('Provider requests a forbidden script from an otherwise available Python tool.');
  assert.ok(fixture.requests.some(request => (request.body.tools ?? []).some(value => value.function?.name === 'runPython')));
  await assert.rejects(readFile(path.join(root, 'forbidden-chat-side-effect')), { code: 'ENOENT' });
  assert.match(JSON.stringify(result.session.messages), /not allowed in chat/);
});

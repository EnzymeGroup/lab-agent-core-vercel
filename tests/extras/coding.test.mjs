import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, runWithExecutionContext } from '../../packages/core/dist/index.js';
import { codingTools, lineDiff } from '../../packages/extras/dist/coding.js';
import { startModelServer } from '../fixtures/model-server.mjs';
import { callTool, copyExample, fixtureModel } from '../fixtures/project.mjs';

// lab-agent-extras/coding. The shell tests run real commands in a real bubblewrap sandbox
// and are skipped where bwrap is missing. Not live model inference.
const run = promisify(execFile);
const hasBwrap = (() => { try { execFileSync('bwrap', ['--version']); return true; } catch { return false; } })();

const call = callTool;

async function project(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lab-agent-extras-coding-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/app.js'), 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  await writeFile(path.join(root, 'README.md'), '# demo\n');
  const runId = 'run-coding';
  const outputDirectory = path.join(root, 'runs', runId, 'output');
  await mkdir(outputDirectory, { recursive: true });
  return { root, inTask: work => runWithExecutionContext({ runId, outputDirectory }, work) };
}

const development = { mode: 'development', writeRoots: ['src'] };

test('changing tools ask for approval themselves; git tools do not', () => {
  const tools = codingTools({ root: tmpdir() });
  assert.deepEqual(Object.keys(tools).sort(), ['editFile', 'gitDiff', 'gitStatus', 'shell', 'undoEdit']);
  for (const name of ['editFile', 'undoEdit', 'shell']) assert.equal(tools[name].needsApproval, true, name);
  for (const name of ['gitDiff', 'gitStatus']) assert.equal(tools[name].needsApproval, undefined, name);
  assert.deepEqual(Object.keys(codingTools({ root: tmpdir(), shell: false, git: false })).sort(), ['editFile', 'undoEdit']);
  assert.throws(() => codingTools({ root: tmpdir(), shell: { hide: ['relative/path'] } }), /absolute/);
});

test('lineDiff shows one hunk with context', () => {
  assert.equal(lineDiff('a\nb\nc\nd\n', 'a\nb\nX\nd\n', 1), '@@ -2 +2 @@\n b\n-c\n+X\n d');
});

test('editFile: exact, unique replacements through the write policy', async t => {
  const { root, inTask } = await project(t);
  const tools = codingTools({ root, fileAccess: development, shell: false });
  const edited = await inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const a = 1;', newText: 'const a = 10;' }));
  assert.deepEqual([edited.replacements, edited.created], [1, false]);
  assert.match(edited.diff, /-const a = 1;\n\+const a = 10;/);
  assert.equal(await readFile(path.join(root, 'src/app.js'), 'utf8'), 'const a = 10;\nconst b = 2;\nexport { a, b };\n');

  await assert.rejects(inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const c', newText: 'x' })), /was not found/);
  await assert.rejects(inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const', newText: 'let' })), /appears 2 times/);
  assert.equal((await inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const', newText: 'let', replaceAll: true }))).replacements, 2);
  await assert.rejects(inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'let a', newText: 'let a' })), /changes nothing/);

  const created = await inTask(() => call(tools, 'editFile', { path: 'src/new.js', oldText: '', newText: 'export const n = 1;\n' }));
  assert.equal(created.created, true);
  await assert.rejects(inTask(() => call(tools, 'editFile', { path: 'src/new.js', oldText: '', newText: 'x' })), /exists/);

  await assert.rejects(inTask(() => call(tools, 'editFile', { path: 'README.md', oldText: '# demo', newText: '# hacked' })), /Write denied/, 'outside writeRoots');
  await assert.rejects(call(tools, 'editFile', { path: 'src/app.js', oldText: 'let a', newText: 'let z' }), /active task/, 'chat has no write access');
  await assert.rejects(inTask(() => call(tools, 'editFile', { path: '.env', oldText: '', newText: 'X=1' })));
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# demo\n');

  // Analysis mode still allows the task output directory.
  const analysis = codingTools({ root, shell: false });
  assert.equal((await inTask(() => call(analysis, 'editFile', { path: 'runs/run-coding/output/notes.md', oldText: '', newText: 'n' }))).created, true);
});

test('undoEdit restores newest first, deletes created files and refuses changed ones', async t => {
  const { root, inTask } = await project(t);
  const tools = codingTools({ root, fileAccess: development, shell: false });
  const file = path.join(root, 'src/app.js');
  const original = await readFile(file, 'utf8');
  await inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const a = 1;', newText: 'const a = 2;' }));
  await inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const b = 2;', newText: 'const b = 3;' }));
  await inTask(() => call(tools, 'editFile', { path: 'src/extra.js', oldText: '', newText: 'x\n' }));

  const first = await inTask(() => call(tools, 'undoEdit', {}));
  assert.equal(first.undone[0].deleted, true);
  await assert.rejects(access(path.join(root, 'src/extra.js')));
  const two = await inTask(() => call(tools, 'undoEdit', { count: 2 }));
  assert.equal(two.undone.length, 2);
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(inTask(() => call(tools, 'undoEdit', {})), /nothing to undo/);

  await inTask(() => call(tools, 'editFile', { path: 'src/app.js', oldText: 'const a = 1;', newText: 'const a = 5;' }));
  await writeFile(file, 'changed by someone else\n');
  await assert.rejects(inTask(() => call(tools, 'undoEdit', {})), /changed after edit/);
  assert.equal(await readFile(file, 'utf8'), 'changed by someone else\n', 'a later change is never overwritten');
});

test('parallel edits to one file are applied one after another', async t => {
  const { root, inTask } = await project(t);
  const tools = codingTools({ root, fileAccess: development, shell: false });
  await inTask(() => Promise.all([
    call(tools, 'editFile', { path: 'src/app.js', oldText: 'const a = 1;', newText: 'const a = 100;' }),
    call(tools, 'editFile', { path: 'src/app.js', oldText: 'const b = 2;', newText: 'const b = 200;' }),
  ]));
  assert.equal(await readFile(path.join(root, 'src/app.js'), 'utf8'), 'const a = 100;\nconst b = 200;\nexport { a, b };\n');
});

test('gitStatus and gitDiff are read-only, leave secrets out and never run diff programs', async t => {
  const { root } = await project(t);
  const git = (...args) => run('git', ['-c', 'user.email=fixture@example.org', '-c', 'user.name=fixture', ...args], { cwd: root });
  await writeFile(path.join(root, '.env'), 'TOKEN=old\n');
  await writeFile(path.join(root, 'notes.txt'), 'one\n');
  await writeFile(path.join(root, '.gitattributes'), '*.txt diff=evil\n');
  await git('init', '-q');
  await git('config', 'diff.evil.textconv', `sh -c 'touch ${path.join(root, 'TEXTCONV-RAN')}; cat "$0"'`);
  await git('add', '-A');
  await git('commit', '-qm', 'init');
  await writeFile(path.join(root, 'src/app.js'), 'const a = 2;\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=new-secret\n');
  await writeFile(path.join(root, 'notes.txt'), 'two\n');

  const tools = codingTools({ root, shell: false });
  const status = await call(tools, 'gitStatus', {});
  assert.match(status.branch, /^(main|master)/);
  assert.ok(status.changes.some(line => line.endsWith('src/app.js')));
  assert.ok(!status.changes.some(line => line.includes('.env')));

  const diff = await call(tools, 'gitDiff', {});
  assert.match(diff.diff, /\+const a = 2;/);
  assert.match(diff.diff, /\+two/);
  assert.doesNotMatch(diff.diff, /new-secret/);
  await assert.rejects(access(path.join(root, 'TEXTCONV-RAN')), 'textconv never runs');
  assert.match((await call(tools, 'gitDiff', { path: 'src/app.js' })).diff, /src\/app\.js/);
  await assert.rejects(call(tools, 'gitDiff', { path: '.env' }));
  assert.equal((await call(tools, 'gitDiff', { staged: true })).note, 'No changes.');
});

test('shell sandbox: project writable; system, home, secrets, .lab-agent and runs protected', { skip: !hasBwrap && 'bwrap is not installed' }, async t => {
  const { root } = await project(t);
  await writeFile(path.join(root, '.env'), 'TOKEN=secret-value\n');
  await mkdir(path.join(root, '.lab-agent/sessions'), { recursive: true });
  await writeFile(path.join(root, '.lab-agent/sessions/s.json'), '{}');
  await mkdir(path.join(root, 'secrets'));
  await writeFile(path.join(root, 'secrets/key.txt'), 'k');
  // Names only Core's rule used to cover; the sandbox now uses the same rule.
  await writeFile(path.join(root, '.npmrc'), '//registry/:_authToken=npm-secret\n');
  await writeFile(path.join(root, '.git-credentials'), 'https://user:pw@example.org\n');
  await mkdir(path.join(root, 'keys'));
  await writeFile(path.join(root, 'keys/deploy.txt'), 'k');
  process.env.PARENT_SECRET = 'leak';
  t.after(() => { delete process.env.PARENT_SECRET; });
  const tools = codingTools({ root, shell: {} });
  const sh = command => call(tools, 'shell', { command, timeoutSeconds: 20 });

  const basics = await sh('pwd; echo "home=$(ls -A "$HOME" | wc -l)"; touch built.txt && echo wrote; touch /usr/lab-agent-x 2>/dev/null || echo system-read-only');
  assert.equal(basics.exitCode, 0, basics.stderr);
  assert.deepEqual(basics.stdout.trim().split('\n'), [root, 'home=0', 'wrote', 'system-read-only']);
  await access(path.join(root, 'built.txt'));

  const secrets = await sh('echo "env=[$(cat .env)]"; echo overwrite > .env; echo "lab=$(ls -A .lab-agent | wc -l)"; echo "dir=$(ls -A secrets | wc -l)"; touch runs/x 2>/dev/null || echo runs-read-only; echo "var=[$PARENT_SECRET]"');
  assert.deepEqual(secrets.stdout.trim().split('\n'), ['env=[]', 'lab=0', 'dir=0', 'runs-read-only', 'var=[]']);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'TOKEN=secret-value\n', 'the real file is untouched');
  const more = await sh('echo "npmrc=[$(cat .npmrc)]"; echo "cred=[$(cat .git-credentials)]"; echo "keys=$(ls -A keys | wc -l)"');
  assert.deepEqual(more.stdout.trim().split('\n'), ['npmrc=[]', 'cred=[]', 'keys=0']);
  assert.equal(await readFile(path.join(root, '.lab-agent/sessions/s.json'), 'utf8'), '{}');

  const failed = await sh('echo to-stderr >&2; exit 3');
  assert.deepEqual([failed.exitCode, failed.stderr.trim(), failed.sandbox], [3, 'to-stderr', 'bwrap']);
  const slow = await call(tools, 'shell', { command: 'sleep 30', timeoutSeconds: 1 });
  assert.deepEqual([slow.exitCode, slow.timedOut], [null, true]);
  const long = await sh('seq 1 20000');
  assert.match(long.stdout, /earlier characters\]\n[\s\S]*\n20000\n?$/);
});

test('shell sandbox: no network by default; network: true allows it', { skip: !hasBwrap && 'bwrap is not installed' }, async t => {
  const { root } = await project(t);
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const probe = `(exec 3<>/dev/tcp/127.0.0.1/${server.address().port}) 2>/dev/null && echo open || echo closed`;
  assert.equal((await call(codingTools({ root }), 'shell', { command: probe })).stdout.trim(), 'closed');
  assert.equal((await call(codingTools({ root, shell: { network: true } }), 'shell', { command: probe })).stdout.trim(), 'open');
});

test('sandbox "none" still clears the environment', async t => {
  const { root } = await project(t);
  process.env.LAB_AGENT_PARENT_SECRET = 'leak';
  t.after(() => { delete process.env.LAB_AGENT_PARENT_SECRET; });
  const tools = codingTools({ root, shell: { sandbox: 'none', env: { GIVEN: 'yes' } } });
  const result = await call(tools, 'shell', { command: 'echo "[$LAB_AGENT_PARENT_SECRET][$GIVEN]"; pwd' });
  assert.deepEqual([result.stdout.trim(), result.sandbox], [`[][yes]\n${root}`, 'none']);
});

test('inside Core, shell pauses for approval without being listed in approval', { skip: !hasBwrap && 'bwrap is not installed' }, async t => {
  const root = await copyExample('lab-agent-extras-coding-agent-');
  const fixture = await startModelServer({ plan: [{ name: 'shell', args: { command: 'echo hi > hello.txt' } }] });
  const model = fixtureModel(fixture.url);
  const agent = await createAgent({ root, model, tools: codingTools({ root }), subagents: { scout: { description: 'x', instructions: 'y' } } });
  t.after(async () => { await agent.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });

  const state = await agent.inspect();
  const scout = state.subagents.find(item => item.name === 'scout');
  assert.ok(['editFile', 'undoEdit', 'shell'].every(name => !scout.tools.includes(name)), 'helpers never get changing tools');
  assert.ok(scout.tools.includes('gitDiff'));
  const paused = await agent.chat('[chat-only] make a file');
  assert.equal(paused.session.state, 'awaiting_approval');
  await assert.rejects(access(path.join(root, 'hello.txt')));
  await agent.approve(paused.session.id, true);
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hi\n');
});

import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { modelFromEnv, modelInfo } from '../packages/core/dist/index.js';
import { runCommand } from '../packages/core/dist/index.js';
import { createWorkspace, getExecutionContext, runWithExecutionContext } from '../packages/core/dist/index.js';
import { discoverSkills, loadSkill } from '../packages/core/dist/index.js';
import { connectMcp } from '../packages/core/dist/index.js';
import { createTools } from '../packages/core/dist/index.js';

const options = { toolCallId: 'test-call', messages: [], context: {} };
const configFor = (root, extra = {}) => ({ root, model: 'openai:test-model', ...extra });
const invoke = (tools, name, input, extra = {}) => tools[name].execute(input, { ...options, ...extra });
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function eventually(callback, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await callback(); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

test('model configuration fails explicitly without selecting an undocumented fallback', () => {
  assert.throws(() => modelFromEnv({}), /LAB_AGENT_MODEL/);
  assert.throws(() => modelFromEnv({ LAB_AGENT_MODEL: 'x' }), /API key/);
  assert.throws(() => modelFromEnv({ LAB_AGENT_PROVIDER: 'other', LAB_AGENT_MODEL: 'x', LAB_AGENT_API_KEY: 'secret' }), /Unsupported/);
  assert.throws(() => modelFromEnv({ LAB_AGENT_MODEL: 'x', LAB_AGENT_API_KEY: 'secret', LAB_AGENT_BASE_URL: 'https://user:password@example.com' }), /without credentials/);
  const model = modelFromEnv({ LAB_AGENT_PROVIDER: 'anthropic', LAB_AGENT_MODEL: 'claude-test', LAB_AGENT_API_KEY: 'secret' });
  assert.deepEqual(modelInfo(model), { provider: 'anthropic.messages', id: 'claude-test' });
  assert.equal(JSON.stringify(modelInfo(model)).includes('secret'), false);
});

test('native provider registry sends OpenAI-compatible traffic to Chat Completions', async t => {
  let request;
  const base = await listen(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    request = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'local-test', choices: [{ index: 0, message: { role: 'assistant', content: 'native result' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  const model = modelFromEnv({ LAB_AGENT_MODEL: 'local-test', LAB_AGENT_API_KEY: 'fixture-key', LAB_AGENT_BASE_URL: `${base}/v1` });
  const result = await generateText({ model, prompt: 'Test native provider', maxRetries: 0 });
  assert.equal(result.text, 'native result');
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.authorization, 'Bearer fixture-key');
  assert.equal(request.body.model, 'local-test');
});

test('canonical workspace confines existing and missing paths through symlinks', async t => {
  const root = await temporary(t);
  const outside = await temporary(t);
  const workspace = await createWorkspace(root, { mode: 'development', writeRoots: ['.'] });
  await writeFile(path.join(outside, 'private.txt'), 'outside');
  await symlink(outside, path.join(root, 'external'));
  await assert.rejects(workspace.read('../private.txt'), /escapes/);
  await assert.rejects(workspace.read('external/private.txt'), /escapes/);
  await assert.rejects(workspace.write('external/new/sub.txt', 'bad'), /escapes/);
  await assert.rejects(workspace.resolve(`${root}-sibling/new.txt`), /escapes/);
  await mkdir(path.join(root, 'real'));
  await symlink(path.join(root, 'real'), path.join(root, 'inside'));
  await runWithExecutionContext({ runId: 'current', outputDirectory: path.join(root, 'runs/current/output') }, () => workspace.write('inside/sub/data.txt', 'inside'));
  assert.equal(await workspace.read('real/sub/data.txt'), 'inside');
  assert.deepEqual((await workspace.list('real/sub')).map(entry => entry.type), ['file']);
});

test('file tools protect metadata through aliases and allow output artifacts only', async t => {
  const root = await temporary(t);
  const workspace = await createWorkspace(root);
  await mkdir(path.join(root, '.lab-agent'), { recursive: true });
  await symlink(path.join(root, '.lab-agent'), path.join(root, 'alias'));
  await assert.rejects(workspace.write('.lab-agent/sessions/session.json', '{}'), /metadata/);
  await assert.rejects(workspace.write('alias/operation.lock', '{}'), /metadata/);
  await writeFile(path.join(root, '.lab-agent/private.json'), 'original');
  await link(path.join(root, '.lab-agent/private.json'), path.join(root, 'hardlink.json'));
  await assert.rejects(workspace.write('hardlink.json', 'bad'), /hard-linked/i);
  assert.equal(await readFile(path.join(root, '.lab-agent/private.json'), 'utf8'), 'original');
  for (const file of ['runs/run-1/run.json', 'runs/run-1/check.json', 'runs/run-1/output', 'runs/run-1/validation.log']) {
    await assert.rejects(workspace.write(file, 'bad'), /metadata|output|active task/);
  }
  await runWithExecutionContext({ runId: 'run-1', outputDirectory: path.join(root, 'runs/run-1/output') }, () => workspace.write('runs/run-1/output/report.txt', 'artifact'));
  assert.equal(await workspace.read('runs/run-1/output/report.txt'), 'artifact');
  assert.equal(await workspace.resolve('.lab-agent/state.json', { write: true, internal: true }), path.join(root, '.lab-agent/state.json'));
});

test('workspace and native file tools reject oversized output without truncation', async t => {
  const root = await temporary(t);
  const workspace = await createWorkspace(root);
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(1025));
  const tools = createTools(workspace, configFor(root, { limits: { maxToolOutputBytes: 1024 } }));
  await assert.rejects(invoke(tools, 'readFile', { path: 'large.txt' }), /exceeds/);
  await assert.rejects(invoke(tools, 'writeFile', { path: 'large-new.txt', content: 'x'.repeat(1025) }), /exceeded/);
  await assert.rejects(workspace.read('.', 1024), /regular files/);
});

test('commands preserve argv, merged environment, both streams and nonzero exits', async t => {
  const root = await temporary(t);
  const literal = '$(touch SHOULD_NOT_EXIST); echo hello';
  const result = await runCommand(process.execPath, ['-e', 'console.log(JSON.stringify({arg:process.argv[1],value:process.env.LAB_TEST_VALUE,path:!!process.env.PATH}));console.error("stderr");process.exit(7)', literal], { cwd: root, env: { LAB_TEST_VALUE: 'merged' } });
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(result.stdout), { arg: literal, value: 'merged', path: true });
  assert.equal(result.stderr, 'stderr\n');
  assert.ok(result.durationMs >= 0);
  await assert.rejects(readFile(path.join(root, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
  await assert.rejects(runCommand('lab-agent-nonexistent-executable', [], { cwd: root }), { code: 'ENOENT' });
});

test('command abort, timeout and output ceilings terminate process groups and remove abort listeners', async t => {
  const root = await temporary(t);
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  const running = runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { cwd: root, signal: controller.signal });
  setTimeout(() => controller.abort(), 75);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 100 }), { name: 'CommandTimeoutError' });
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000));setInterval(()=>{},1000)'], { cwd: root, maxOutputBytes: 1000 }), { name: 'OutputLimitError' });
  const done = new AbortController();
  done.abort();
  await assert.rejects(runCommand(process.execPath, [], { cwd: root, signal: done.signal }), { name: 'AbortError' });
});

test('completed command cannot leave a detached background descendant running', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  const pidFile = path.join(root, 'child.pid');
  const childScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const script = `const {spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});fs.writeFileSync(process.argv[1],String(p.pid));p.unref()`;
  assert.equal((await runCommand(process.execPath, ['-e', script, pidFile], { cwd: root })).code, 0);
  const pid = Number(await readFile(pidFile, 'utf8'));
  await eventually(async () => {
    try {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8');
      assert.match(status, /\) [ZX] /, `Descendant ${pid} is still running`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
});

test('command limit failures retain bounded partial diagnostics for validation logs', async t => {
  const root = await temporary(t);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000));setInterval(()=>{},1000)'], { cwd: root, maxOutputBytes: 1000 }), error => {
    assert.equal(error.name, 'OutputLimitError');
    assert.equal(Buffer.byteLength(error.stdout), 1000);
    assert.equal(error.stderr, '');
    assert.ok(error.durationMs >= 0);
    return true;
  });
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("checker diagnostic");setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 250 }), error => {
    assert.equal(error.name, 'CommandTimeoutError');
    assert.match(error.stderr, /checker diagnostic/);
    return true;
  });
});

test('skills expose frontmatter progressively and load registered instructions on demand', async t => {
  const root = await temporary(t);
  const workspace = await createWorkspace(root);
  assert.deepEqual(await discoverSkills(workspace), []);
  const skillDir = path.join(root, '.agents/skills/analysis');
  await mkdir(skillDir, { recursive: true });
  const body = '---\nname: analysis\ndescription: |\n  Inspect measured evidence.\n---\n# Private full instructions\nUse the registered script.\n';
  await writeFile(path.join(skillDir, 'SKILL.md'), body);
  const skills = await discoverSkills(workspace);
  assert.equal(skills[0].description, 'Inspect measured evidence.');
  assert.equal(JSON.stringify(skills).includes('Private full'), false);
  const loaded = await loadSkill(workspace, skills, 'analysis');
  assert.ok(loaded.endsWith(body));
  assert.match(loaded, /Skill directory \(project-relative\): "\.agents\/skills\/analysis"/);
  await assert.rejects(loadSkill(workspace, skills, '../analysis'), /Unknown skill/);
  await mkdir(path.join(root, '.agents/skills/copy'));
  await writeFile(path.join(root, '.agents/skills/copy/SKILL.md'), body);
  await assert.rejects(discoverSkills(workspace), /Duplicate skill name/);
});

test('malformed YAML and skill symlink escapes fail during discovery', async t => {
  const root = await temporary(t);
  const outside = await temporary(t);
  const workspace = await createWorkspace(root);
  await mkdir(path.join(root, '.agents/skills/invalid'), { recursive: true });
  await writeFile(path.join(root, '.agents/skills/invalid/SKILL.md'), '---\nname: duplicate\nname: duplicate\ndescription: test\n---\nbody');
  await assert.rejects(discoverSkills(workspace), /unique|already|duplicat/i);
  await rm(path.join(root, '.agents/skills/invalid'), { recursive: true });
  await writeFile(path.join(outside, 'SKILL.md'), '---\nname: outside\ndescription: test\n---\nbody');
  await symlink(outside, path.join(root, '.agents/skills/outside'));
  assert.deepEqual(await discoverSkills(workspace), []);
});

test('registered Python receives active output context and literal argv; arbitrary programs are unavailable', async t => {
  const root = await temporary(t);
  const workspace = await createWorkspace(root);
  const outputDirectory = path.join(root, 'runs/run-test/output');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(root, 'analyze.py'), 'import os,sys,json\nfrom pathlib import Path\nPath(os.environ["AGENT_OUTPUT_DIR"],"result.txt").write_text("measured")\nprint(json.dumps({"args":sys.argv[1:],"root":os.environ["AGENT_ROOT"],"run":os.environ["AGENT_RUN_ID"],"runDir":os.environ["AGENT_RUN_DIR"]}))\n');
  const tools = createTools(workspace, configFor(root, { python: { command: 'python3', args: ['-u'], scripts: { analyze: { path: 'analyze.py', description: 'Analyze local data' } } } }));
  assert.equal(Object.hasOwn(tools, 'shell'), false);
  const result = await runWithExecutionContext({ outputDirectory, runId: 'run-test' }, () => invoke(tools, 'runPython', { script: 'analyze', args: ['$(touch bad)', '--input=x y'] }));
  assert.equal(result.code, 0);
  assert.equal(result.cwd, '.');
  assert.equal(result.outputDirectory, 'runs/run-test/output');
  assert.deepEqual(JSON.parse(result.stdout), { args: ['$(touch bad)', '--input=x y'], root, run: 'run-test', runDir: path.dirname(outputDirectory) });
  assert.equal(await readFile(path.join(outputDirectory, 'result.txt'), 'utf8'), 'measured');
  assert.equal(getExecutionContext(), undefined);
  await assert.rejects(invoke(tools, 'runPython', { script: '../../arbitrary.py', args: [] }), /Unknown Python/);
});

test('native external tools preserve metadata, cancellation, context and output limits', async t => {
  const root = await temporary(t);
  const workspace = await createWorkspace(root);
  let seenSignal;
  const native = tool({ description: 'custom native tool', inputSchema: z.object({}), execute: async (_input, { abortSignal }) => { seenSignal = abortSignal; await Promise.resolve(); return getExecutionContext().runId; } });
  const streamed = tool({ description: 'streamed', inputSchema: z.object({}), execute: async function* () { await Promise.resolve(); yield getExecutionContext().runId; } });
  const large = tool({ inputSchema: z.object({}), execute: () => 'x'.repeat(1025) });
  const tools = createTools(workspace, configFor(root, { tools: { custom: native, streamed, large }, limits: { maxToolOutputBytes: 1024 } }));
  const controller = new AbortController();
  const result = await runWithExecutionContext({ runId: 'run-context', signal: controller.signal }, () => invoke(tools, 'custom', {}));
  assert.equal(result, 'run-context');
  assert.equal(seenSignal, controller.signal);
  assert.equal(tools.custom.description, native.description);
  const iterator = runWithExecutionContext({ runId: 'run-stream' }, () => invoke(tools, 'streamed', {}));
  const values = [];
  for await (const value of iterator) values.push(value);
  assert.deepEqual(values, ['run-stream']);
  await assert.rejects(invoke(tools, 'large', {}), /exceeded/);
  controller.abort();
  assert.throws(() => invoke(tools, 'custom', {}, { abortSignal: controller.signal }), { name: 'AbortError' });
  assert.throws(() => createTools(workspace, configFor(root, { tools: { readFile: native } })), /Duplicate tool/);
  assert.throws(() => createTools(workspace, configFor(root), [], { readFile: native }), /Duplicate tool/);
});

function stdioServerSource() {
  return `import readline from 'node:readline';
import fs from 'node:fs';
process.on('SIGTERM',()=>{if(process.env.MCP_STOP_FILE)fs.writeFileSync(process.env.MCP_STOP_FILE,'closed');process.exit(0)});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'tiny-real-stdio',version:'1.0.0'}};
else if(m.method==='tools/list')result={tools:(process.env.MCP_NAMES||'echo').split(',').map(name=>({name,description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}))};
else if(m.method==='tools/call')result={content:[{type:'text',text:m.params.arguments.text}]};
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}})+'\\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
`;
}

test('native stdio MCP executes namespaced tools and close releases its process', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'mcp.mjs');
  const stopped = path.join(root, 'stopped');
  await writeFile(source, stdioServerSource());
  const connection = await connectMcp({ local: { transport: 'stdio', command: process.execPath, args: ['mcp.mjs'], env: { MCP_STOP_FILE: stopped } } }, { cwd: root });
  t.after(() => connection.close());
  assert.deepEqual(Object.keys(connection.tools), ['mcp_local_echo']);
  const result = await invoke(connection.tools, 'mcp_local_echo', { text: 'real stdio request' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'real stdio request' }]);
  await connection.close();
  await connection.close();
  await eventually(async () => assert.equal(await readFile(stopped, 'utf8'), 'closed'));
});

test('MCP startup ambiguity closes already connected servers', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'mcp.mjs');
  const stopped = path.join(root, 'stopped');
  await writeFile(source, stdioServerSource());
  await assert.rejects(async () => {
    const connection = await connectMcp({ first: { transport: 'stdio', command: process.execPath, args: [source], env: { MCP_STOP_FILE: stopped, MCP_NAMES: 'a.b,a_b' } } });
    await connection.close();
  }, /Ambiguous/);
  await eventually(async () => assert.equal(await readFile(stopped, 'utf8'), 'closed'));
  await assert.rejects(connectMcp({ invalid: { transport: 'http', url: 'file:///tmp/mcp' } }), /HTTP/);
});

test('native HTTP MCP discovers and executes real JSON-RPC tool calls', async t => {
  const methods = [];
  const base = await listen(t, async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    methods.push(message.method);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tiny-real-http', version: '1.0.0' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.text }] };
    const response = result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  const connection = await connectMcp({ remote: { transport: 'http', url: `${base}/mcp` } });
  t.after(() => connection.close());
  const result = await invoke(connection.tools, 'mcp_remote_echo', { text: 'real HTTP request' });
  assert.equal(result.content[0].text, 'real HTTP request');
  assert.ok(methods.includes('initialize'));
  assert.ok(methods.includes('tools/list'));
  assert.ok(methods.includes('tools/call'));
  await connection.close();
});

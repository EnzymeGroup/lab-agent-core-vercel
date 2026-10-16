/** Explicit credential-backed external consumer trial. Source CSV bytes are
 * copied unchanged; this audits data preservation, not biological validity. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { source: { type: 'string' }, 'env-file': { type: 'string', default: path.join(repository, '.env') }, package: { type: 'string' }, output: { type: 'string' } } });
if (!values.source || !values.package) throw new Error('Usage: node scripts/validate-installed-live.mjs --source ORIGINAL.csv --package CURRENT.tgz [--env-file FILE] [--output DIRECTORY]');
const source = path.resolve(values.source); const tarball = path.resolve(values.package); const envFile = path.resolve(values['env-file']);
const directory = path.resolve(values.output ?? path.join(repository, '.artifacts/installed-live', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(directory, { recursive: true });
const project = await mkdtemp(path.join(tmpdir(), 'lab-agent-real-proteingym-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(source); const originalHash = digest(original);
await cp(path.join(repository, 'examples/table-quality'), project, { recursive: true,
  filter: file => !/(?:^|\/)(?:runs|\.lab-agent|node_modules|__pycache__)(?:\/|$)/u.test(file) && !(path.basename(file).startsWith('.env') && path.basename(file) !== '.env.example') });
await writeFile(path.join(project, 'data/input.csv'), original, { mode: 0o400 });
await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'independent-source-table-audit', private: true, type: 'module' }) + '\n');
await writeFile(path.join(project, 'AGENTS.md'), 'Audit the original reference CSV as data. Preserve every header, cell, row order, empty cell and qualifier. Do not infer biological conclusions or impute missing measurements. Call sourceEvidence once, then load table-quality, then run the registered analyze script. Its outputDirectory gives exact project-relative file paths. The independent validator owns acceptance.\n');
await writeFile(path.join(project, 'agent.config.ts'), `import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {tool} from 'ai';import {z} from 'zod';
import {defineAgent,modelFromEnv} from 'lab-agent-core-vercel';
export default defineAgent(({root,env})=>({root,model:modelFromEnv(env),
  tools:{sourceEvidence:tool({description:'Confirm exact registered input source bytes, path and SHA256 without altering or interpreting the table.',inputSchema:z.object({}),execute:async(_input,{abortSignal})=>{abortSignal?.throwIfAborted();const raw=await readFile(path.join(root,'data/input.csv'));return{path:'data/input.csv',bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')};}})},
  provenance:{inputs:['data/input.csv'],code:['.agents/skills/table-quality/references/output.md']},
  python:{scripts:{analyze:{path:'tools/analyze.py',description:'Source-preserving CSV profile',modes:['task']}}},
  validation:{command:['python3','tools/validate.py'],timeoutMs:30000},limits:{maxSteps:16,timeoutMs:180000}
}));\n`);

async function execute(command, args, log) {
  const child = spawn(command, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', bytes => { text += bytes; }); child.stderr.on('data', bytes => { text += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await writeFile(path.join(directory, log), text);
  if (code !== 0) throw new Error(`${command} exited ${code}. See ${path.join(directory, log)}.`);
}
const report = { kind: 'installed-live-external-source-audit', status: 'running', startedAt: new Date().toISOString(), project,
  source: { path: source, bytes: original.length, sha256: originalHash }, tarball: { path: tarball, sha256: digest(await readFile(tarball)) },
  scope: 'Existing local reference table copied byte-for-byte; live configured model chooses native tools/Skill/Python, independent validator re-reads source. No scientific discovery, predictive-accuracy or human-onboarding claim.' };
try {
  await execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], 'install.log');
  assert.equal((await lstat(path.join(project, 'node_modules/lab-agent-core-vercel'))).isSymbolicLink(), false);
  await writeFile(path.join(project, 'trial.mjs'), `import assert from 'node:assert/strict';import {readFile,writeFile}from'node:fs/promises';import path from'node:path';
import{createAgent,loadAgentConfig,createHttpServer}from'lab-agent-core-vercel';
const config=await loadAgentConfig(process.cwd());let providerCalls=0;const actual=config.model;
config.model=new Proxy(actual,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'&&['doGenerate','doStream'].includes(key)?(...args)=>{providerCalls++;return value.apply(target,args)}:value}});
const agent=await createAgent(config);let server;
try{
const run=await agent.runTask('Audit the supplied reference CSV. Confirm sourceEvidence, load table-quality and use the registered analyze script. Preserve raw cells and qualifiers; save profile.json and report.md. Summarize dimensions and data limitations only.',{inputs:['data/input.csv']});
assert.equal(run.execution,'completed');assert.equal(run.delivery,'passed');
const history=await agent.sessions.load(run.session.id);const calls=history.messages.flatMap(m=>m.parts).filter(p=>p.type.startsWith('tool-')&&p.state==='output-available').map(p=>p.type.slice(5));
for(const name of['sourceEvidence','loadSkill','runPython'])assert.ok(calls.includes(name),'Missing live tool use: '+name);
const profile=JSON.parse(await readFile(path.join(run.directory,'output/profile.json'),'utf8'));const original=JSON.stringify(run.originalDelivery);const baseline=JSON.stringify(run.provenance.inputs);const callsBefore=providerCalls;
server=await createHttpServer(agent,{port:0});const imported=await fetch(server.url+'/api/uploads?name=unrelated_sample_B.csv',{method:'POST',headers:{authorization:'Bearer '+server.token},body:'sample,value\\nB,2\\n'});assert.equal(imported.status,201);
const checked=await agent.runs.check(run.id);assert.equal(checked.delivery,'passed');assert.equal(JSON.stringify(checked.provenance.inputs),baseline);
const file=path.join(run.directory,'output/profile.json');const originalArtifact=await readFile(file,'utf8');await writeFile(file,'{}');const tampered=await agent.runs.check(run.id);assert.equal(tampered.delivery,'failed');assert.equal(JSON.stringify(tampered.originalDelivery),original);
await writeFile(file,originalArtifact);const restored=await agent.runs.check(run.id);assert.equal(restored.delivery,'passed');
assert.equal(providerCalls,callsBefore,'Recheck must not make model requests');
console.log(JSON.stringify({status:'passed',model:run.model,runId:run.id,runDirectory:run.directory,rowCount:profile.row_count,columnCount:profile.column_count,sourceSha256:profile.source_sha256,toolCalls:calls,providerCalls,usage:run.usage,initialDelivery:run.delivery,unrelatedUploadRecheck:checked.delivery,tamperedDelivery:tampered.delivery,restoredDelivery:restored.delivery,loadedSkills:run.provenance.skills.filter(s=>s.loaded)}));
}finally{if(server)await server.close();else await agent.close();}
`);
  await execute(process.execPath, ['--check', 'trial.mjs'], 'syntax.log');
  await execute(process.execPath, [`--env-file=${envFile}`, 'trial.mjs'], 'trial.log');
  const lines = (await readFile(path.join(directory, 'trial.log'), 'utf8')).trim().split('\n');
  report.result = JSON.parse(lines.findLast(line => line.startsWith('{') && line.endsWith('}')));
  assert.equal(report.result.sourceSha256, originalHash);
  assert.equal(digest(await readFile(source)), originalHash, 'Existing source project must remain unchanged.');
  await cp(project, path.join(directory, 'project'), { recursive: true, filter: file => !/(?:^|\/)(?:node_modules|__pycache__)(?:\/|$)/u.test(file) });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
await writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, project, report: path.join(directory, 'results.json') }));

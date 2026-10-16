import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
await mkdir(new URL('../.artifacts/', import.meta.url), { recursive: true });
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '-w', 'lab-agent-core-vercel', '--pack-destination', '.artifacts'], {
  cwd: new URL('../', import.meta.url), stdio: 'inherit',
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'apps/workbench/out');
const destination = resolve(root, 'packages/core/workbench');
// Refuse to replace an existing bundle if static export did not complete.
const entries = await readdir(source);
if (!entries.includes('index.html')) throw new Error('Workbench export is missing index.html. Run the Next.js build first.');
await mkdir(resolve(root, 'packages/core'), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log('Bundled Next.js static workbench into packages/core/workbench.');

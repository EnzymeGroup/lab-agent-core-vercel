import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function scaffold(target: string, options: { template?: string } = {}): Promise<string> {
  const name = options.template ?? 'python';
  if (!['basic', 'python', 'minimal'].includes(name)) throw new Error('Unknown template. Choose basic or python (minimal is a compatibility alias for python).');
  const root = resolve(target);
  const entries = await readdir(root).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length) throw new Error('Choose an empty destination directory.');
  await mkdir(root, { recursive: true });
  const template = fileURLToPath(new URL(`../templates/${name === 'minimal' ? 'python' : name}`, import.meta.url));
  await cp(template, root, { recursive: true, errorOnExist: true, force: false });
  const ignore = resolve(root, 'gitignore');
  if ((await readdir(root)).includes('gitignore')) await rename(ignore, resolve(root, '.gitignore'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const file = resolve(root, 'package.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.dependencies = { ...project.dependencies, 'lab-agent-core-vercel': manifest.version };
  await writeFile(file, JSON.stringify(project, null, 2) + '\n');
  return root;
}

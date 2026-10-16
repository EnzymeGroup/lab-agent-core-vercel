import { cp, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function scaffold(target: string): Promise<string> {
  const root = resolve(target);
  const entries = await readdir(root).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length) throw new Error('Choose an empty destination directory.');
  await mkdir(root, { recursive: true });
  const template = fileURLToPath(new URL('../templates/minimal', import.meta.url));
  await cp(template, root, { recursive: true, errorOnExist: true, force: false });
  const ignore = resolve(root, 'gitignore');
  if ((await readdir(root)).includes('gitignore')) await rename(ignore, resolve(root, '.gitignore'));
  return root;
}

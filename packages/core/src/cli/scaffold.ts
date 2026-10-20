import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ifExists } from '../store/files.js';

/** Copy an installed template into an empty directory and pin the Core dependency. */

export const templates = ['basic', 'python'] as const;
export type TemplateName = typeof templates[number];

export async function scaffold(target: string, options: { template?: string } = {}): Promise<string> {
  const name = options.template ?? 'python';
  if (!(templates as readonly string[]).includes(name)) throw new Error(`Unknown template "${name}". Choose ${templates.join(' or ')}.`);
  const root = resolve(target);
  const entries = (await ifExists(readdir(root))) ?? [];
  if (entries.length) throw new Error('Choose an empty destination directory.');
  await mkdir(root, { recursive: true });
  await cp(fileURLToPath(new URL(`../../templates/${name}`, import.meta.url)), root, { recursive: true, errorOnExist: true, force: false });
  // npm strips .gitignore from packages, so templates ship it as `gitignore`.
  if ((await readdir(root)).includes('gitignore')) await rename(resolve(root, 'gitignore'), resolve(root, '.gitignore'));
  const core = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const file = resolve(root, 'package.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.dependencies = { ...project.dependencies, 'lab-agent-core-vercel': core.version };
  await writeFile(file, `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

export const nextSteps = 'Next: install the lab-agent-core-vercel tarball, copy .env.example to .env, then run npx lab-agent doctor.';

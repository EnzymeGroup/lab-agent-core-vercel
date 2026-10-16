import { access, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const core = new URL('../packages/core/', import.meta.url);
for (const file of ['dist/index.js', 'workbench/index.html']) {
  try { await access(new URL(file, core)); }
  catch { throw new Error(`Missing ${file}. Run npm run build from ${fileURLToPath(root)} before packing.`); }
}
for (const file of ['README.md', 'LICENSE', 'docs', 'examples']) await cp(new URL(file, root), new URL(file, core), { recursive: true, force: true,
  filter: source => !/(?:^|\/)(?:runs|\.lab-agent|node_modules|__pycache__)(?:\/|$)/.test(source)
    && !/(?:^|\/)\.env(?:\.(?!example(?:\/|$))[^/]+)?(?:\/|$)/u.test(source) });

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['README.md', 'AGENTS.md', 'docs/CONTRACTS.md', 'docs/EXTENDING.md', 'docs/QUICKSTART.md', 'docs/CONVENTIONS.md', 'docs/ARCHITECTURE.md', 'docs/VALIDATION.md', 'docs/COMPARISON.md', 'docs/PROVIDERS.md', 'docs/CHANGELOG.md', 'docs/REVIEW-LEDGER.md'];
const issues = [];
for (const file of files) {
  const text = await readFile(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const link = match[1];
    if (/^[a-z]+:/i.test(link)) continue;
    await access(path.resolve(root, path.dirname(file), link)).catch(() => issues.push(`${file}: missing link ${link}`));
  }
  if (/TODO|TBD|coming soon/i.test(text)) issues.push(`${file}: unfinished placeholder`);
}
const conventions = await readFile(path.join(root, 'docs/CONVENTIONS.md'), 'utf8');
for (const term of ['not_checked', 'partial', 'AGENT_CHECK_FILE', 'LAB_AGENT_MODEL', 'LAB_AGENT_API_KEY', 'runTask', 'streamTurn']) {
  if (!conventions.includes(term)) issues.push(`conventions missing ${term}`);
}
const validation = await readFile(path.join(root, 'docs/VALIDATION.md'), 'utf8');
if (!validation.includes('Not verified') || !validation.includes('Not measured')) issues.push('validation omits evidence limits');
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Documentation verified: ${files.length} files, local links and required contracts.`);

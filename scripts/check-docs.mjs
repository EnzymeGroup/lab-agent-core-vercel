import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Checks local links, unfinished placeholders, required contract terms and evidence limits.
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = (await readdir(path.join(root, 'docs/evidence'))).filter(name => name.endsWith('.md')).map(name => `docs/evidence/${name}`);
const files = ['README.md', 'AGENTS.md', 'docs/GUIDE.md', 'docs/REFERENCE.md', 'docs/ARCHITECTURE.md', 'docs/CHANGELOG.md', 'docs/EXTRAS.md', ...evidence];
const issues = [];

for (const file of files) {
  const text = await readFile(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const link = match[1];
    if (/^[a-z]+:/i.test(link)) continue;
    await access(path.resolve(root, path.dirname(file), link)).catch(() => issues.push(`${file}: missing link ${link}`));
  }
  if (/TODO|TBD|coming soon|_PLACEHOLDER|GUIDE_PART|REFERENCE_PART/i.test(text)) issues.push(`${file}: unfinished placeholder`);
}

const reference = await readFile(path.join(root, 'docs/REFERENCE.md'), 'utf8');
for (const term of ['not_checked', 'partial', 'AGENT_CHECK_FILE', 'LAB_AGENT_MODEL', 'LAB_AGENT_API_KEY', 'runTask', 'streamTurn', 'ui']) {
  if (!reference.includes(term)) issues.push(`reference missing ${term}`);
}
const validation = await readFile(path.join(root, 'docs/evidence/VALIDATION.md'), 'utf8');
if (!validation.includes('Not verified') || !validation.includes('Not measured')) issues.push('validation omits evidence limits');

if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Documentation verified: ${files.length} files, local links and required contracts.`);
}

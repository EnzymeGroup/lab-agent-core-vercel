import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

interface State {
  busy: boolean;
  project: string;
  sessions: Array<{ id: string; state: string; error?: string }>;
  runs: Array<{ id: string; directory: string; execution: string; delivery: string; session: { id: string }; artifacts: string[] }>;
}

async function authorized(request: APIRequestContext) {
  const bootstrap = await request.get('/api/bootstrap');
  expect(bootstrap.ok()).toBeTruthy();
  const { token } = await bootstrap.json();
  return { Authorization: `Bearer ${token}` };
}

async function readState(request: APIRequestContext): Promise<State> {
  const response = await request.get('/api/state', { headers: await authorized(request) });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function waitIdle(request: APIRequestContext) {
  await expect.poll(async () => (await readState(request)).busy, { timeout: 45_000 }).toBe(false);
}

async function createSession(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Demo fixture · no live model')).toBeVisible();
  await page.getByRole('complementary', { name: 'Sessions', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeVisible();
}

test('real task, authoritative history, artifact download, tamper detection and chat mode', async ({ page, request }, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const sent: Array<{ sessionId: string; messages: Array<{ role: string }>; mode: string; inputs?: string[] }> = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', message => { if (message.url().endsWith('/api/chat') && message.method() === 'POST') sent.push(message.postDataJSON()); });

  await createSession(page);
  const task = `Summarize the FASTA and validate the artifacts. Browser verification ${Date.now()}.`;
  await page.getByRole('textbox', { name: 'Message to agent' }).fill(task);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.locator('.tool-call summary code').filter({ hasText: 'runPython' })).toBeVisible();
  await expect(page.locator('.message-assistant')).toContainText('Deterministic demo finished.');
  await waitIdle(request);
  const state = await readState(request);
  const sessionId = sent[0].sessionId;
  const run = state.runs.find(item => item.session.id === sessionId)!;
  expect(run.execution).toBe('completed');
  expect(run.delivery).toBe('passed');
  expect(run.artifacts).toEqual(expect.arrayContaining(['output/summary.json', 'output/report.md']));
  await expect(page.getByRole('region', { name: 'Selected run details' })).toContainText('Passed');
  const pythonEvidence = page.locator('.tool-call').filter({ has: page.getByText('runPython', { exact: true }) }).locator('.tool-body');
  await expect(pythonEvidence).toContainText('summarize');
  await expect(pythonEvidence).toContainText('OUTPUT');
  await page.screenshot({ path: testInfo.outputPath('workbench-task-light.png'), fullPage: true });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download output/summary.json', exact: true }).click();
  const file = await download;
  const downloaded = testInfo.outputPath('summary.json');
  await file.saveAs(downloaded);
  const summary = JSON.parse(await readFile(downloaded, 'utf8'));
  expect(summary.record_count).toBe(4);
  expect(summary.records[0].id).toBe(summary.records[2].id);
  expect(summary.records[1].sequence).toBe('ACDXxG?-T');

  // This is a local test fixture: mutate the real output on disk, then invoke
  // the public checker endpoint. The UI has no privileged file-write endpoint.
  const artifact = join(run.directory, 'output', 'summary.json');
  const original = await readFile(artifact, 'utf8');
  try {
    await writeFile(artifact, JSON.stringify({ ...summary, record_count: 999 }));
    const rechecked = await request.post('/api/check', { headers: await authorized(request), data: { runId: run.id } });
    expect(rechecked.ok()).toBeTruthy();
    expect((await rechecked.json()).delivery).toBe('failed');
    await page.getByRole('region', { name: 'Selected run details' }).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Delivery check', exact: true })).toContainText('Delivery failed');
    const changed = (await readState(request)).runs.find(item => item.id === run.id)!;
    expect(changed.execution).toBe('completed');
    expect(changed.delivery).toBe('failed');
  } finally { await writeFile(artifact, original); }

  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Delivery check', exact: true })).toContainText('Delivery passed');
  const runCount = (await readState(request)).runs.length;
  await page.getByRole('radio', { name: 'Chat', exact: true }).check();
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('[chat-only] Explain what was saved.');
  await page.getByRole('textbox', { name: 'Message to agent' }).press('Shift+Enter');
  await page.getByRole('textbox', { name: 'Message to agent' }).pressSequentially('Keep source identifiers.');
  await page.getByRole('textbox', { name: 'Message to agent' }).press('Enter');
  await expect(page.locator('.message-user')).toHaveCount(2);
  await waitIdle(request);
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeEnabled();
  expect((await readState(request)).runs).toHaveLength(runCount);
  expect(sent).toHaveLength(2);
  expect(sent.every(turn => turn.messages.length === 1 && turn.messages[0].role === 'user')).toBeTruthy();
  expect(sent[0].inputs).toBeUndefined();
  expect(sent[1].inputs).toBeUndefined();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.message-user')).toHaveCount(2);
  await expect(page.locator('.message-user').first()).toContainText(task);
  await expect(page.locator('.tool-call summary code').filter({ hasText: 'runPython' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workbench-task-dark.png'), fullPage: true });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('running work survives page reload, then explicit Stop persists an aborted run', async ({ page, request }, testInfo) => {
  await createSession(page);
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('[wait] Wait for cancellation.');
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect.poll(async () => (await readState(request)).busy).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const state = await readState(request);
  const run = state.runs.find(item => item.execution === 'running')!;
  expect(run).toBeTruthy();
  await page.reload();
  await expect(page.getByText('Running on server · restoring history')).toBeVisible();
  expect((await readState(request)).busy).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workbench-running-restored.png'), fullPage: true });
  const canceled = page.waitForResponse(response => response.url().endsWith('/api/cancel') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect((await canceled).ok()).toBeTruthy();
  await waitIdle(request);
  expect((await readState(request)).runs.find(item => item.id === run.id)?.execution).toBe('aborted');
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeEnabled();
});

test('provider failures surface an honest error and survive session reload', async ({ page, request }) => {
  await createSession(page);
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('[model-error] Exercise the provider failure path.');
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Turn needs attention' })).toBeVisible({ timeout: 30_000 });
  await waitIdle(request);
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Turn needs attention' })).toBeVisible();
});

test('bootstrap and state errors provide a working reconnect action', async ({ page }) => {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Fixture offline"}}' }));
  await page.goto('/');
  await expect(page.locator('.connection-banner')).toContainText('Bootstrap failed (503)');
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  await page.unroute('**/api/bootstrap');
  await page.route('**/api/state', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":{"message":"Access token expired"}}' }));
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.locator('.connection-banner')).toContainText('Access token expired');
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  await expect(page.getByText('Connected locally')).toBeVisible();
});

test('input imports resolve in real tool calls and safe previews expose original artifacts', async ({ page, request }, testInfo) => {
  const pageErrors: string[] = [];
  const turns: Array<{ sessionId: string; inputs?: string[] }> = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', message => { if (message.url().endsWith('/api/chat') && message.method() === 'POST') turns.push(message.postDataJSON()); });
  await createSession(page);
  await page.locator('.input-files > summary').click();
  const inputs = page.getByRole('region', { name: 'Input files', exact: true });
  await expect(inputs.getByLabel('Choose an input file')).toBeEnabled();
  await inputs.getByLabel('Choose an input file').setInputFiles({ name: 'unsafe.html', mimeType: 'text/html', buffer: Buffer.from('<script>bad()</script>') });
  await expect(inputs.getByRole('alert')).toContainText('Unsupported file type');
  await inputs.getByLabel('Choose an input file').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 'x') });
  await expect(inputs.getByRole('alert')).toContainText('File is too large');
  await inputs.getByLabel('Choose an input file').setInputFiles({ name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([1, 0, 2]) });
  await inputs.getByRole('button', { name: 'Import file', exact: true }).click();
  await expect(inputs.getByRole('alert')).toContainText('Only text scientific inputs');

  const name = `browser-input-${Date.now()}.csv`;
  const content = 'sample,value\nalpha,42\nbeta,"a,b"\n';
  await inputs.getByLabel('Choose an input file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
  await inputs.getByRole('button', { name: 'Import file', exact: true }).click();
  await expect(inputs.getByRole('status')).toContainText(`Imported ${name}`);
  const listing = await request.get('/api/uploads', { headers: await authorized(request) }).then(response => response.json());
  const uploaded = listing.files.find((file: { name: string }) => file.name === name);
  expect(uploaded.path).toMatch(/^data\/uploads\//);
  expect(uploaded.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  const stateBefore = await readState(request);
  expect(await readFile(join(stateBefore.project, uploaded.path), 'utf8')).toBe(content);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await inputs.getByRole('button', { name: `Copy path for ${name}`, exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(uploaded.path);
  await inputs.getByRole('button', { name: `Use ${name} in task`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toHaveValue(`Input file: ${uploaded.path}`);
  await expect(page.getByRole('list', { name: 'Task input bindings' })).toContainText(uploaded.path);
  await page.getByRole('textbox', { name: 'Project-relative input path' }).fill('data/input.fasta');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  expect(turns).toHaveLength(0);
  // The fixture reads the uploaded CSV as context. The registered FASTA
  // summarizer still analyzes its declared FASTA source, explicitly requested here.
  await page.getByRole('textbox', { name: 'Message to agent' }).fill(`[input:${uploaded.path}] Read this uploaded context, then summarize the original FASTA and validate its artifacts.`);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  const readEvidence = page.locator('.tool-call').filter({ has: page.getByText('readFile', { exact: true }) });
  await expect(readEvidence).toContainText('alpha,42');
  await expect(page.locator('.message-assistant')).toContainText('Deterministic demo finished.');
  await waitIdle(request);
  const state = await readState(request);
  const run = state.runs.find(item => item.session.id === turns[0].sessionId)!;
  expect(turns[0].inputs).toEqual([uploaded.path, 'data/input.fasta']);
  expect(run.execution).toBe('completed');
  expect(run.delivery).toBe('passed');

  // Host-side renderer fixtures are registered by a real rescan/check. These
  // are renderer test inputs, not files claimed to have been generated by a model.
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const context = canvas.getContext('2d')!; context.fillStyle = '#106e67'; context.fillRect(0, 0, 24, 24);
    return { png: canvas.toDataURL('image/png').split(',')[1], jpg: canvas.toDataURL('image/jpeg').split(',')[1] };
  });
  const seeds: Array<[string, string | Buffer]> = [
    ['preview.csv', content], ['preview.txt', 'Plain artifact evidence.'],
    ['preview.md', '# Preview evidence\n\n<img src=x onerror="window.__previewExecuted=true">\n\n- Original text remains escaped.\n'],
    ['preview.png', Buffer.from(images.png, 'base64')], ['preview.jpg', Buffer.from(images.jpg, 'base64')],
    ['long.txt', 'Bounded preview evidence.\n'.repeat(15000)], ['unsafe.html', '<script>window.__previewExecuted=true</script>'],
  ];
  await Promise.all(seeds.map(([file, bytes]) => writeFile(join(run.directory, 'output', file), bytes)));
  const checked = await request.post('/api/check', { headers: await authorized(request), data: { runId: run.id } });
  expect(checked.ok()).toBeTruthy();
  const latest = await checked.json();
  expect(latest.originalDelivery.delivery).toBe('passed');
  expect(latest.checks.at(-1).artifactChanges).toEqual(expect.arrayContaining(['output/preview.csv']));
  await page.getByRole('region', { name: 'Selected run details' }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Run evidence' })).toContainText('Changes observed since execution');

  async function openPreview(file: string) {
    await page.getByRole('button', { name: `Preview output/${file}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Artifact preview', exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  }
  let preview = await openPreview('summary.json');
  await expect(preview.locator('pre')).toContainText('"record_count": 4');
  await page.keyboard.press('Escape');
  preview = await openPreview('preview.csv');
  await expect(preview.getByRole('cell', { name: 'a,b', exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Close artifact preview' }).click();
  preview = await openPreview('preview.md');
  await expect(preview.getByRole('heading', { name: 'Preview evidence' })).toBeVisible();
  await expect(preview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => '__previewExecuted' in window)).toBe(false);
  await page.keyboard.press('Escape');
  preview = await openPreview('preview.txt');
  await expect(preview.locator('pre')).toHaveText('Plain artifact evidence.');
  await page.keyboard.press('Escape');
  for (const image of ['preview.png', 'preview.jpg']) {
    preview = await openPreview(image);
    await expect(preview.getByRole('img', { name: `Artifact output/${image}` })).toBeVisible();
    await expect.poll(() => preview.locator('img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(24);
    await page.keyboard.press('Escape');
  }
  preview = await openPreview('long.txt');
  await expect(preview.getByRole('status')).toContainText('preview is truncated');
  await page.keyboard.press('Escape');
  preview = await openPreview('unsafe.html');
  await expect(preview.getByRole('alert')).toContainText('Preview supports');
  expect(await page.evaluate(() => '__previewExecuted' in window)).toBe(false);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Capabilities/ }).click();
  const capabilities = page.getByRole('dialog', { name: 'Project capabilities' });
  await expect(capabilities).toContainText('deterministic-demo');
  await expect(capabilities).toContainText('One project, one active operation');
  await expect(capabilities).toContainText('No MCP servers configured');
  const readCapability = capabilities.locator('.capability-list > li').filter({ has: page.getByText('readFile', { exact: true }) });
  await readCapability.getByText('Input schema for readFile', { exact: true }).click();
  await expect(readCapability.locator('pre')).toBeVisible();
  await expect(readCapability.locator('pre')).toContainText('"path"');
  const capabilitiesState = await request.get('/api/state', { headers: await authorized(request) }).then(response => response.json());
  await expect(readCapability).toContainText(capabilitiesState.toolDetails.find((tool: { name: string }) => tool.name === 'readFile').description);
  await page.screenshot({ path: testInfo.outputPath('capabilities-light.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  preview = await openPreview('preview.csv');
  await page.screenshot({ path: testInfo.outputPath('preview-csv-dark.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('navigation', { name: 'Workbench panels' }).getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: /Capabilities/ }).click();
  await expect(page.getByRole('dialog', { name: 'Project capabilities' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('capabilities-mobile-dark.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(inputs.getByLabel('Choose an input file')).toBeVisible();
  await inputs.getByRole('button', { name: `Use ${name} in task`, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('inputs-mobile-dark.png'), fullPage: true });
  await page.getByRole('navigation', { name: 'Workbench panels' }).getByRole('button', { name: 'Runs & files', exact: true }).click();
  preview = await openPreview('preview.csv');
  await expect(preview.getByRole('cell', { name: 'a,b', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('preview-mobile-dark.png'), fullPage: true });
  await page.keyboard.press('Escape');
  expect(pageErrors).toEqual([]);
});

test('explicit task input baseline stays frozen after an unrelated upload and Chat omits bindings', async ({ page, request }, testInfo) => {
  const turns: Array<{ sessionId: string; mode: string; inputs?: string[] }> = [];
  page.on('request', message => { if (message.url().endsWith('/api/chat') && message.method() === 'POST') turns.push(message.postDataJSON()); });
  await createSession(page);
  await page.locator('.task-inputs > summary').click();
  const path = page.getByRole('textbox', { name: 'Project-relative input path' });
  await path.fill('/tmp/outside-project.fasta');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await expect(page.locator('.task-input-body').getByRole('alert')).toContainText('project-relative');
  await path.fill('data/input.fasta');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await path.fill('data/not-selected.txt');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await page.getByRole('button', { name: 'Remove input data/not-selected.txt', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Task input bindings' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Task input bindings' })).toContainText('data/input.fasta');
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('Summarize the original FASTA and validate the artifacts for the explicitly bound source.');
  await page.screenshot({ path: testInfo.outputPath('task-input-bindings.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.getByRole('list', { name: 'Task input bindings' })).toContainText('data/input.fasta');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-input-bindings-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.locator('.message-assistant')).toContainText('Deterministic demo finished.');
  await waitIdle(request);
  expect(turns[0].inputs).toEqual(['data/input.fasta']);
  const state = await readState(request);
  const run = state.runs.find(item => item.session.id === turns[0].sessionId)!;
  const before = await request.get(`/api/run?id=${encodeURIComponent(run.id)}`, { headers: await authorized(request) }).then(response => response.json());
  expect(before.run.delivery).toBe('passed');
  expect(before.run.provenance.inputSelection).toEqual({ source: 'turn', paths: ['data/input.fasta'] });
  expect(before.run.provenance.inputs.map((file: { path: string }) => file.path)).toEqual(['data/input.fasta']);
  const skill = before.run.provenance.skills.find((item: { name: string; loaded: boolean }) => item.name === 'sequence-summary' && item.loaded);
  expect(skill).toBeTruthy();
  expect(skill.sha256).toBe(createHash('sha256').update(await readFile(join(state.project, skill.path))).digest('hex'));
  const evidence = page.getByRole('region', { name: 'Run evidence' });
  await expect(evidence).toContainText('Selection: Explicit task inputs');
  await expect(evidence).toContainText('data/input.fasta');
  await evidence.getByText('Versions & provenance', { exact: true }).click();
  await expect(evidence.locator('.skill-fingerprints')).toContainText('sequence-summary');
  await expect(evidence.locator('.skill-fingerprints')).toContainText('Loaded');

  await page.locator('.input-files > summary').click();
  const inputs = page.getByRole('region', { name: 'Input files', exact: true });
  const unrelatedName = `unrelated-B-${Date.now()}.txt`;
  await inputs.getByLabel('Choose an input file').setInputFiles({ name: unrelatedName, mimeType: 'text/plain', buffer: Buffer.from('This unrelated upload is not a source for task A.\n') });
  await inputs.getByRole('button', { name: 'Import file', exact: true }).click();
  await expect(inputs.getByRole('status')).toContainText(`Imported ${unrelatedName}`);
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Delivery check', exact: true })).toContainText('Delivery passed');
  await waitIdle(request);
  await expect.poll(async () => {
    const detail = await request.get(`/api/run?id=${encodeURIComponent(run.id)}`, { headers: await authorized(request) }).then(response => response.json());
    return detail.run.checks.length;
  }).toBe(before.run.checks.length + 1);
  const after = await request.get(`/api/run?id=${encodeURIComponent(run.id)}`, { headers: await authorized(request) }).then(response => response.json());
  expect(after.run.delivery).toBe('passed');
  expect(after.run.provenance.inputs).toEqual(before.run.provenance.inputs);
  expect(after.run.provenance.inputSelection).toEqual(before.run.provenance.inputSelection);
  expect(after.run.checks.at(-1).inputChanges).toEqual([]);
  expect(after.run.originalDelivery).toEqual(before.run.originalDelivery);
  await page.screenshot({ path: testInfo.outputPath('frozen-input-recheck.png'), fullPage: true });

  await page.getByRole('radio', { name: 'Chat', exact: true }).check();
  await expect(page.locator('.chat-policy')).toContainText('can have side effects on the host');
  await expect(page.locator('.chat-policy')).toContainText('omitted from Chat');
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('[chat-only] Explain the frozen provenance without running Python.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-user')).toHaveCount(2);
  await waitIdle(request);
  expect(turns[1].mode).toBe('chat');
  expect(turns[1].inputs).toBeUndefined();
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeEnabled();
  await page.getByRole('radio', { name: 'Task', exact: true }).check();
  await expect(page.getByRole('list', { name: 'Task input bindings' })).toContainText('data/input.fasta');
  await page.getByRole('button', { name: 'Use project defaults', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Task input bindings' })).toHaveCount(0);
  await expect(page.locator('.task-inputs > summary')).toContainText('Project defaults');
});

test('incompatible legacy tool history shows recovery guidance without rewriting evidence', async ({ page, request }) => {
  await createSession(page);
  const state = await readState(request);
  const sessionId = state.sessions[0].id;
  const sessionFile = join(state.project, '.lab-agent', 'sessions', `${sessionId}.json`);
  const record = JSON.parse(await readFile(sessionFile, 'utf8'));
  // Host-authored legacy fixture: a historical tool that this configuration no
  // longer provides. The UI must preserve it and surface the Core recovery error.
  record.messages = [
    { id: 'legacy-user', role: 'user', parts: [{ type: 'text', text: 'Historical request.' }] },
    { id: 'legacy-agent', role: 'assistant', parts: [{ type: 'tool-retiredFixture', toolCallId: 'legacy-call', state: 'output-available', input: {}, output: { retained: true } }] },
  ];
  const baseline = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(sessionFile, baseline);
  await page.reload();
  await expect(page.locator('.tool-call')).toContainText('retiredFixture');
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('[chat-only] Continue the legacy fixture.');
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Turn needs attention' });
  await expect(error).toContainText('retiredFixture');
  await expect(error).toContainText(/compatible|new session/i);
  expect(await readFile(sessionFile, 'utf8')).toBe(baseline);
  expect((await readState(request)).runs).toHaveLength(state.runs.length);
  await expect(page.locator('.message-user')).toHaveCount(1);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`workbench is usable at ${width}px without horizontal overflow`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByText('Demo fixture · no live model')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width <= 900) {
      const tabs = page.getByRole('navigation', { name: 'Workbench panels' });
      await expect(tabs).toBeVisible();
      await tabs.getByRole('button', { name: 'Sessions', exact: true }).click();
      const sessions = page.getByRole('complementary', { name: 'Sessions', exact: true });
      await expect(sessions).toBeVisible();
      await sessions.getByRole('button', { name: 'New session', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeVisible();
      await expect(tabs.getByRole('button', { name: 'Conversation', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await tabs.getByRole('button', { name: 'Runs & files', exact: true }).click();
      await expect(page.getByRole('complementary', { name: 'Runs and artifacts' })).toBeVisible();
      await expect(page.getByText('No task runs in this session')).toBeVisible();
      await tabs.getByRole('button', { name: 'Conversation', exact: true }).click();
    } else {
      await expect(page.getByRole('complementary', { name: 'Sessions', exact: true })).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Runs and artifacts' })).toBeVisible();
    }
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workbench-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

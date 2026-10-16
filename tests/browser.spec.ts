import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  const sent: Array<{ sessionId: string; messages: Array<{ role: string }>; mode: string }> = [];
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

import { defineConfig } from '@playwright/test';

const baseURL = process.env.LAB_AGENT_TEST_URL || 'http://127.0.0.1:18787';

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, browserName: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.LAB_AGENT_TEST_URL ? undefined : {
    command: 'node scripts/demo.mjs --port 18787 --root .artifacts/browser-project',
    url: `${baseURL}/api/bootstrap`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

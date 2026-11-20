import { defineConfig, devices } from '@playwright/test';

// SCORECRAFT_URL points the suite at a server you started yourself. Without it, Playwright
// starts `npm start` on SCORECRAFT_E2E_PORT (default 4382) and stops it afterwards. That server
// keeps its scores and scans in .data/e2e, emptied at each start, so test runs never touch the
// everyday library in .data/library.
const externalUrl = process.env.SCORECRAFT_URL;
const port = Number(process.env.SCORECRAFT_E2E_PORT ?? 4382);
const baseURL = externalUrl || `http://127.0.0.1:${port}`;
// SCORECRAFT_BROWSER_PATH selects a Chromium/Chrome executable instead of the Chrome channel.
const executablePath = process.env.SCORECRAFT_BROWSER_PATH?.trim();

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  ...(externalUrl
    ? {}
    : {
        webServer: {
          command: `node -e "require('node:fs').rmSync('.data/e2e',{recursive:true,force:true})" && npm start`,
          url: `${baseURL}/api/health`,
          env: { PORT: String(port), SCORECRAFT_DATA_DIR: '.data/e2e' },
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }),
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : { channel: 'chrome' }),
    headless: true,
  },
});

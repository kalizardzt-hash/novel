import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4328',
    browserName: 'chromium',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm server',
    url: 'http://127.0.0.1:4328/api/v1/health',
    reuseExistingServer: false,
    env: { NOVEL_PORT: '4328', NOVEL_DATA_DIR: '.novel/e2e' },
  },
});

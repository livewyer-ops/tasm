import { defineConfig } from '@playwright/test';
const external = process.env.TASM_PLAYPEN_URL && process.env.TASM_DEMO_URL;
if (!!process.env.TASM_PLAYPEN_URL !== !!process.env.TASM_DEMO_URL) throw new Error('Set both TASM_PLAYPEN_URL and TASM_DEMO_URL.');
export default defineConfig({
  testDir: './tests/browser', timeout: 90000, workers: process.env.CI ? 2 : 1, retries: process.env.CI ? 1 : 0,
  fullyParallel: true, forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: { headless: true, trace: { mode: 'retain-on-failure', screenshots: false }, screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: external ? undefined : ['playpen', 'demo'].map((app, index) => ({
    command: `node scripts/serve.mjs --app=${app}`, url: `http://127.0.0.1:${5173 + index}/`, reuseExistingServer: false,
    env: { PORT: String(5173 + index) }
  }))
});

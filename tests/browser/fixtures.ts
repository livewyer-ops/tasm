import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const browserEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key, value]) => value !== undefined && !/^(https?|all)_proxy$/i.test(key))) as Record<string, string>;

// Persistent profiles exercise the real on-disk storage APIs, including WebKit.
export const test = base.extend<{ profile: string; showOnboarding: boolean; showResultTips: boolean; app: 'demo' | 'playpen'; demoURL: string; playpenURL: string }>({
  showOnboarding: [false, { option: true }],
  showResultTips: [false, { option: true }],
  app: ['playpen', { option: true }],
  demoURL: process.env.TASM_DEMO_URL ?? 'http://127.0.0.1:5174/',
  playpenURL: process.env.TASM_PLAYPEN_URL ?? 'http://127.0.0.1:5173/',
  baseURL: async ({ app, demoURL, playpenURL }, use) => use(app === 'demo' ? demoURL : playpenURL),
  profile: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'tasm-browser-'));
    try { await use(profile); } finally { await rm(profile, { recursive: true, force: true }); }
  },
  context: async ({ playwright, browserName, baseURL, profile, showOnboarding, showResultTips }, use) => {
    const context = await playwright[browserName].launchPersistentContext(profile, { headless: true, baseURL, env: browserEnv,
      ...(browserName === 'chromium' ? { ignoreDefaultArgs: ['--mute-audio'] } : {}) });
    if (!showOnboarding) await context.addInitScript(() => {
      try { for (const site of ['demo', 'playpen']) localStorage.setItem(`tasm-onboarding:${site}:v1`, 'seen'); } catch { /* about:blank has no storage origin. */ }
    });
    if (!showResultTips) await context.addInitScript(() => {
      try { localStorage.setItem('tasm-demo:result-tips:v1', 'off'); } catch { /* Preferences are optional. */ }
    });
    try { await use(context); } finally { await context.close(); }
  }
});
export { expect };

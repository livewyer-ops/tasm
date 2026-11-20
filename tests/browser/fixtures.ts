import { execFileSync } from 'node:child_process';
import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const browserEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key, value]) => value !== undefined && !/^(https?|all)_proxy$/i.test(key))) as Record<string, string>;

// Persistent profiles exercise the real on-disk storage APIs, including WebKit.
export const test = base.extend<{ profile: string; showOnboarding: boolean; showResultTips: boolean; app: 'demo' | 'playpen'; demoURL: string; playpenURL: string }, { audioSink?: string }>({
  audioSink: [async ({}, use, info) => {
    if (!process.env.TASM_TEST_AUDIO) return use(undefined);
    const name = 'tasm_' + process.pid + '_worker_' + info.workerIndex;
    const module = execFileSync('pactl', ['load-module', 'module-null-sink', 'sink_name=' + name], { encoding: 'utf8' }).trim();
    try { await use(name); } finally { execFileSync('pactl', ['unload-module', module]); }
  }, { scope: 'worker' }],
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
  context: async ({ playwright, browserName, baseURL, profile, showOnboarding, showResultTips, audioSink }, use) => {
    const context = await playwright[browserName].launchPersistentContext(profile, { headless: true, baseURL, env: audioSink ? { ...browserEnv, PULSE_SINK: audioSink } : browserEnv,
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

export async function save(page: Page, expectSuccess = true) {
  await expect(page.locator('#draft-status')).toContainText('Unsaved changes');
  const button = page.locator('#save-draft');
  await expect(button).toBeEnabled();
  await button.click();
  if (expectSuccess) await expect(page.locator('#draft-status')).toHaveText('All changes saved', { timeout: 90000 });
}

export async function ready(page: Page) {
  const timeout = test.info().project.name === 'webkit' ? 240000 : 90000;
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout });
  await expect(page.locator('body')).not.toHaveClass(/busy/, { timeout });
}
export async function named(page: Page, button: string, name: string, saveFlow = true) {
  await page.locator(button).click();
  await page.locator('#entity-name').fill(name);
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#name-dialog')).toBeHidden();
  await ready(page);
  if (button === '#new-source') await expect(page.locator('#source-title')).toHaveText(name);
  else {
    await expect(page.getByRole('button', { name: `Select ${name} flow`, exact: true })).toBeVisible();
    if (saveFlow) { await save(page); await ready(page); }
  }
}
export async function dragToTime(page: Page, item: Locator, track: Locator, time: number, checkPreview?: () => Promise<void>) {
  const scale = Number(await page.locator('#timeline').getAttribute('data-px-per-second'));
  expect(scale).toBeGreaterThan(0);
  await item.scrollIntoViewIfNeeded();
  const origin = await item.boundingBox();
  if (!origin) throw new Error('The dragged item must be visible');
  const inset = Math.min(10, origin.width / 2), clip = await item.getAttribute('data-block') !== null;
  await item.hover({ position: { x: inset, y: origin.height / 2 } });
  const pointerOffset = clip ? inset + await item.evaluate(el => el.clientLeft) : 0;
  await page.mouse.down();
  try {
    await track.scrollIntoViewIfNeeded();
    await page.locator('#timeline-scroll').evaluate((el, x) => { el.scrollLeft = Math.max(0, x - el.clientWidth / 2); }, time * scale);
    const target = await track.boundingBox();
    if (!target) throw new Error('The destination must be visible');
    await page.mouse.move(target.x + time * scale + pointerOffset, target.y + target.height / 2, { steps: 12 });
    await expect(track.locator('.drop-preview')).toBeVisible();
    await checkPreview?.();
  } finally { await page.mouse.up(); }
}
export async function savedWorkspace(page: Page, withObjectRange = false) {
  return page.evaluate(async withObjectRange => {
    const id = (document.getElementById('sources') as HTMLSelectElement).value;
    if (!id) return { root: undefined, flows: [] };
    const load = async (path: string) => (await fetch('/api/flows/' + path)).json();
    const root = await load(id);
    const flows = await Promise.all(root.flow_collection.map(async ({ id }: { id: string }) => ({
      flow: await load(id), segments: await load(id + '/segments' + (withObjectRange ? '?include_object_timerange=true' : '')),
    })));
    return { root, flows };
  }, withObjectRange);
}

export async function listen(server: import('node:http').Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
  return new URL('http://127.0.0.1:' + address.port);
}

export async function closeServer(server: import('node:http').Server) {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

export async function recordWrites(page: Page) {
  await page.evaluate(() => {
    const w = window as typeof window & { writes: unknown[]; recordingWrites?: boolean };
    w.writes = [];
    if (w.recordingWrites) return;
    w.recordingWrites = true;
    const fetch = window.fetch;
    window.fetch = async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const response = await fetch(input, init);
      if (!['GET', 'HEAD'].includes(method)) w.writes.push({
        url: input instanceof Request ? input.url : String(input), method, status: response.status,
        body: typeof init?.body === 'string' && init.headers && new Headers(init.headers).get('content-type') === 'application/json' ? JSON.parse(init.body) : undefined,
      });
      return response;
    };
  });
}

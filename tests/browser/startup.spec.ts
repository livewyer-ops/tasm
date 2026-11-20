import { test as base, expect } from './fixtures';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { Page } from '@playwright/test';

type Site = { url: string; demoURL: string; release: string; failure: string };
const test = base.extend<{ site: Site }>({
  site: async ({}, use) => {
    const site = { url: '', demoURL: '', release: 'A', failure: '' };
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.png': 'image/png', '.ts': 'video/mp2t' };
    const servers = [];
    for (const app of ['playpen', 'demo']) {
      const server = createServer(async (request, response) => {
        try {
          const path = new URL(request.url!, 'http://localhost').pathname;
          if (path === '/blank') { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>'); return; }
          if (site.failure === 'offline') { request.socket.destroy(); return; }
          if ((site.failure === 'asset' && path.endsWith('/samples/black.ts')) ||
              (site.failure === 'module' && path.endsWith('/playpen.js'))) { response.writeHead(503).end(); return; }
          const file = path.slice(1) || 'index.html';
          let body = await readFile(resolve(process.env.TASM_DIST ?? 'dist', app, file));
          if (file === 'service-worker.js') body = Buffer.from(body.toString().replace(/(var assetCache = [^;]+);/, `$1 + ":test-${site.release}";`));
          if (file.endsWith('.html')) body = Buffer.from(body.toString().replace('<body ', `<body data-release="${site.release}" `));
          response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
          response.end(body);
        } catch { response.writeHead(404).end(); }
      });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      site[app === 'demo' ? 'demoURL' : 'url'] = `http://127.0.0.1:${(server.address() as any).port}`;
      servers.push(server);
    }
    try { await use(site); }
    finally { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } }
  },
});

async function ready(page: Page) { await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60000 }); }
async function seed(page: Page, prefix = '/') {
  return page.evaluate(async prefix => {
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(prefix + 'api/' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      const text = await r.text(); return text ? JSON.parse(text) : null;
    };
    const id = crypto.randomUUID();
    await call(`flows/${id}`, 'PUT', { id, source_id: crypto.randomUUID(), format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'audio/mp4', essence_parameters: { sample_rate: 48000, channels: 2 } });
    const { put_url: put, object_id } = (await call(`flows/${id}/storage`, 'POST', {})).media_objects[0];
    const uploaded = await fetch(put.url, { method: 'PUT', headers: { 'content-type': put['content-type'] }, body: 'keep these media bytes' });
    if (!uploaded.ok) throw new Error(await uploaded.text());
    await call(`flows/${id}/segments`, 'POST', { object_id, timerange: '[0:0_1:0)' });
    localStorage.setItem('unrelated-test-sentinel', 'keep');
    return put.url as string;
  }, prefix);
}
async function installUpdate(page: Page) {
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), { timeout: 30000 }).toBe(true);
}

test('startup waits when registration briefly exposes no worker', async ({ page, site }) => {
  await page.addInitScript(() => {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async (...args) => {
      const registration = await register(...args);
      let hidden = true;
      setTimeout(() => { hidden = false; registration.dispatchEvent(new Event('updatefound')); }, 200);
      return new Proxy(registration, { get(target, key) {
        if (hidden && ['installing', 'waiting', 'active'].includes(String(key))) return null;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
  });
  await page.goto(site.url + '/'); await ready(page);
  await expect(page.locator('#startup-notice')).toBeHidden();
  await expect(page.locator('#new-source')).toBeEnabled();
});

test('ready updates respect other tabs, apply on refresh and preserve offline media', async ({ page, context, site, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 240000 : 90000);
  await page.goto(site.url + '/'); await ready(page);
  await page.locator('#new-source').click(); await page.locator('#entity-name').fill('Saved source'); await page.locator('#dialog-submit').click();
  await expect(page.locator('#source-title')).toHaveText('Saved source', { timeout: 30000 });
  const media = await seed(page);
  const second = await context.newPage(); await second.goto(site.url + '/'); await ready(second);
  await page.bringToFront();
  site.release = 'B'; await installUpdate(page);
  await expect(page.locator('#startup-message')).toHaveText('Update ready. Refresh to apply.');
  await page.reload(); await ready(page);
  await expect(page.locator('body')).toHaveAttribute('data-release', 'A');
  await expect(page.locator('#startup-message')).toContainText('Close other tabs using this store');
  await second.bringToFront();
  expect(await second.evaluate(async url => (await fetch(url)).text(), media)).toBe('keep these media bytes');
  await second.close(); await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-release', 'B', { timeout: 60000 }); await ready(page);
  await expect(page.locator('#source-title')).toHaveText('Saved source');
  site.failure = 'offline'; await page.reload(); await ready(page);
  expect(await page.evaluate(async url => (await fetch(url)).text(), media)).toBe('keep these media bytes');
  expect(await page.evaluate(() => localStorage.getItem('unrelated-test-sentinel'))).toBe('keep');
});

test('failed installation reports an error, releases its lease and retries without developer tools', async ({ page, site }) => {
  site.failure = 'asset'; await page.goto(site.url + '/');
  await expect(page.locator('#startup-notice')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#startup-message')).toContainText('installation failed');
  await expect(page.locator('#reset-playpen')).toBeEnabled();
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length)).toBe(0);
  site.failure = ''; await page.locator('#startup-retry').click(); await ready(page);
  site.release = 'B'; site.failure = 'asset';
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect(page.locator('#startup-message')).toContainText('current version is still available', { timeout: 20000 });
  await expect(page.locator('body')).toHaveAttribute('data-release', 'A');
  await expect(page.locator('#new-source')).toBeEnabled();
});

test('startup deadlines cancel blocked locks and recovery survives a broken main module', async ({ page, context, site }) => {
  const holder = await context.newPage(); await holder.goto(site.url + '/blank');
  await holder.evaluate(() => { void navigator.locks.request(`tasm-client:${location.origin}/`, () => new Promise(() => {})); });
  await expect.poll(() => holder.evaluate(async () => (await navigator.locks.query()).held?.length)).toBe(1);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('deadline-tested')) return;
    const native = window.setTimeout;
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: any[]) => native(fn, delay === 60000 ? 2000 : delay === 10000 ? 300 : delay, ...args)) as typeof setTimeout;
  });
  await page.goto(site.url + '/');
  await expect(page.locator('#startup-message')).toContainText('timed out', { timeout: 10000 });
  expect(await page.evaluate(async () => (await navigator.locks.query()).pending?.length)).toBe(0);
  await holder.close();
  await page.evaluate(() => sessionStorage.setItem('deadline-tested', '1'));
  site.failure = 'module'; await page.reload();
  await expect(page.locator('#startup-notice')).toBeVisible();
  await expect(page.locator('#reset-playpen')).toBeEnabled();
  site.failure = '';
  await page.locator('#reset-playpen').click();
  await Promise.all([page.waitForEvent('load'), page.locator('#reset-confirm').click()]);
  await ready(page);
});

test('Reset works while the runtime is stuck opening storage', async ({ page, site }) => {
  await page.addInitScript(() => {
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(data, transfer) {
      if (data.type === 'init' && !sessionStorage.getItem('blocked-init-once')) {
        sessionStorage.setItem('blocked-init-once', '1'); return;
      }
      post.call(this, data, transfer as Transferable[]);
    };
  });
  await page.goto(site.url + '/');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('blocked-init-once'))).toBe('1');
  await expect(page.locator('#new-source')).toBeDisabled();
  await page.locator('#reset-playpen').click();
  await Promise.all([page.waitForEvent('load'), page.locator('#reset-confirm').click()]);
  await ready(page);
  await expect(page.locator('#source-title')).toHaveText('No source yet');
});

test('demo applies its update without changing an open Playpen store', async ({ page, context, site, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 240000 : 90000);
  const playpen = await context.newPage(); await playpen.goto(site.url + '/'); await ready(playpen); const kept = await seed(playpen);
  await page.bringToFront();
  await page.goto(site.demoURL + '/'); await ready(page);
  const media = await seed(page, '/');
  site.release = 'B'; await installUpdate(page); await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-release', 'B', { timeout: 60000 }); await ready(page);
  expect(await page.evaluate(async url => (await fetch(url)).text(), media)).toBe('keep these media bytes');
  await playpen.bringToFront();
  expect(await playpen.evaluate(async url => (await fetch(url)).text(), kept)).toBe('keep these media bytes');
});

test('Reset is available after workspace loading fails with a healthy runtime', async ({ page, site }) => {
  await page.addInitScript(() => {
    const native = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/api/flows') && !sessionStorage.getItem('failed-workspace-once')) {
        sessionStorage.setItem('failed-workspace-once', '1'); return Promise.reject(new Error('Injected workspace loading failure'));
      }
      return native(input, init);
    };
  });
  await page.goto(site.url + '/');
  await expect(page.locator('#startup-message')).toContainText('Injected workspace loading failure', { timeout: 60000 });
  await expect(page.locator('#reset-playpen')).toBeEnabled();
  await page.locator('#reset-playpen').click(); await page.locator('#reset-confirm').click();
  await ready(page); await expect(page.locator('#source-title')).toHaveText('No source yet');
});

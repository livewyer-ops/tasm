import { test, expect, ready as waitForApp, named } from './fixtures';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  await waitForApp(page);
  await expect(page.locator('#reset-playpen')).toBeEnabled();
}
async function reset(page: Page) {
  await page.locator('#reset-playpen').click();
  await expect(page.locator('#reset-cancel')).toBeFocused();
  await page.locator('#reset-confirm').click();
}
async function resetAndReload(page: Page) {
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), reset(page)]);
}
async function empty(page: Page) {
  await ready(page);
  await expect(page.locator('#source-title')).toHaveText('No source yet');
  await expect(page.locator('#sample-count')).toHaveText('40');
  await expect(page.locator('#flow-count')).toHaveText('0 flows');
  await expect(page.locator('#storage-count')).toHaveText('0 objects');
  await expect(page.locator('#activity-summary')).toHaveText('No actions yet.');
  await expect(page.locator('#zoom-label')).toHaveText('100%');
  await expect(page.locator('#playhead-time')).toHaveText('00:00.000');
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), files = await root.getDirectoryHandle('tasm-%2F');
    const names = []; for await (const name of files.keys()) names.push(name); return names;
  })).toEqual([]);
}

test('an unsupported sample library stays intact until Reset', async ({ page }) => {
  await page.route('**/blank', route => route.fulfill({ contentType: 'text/html', body: '' }));
  await page.goto('/blank');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('tasm-playpen-library', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('samples', { keyPath: 'id' });
      request.result.createObjectStore('media').put('saved bytes', 'sample');
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }));
  await page.goto('/'); await ready(page);
  await expect(page.locator('#library-status')).toContainText('Unsupported sample library version');
  const saved = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('tasm-playpen-library');
    open.onsuccess = () => {
      const db = open.result, read = db.transaction('media').objectStore('media').get('sample');
      read.onsuccess = () => { db.close(); resolve([db.version, read.result]); };
      read.onerror = () => reject(read.error);
    };
    open.onerror = () => reject(open.error);
  }));
  expect(saved).toEqual([1, 'saved bytes']);
  await resetAndReload(page); await empty(page);
  await expect(page.locator('#import-media')).toBeEnabled();
});

test('playback reads are grouped, reviewed and cached without stealing manual selection', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 360000 : 180000);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/'); await ready(page);
  await named(page, '#new-source', 'Playback'); await named(page, '#add-video', 'Picture');
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready(page);
  // The preview reads saved media and keeps reading ahead after it is ready.
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview', { timeout: 60000 });
  await expect(page.locator('#action-history option:checked')).toHaveText('Playback', { timeout: 60000 });
  const playback = page.locator('#action-history option').filter({ hasText: /^Playback$/ });
  await expect(playback).toHaveCount(1);
  await expect(page.locator('#request-detail')).toContainText('reads ahead');
  const id = await playback.getAttribute('value');
  const count = Number(await page.locator('#request-count').textContent());
  expect(count).toBeGreaterThan(1);
  const objects = await page.locator('#objects button[data-object]').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.object));
  await page.locator('#review-requests').click();
  await expect(page.locator('#review-detail')).toContainText('Flow ID');
  await expect(page.locator('#review-detail')).toContainText('Flow time range');
  await expect(page.locator('#review-detail')).toContainText(objects[0]!);
  await page.locator('#review-next').click();
  await expect(page.locator('#review-position')).toHaveText(`Call 2 of ${count}`);
  await page.keyboard.press('Escape');
  await page.locator('#action-history').selectOption({ label: 'Save draft' });
  await page.locator('#requests button').first().click();
  const inspected = await page.locator('#requests .selected').getAttribute('data-request');
  await page.evaluate(() => {
    const actual = window.fetch; (window as any).playbackFetches = [];
    window.fetch = (input, init) => { (window as any).playbackFetches.push(String(input)); return actual(input, init); };
  });
  await page.locator('video').scrollIntoViewIfNeeded();
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); });
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 25000 }).toBeGreaterThan(0.3);
  // The timeline playhead follows playback under the site policy instead of waiting for it to stop.
  await expect.poll(() => page.evaluate(() => {
    const video = document.querySelector('video')!;
    return !video.paused && !video.ended && document.getElementById('playhead-time')!.textContent !== '00:00.000';
  })).toBe(true);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.locator('#action-history option:checked')).toHaveText('Save draft');
  await expect(page.locator('#requests .selected')).toHaveAttribute('data-request', inspected!);
  expect(await page.evaluate(() => (window as any).playbackFetches)).toEqual([]);
  await page.locator('#action-history').selectOption(id!);
  await expect(page.locator('#request-count')).toHaveText(String(count));
  await expect(playback).toHaveCount(1);
});

test('confirmed reset stops playback and clears Playpen but preserves Demo and unrelated storage', async ({ page, context, demoURL, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/'); await ready(page);
  await named(page, '#new-source', 'First');
  const firstId = await page.locator('#sources').inputValue();
  await named(page, '#new-source', 'Second'); await named(page, '#add-video', 'Picture');
  const secondId = await page.locator('#sources').inputValue();
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready(page);
  const buffer = await readFile(`${process.env.TASM_DIST ?? 'dist'}/playpen/samples/orbit.ts`);
  await page.locator('#media-file').setInputFiles({ name: 'Saved.ts', mimeType: 'video/mp2t', buffer });
  await expect(page.locator('#sample-count')).toHaveText('41');
  const demo = await context.newPage(); await demo.goto(demoURL);
  await expect(demo.locator('#primary')).toBeEnabled({ timeout: 90000 });
  await demo.locator('#primary').click(); await expect(demo.locator('#step-title')).toHaveText('Step 2. Add a video flow', { timeout: 60000 });
  const demoFlows = await demo.evaluate(async () => (await (await fetch('/api/flows')).json()));
  expect(demoFlows.length).toBeGreaterThan(0);

  await page.bringToFront();
  await page.evaluate(async ids => {
    for (const id of ids) localStorage.setItem(`tasm-preview:${id}`, '{"video":"","audio":""}');
    localStorage.setItem('unrelated-preference', 'keep'); localStorage.setItem('tasm-preview:demo-sentinel', 'keep');
    await (await caches.open('unrelated-cache')).put('/unrelated', new Response('keep'));
    const root = await navigator.storage.getDirectory(), file = await root.getFileHandle('unrelated-sentinel', { create: true });
    const writer = await file.createWritable(); await writer.write('keep'); await writer.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('unrelated-sentinel');
      request.onupgradeneeded = () => request.result.createObjectStore('keep');
      request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error);
    });
  }, [firstId, secondId]);
  await page.locator('#zoom-in').click(); await page.locator('[data-filter="audio"]').click();
  await page.locator('#reset-playpen').click(); await page.keyboard.press('Escape');
  await expect(page.locator('#reset-playpen')).toBeFocused(); await expect(page.locator('#source-title')).toHaveText('Second');
  await page.locator('video').evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play(); });
  await resetAndReload(page); await empty(page);
  expect(await page.evaluate(ids => ids.map(id => localStorage.getItem(`tasm-preview:${id}`)), [firstId, secondId])).toEqual([null, null]);
  expect(await page.evaluate(async () => ({
    preference: localStorage.getItem('unrelated-preference'), demoPreference: localStorage.getItem('tasm-preview:demo-sentinel'),
    file: await (await (await navigator.storage.getDirectory()).getFileHandle('unrelated-sentinel')).getFile().then(f => f.text()),
    cached: await (await (await caches.open('unrelated-cache')).match('/unrelated'))?.text(),
    databases: (await indexedDB.databases()).map(d => d.name), caches: await caches.keys(),
  }))).toMatchObject({ preference: 'keep', demoPreference: null, file: 'keep', cached: 'keep', databases: expect.arrayContaining(['unrelated-sentinel']), caches: expect.arrayContaining([expect.stringContaining('tasm-assets:')]) });
  await demo.bringToFront(); await demo.reload();
  await expect(demo.locator('#primary')).toBeEnabled({ timeout: 90000 });
  expect(await demo.evaluate(async () => (await (await fetch('/api/flows')).json()))).toEqual(demoFlows);
  await page.bringToFront(); await page.reload(); await empty(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const button = await page.locator('#reset-playpen').boundingBox(), status = await page.locator('#runtime-status').boundingBox();
    expect(button!.x + button!.width).toBeLessThanOrEqual(width);
    expect(Math.abs((button!.y + button!.height / 2) - (status!.y + status!.height / 2))).toBeLessThan(2);
  }
});

test('reset refuses another tab and holds new tabs out through a failed cleanup and retry', { tag: '@pr' }, async ({ page, context }) => {
  test.setTimeout(180000);
  await page.goto('/'); await ready(page); await named(page, '#new-source', 'Keep until confirmed');
  const second = await context.newPage(); await second.goto('/'); await ready(second);
  await reset(page); await expect(page.locator('#reset-status')).toContainText('Close other tabs using this site');
  await expect(page.locator('#reset-cancel')).toBeDisabled();
  await expect(second.locator('#source-title')).toHaveText('Keep until confirmed');
  await second.close();
  await page.evaluate(() => {
    const original = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.deleteDatabase = function (name) {
      if (name === 'tasm-playpen-library') { IDBFactory.prototype.deleteDatabase = original; throw new Error('Injected deletion failure'); }
      return original.call(this, name);
    };
  });
  await page.locator('#reset-confirm').click();
  await expect(page.locator('#reset-status')).toContainText('Injected deletion failure', { timeout: 60000 });
  await expect(page.locator('#reset-status')).toContainText('Reset has not completed');
  await expect(page.locator('#reset-cancel')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#reset-dialog')).toBeVisible();
  const arriving = await context.newPage(); await arriving.goto('/');
  await expect(arriving.locator('#new-source')).toBeDisabled();
  await expect(arriving.locator('#import-media')).toBeDisabled();
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.locator('#reset-confirm').click()]); await empty(page); await empty(arriving);
});

test('reset cancels a library worker and an ingest paused before a write', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/'); await ready(page);
  await page.evaluate(() => {
    const real = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (data, transfer) {
      if (data.file) return;
      Reflect.apply(real, this, [data, transfer]);
    };
  });
  await page.locator('#media-file').setInputFiles({ name: 'Waiting.ts', mimeType: 'video/mp2t', buffer: Buffer.from('pending') });
  await expect(page.locator('#import-cancel')).toBeVisible();
  await resetAndReload(page); await empty(page);
  await named(page, '#new-source', 'Cancelled ingest'); await named(page, '#add-video', 'Picture');
  await page.locator('#ingest-controls > summary').click(); await page.locator('#save-options > summary').click(); await page.locator('#step-through').check();
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click();
  await expect(page.locator('#ingest-title')).toContainText('paused', { timeout: 30000 });
  await resetAndReload(page); await empty(page);
});

test('reset stops a stuck streaming media write without waiting for it to finish', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const NativeWorker = SharedWorker;
    window.SharedWorker = class extends NativeWorker {
      constructor(url: string | URL, options?: string | WorkerOptions) {
        super(url, options); (window as any).testTasmWorker = this;
      }
    };
  });
  await page.goto('/'); await ready(page);
  await named(page, '#new-source', 'Streaming upload'); await named(page, '#add-video', 'Picture');
  await page.evaluate(async () => {
    const rootId = (document.getElementById('sources') as HTMLSelectElement).value;
    const root = await (await fetch(`/api/flows/${rootId}`)).json();
    const allocation = await (await fetch(`/api/flows/${root.flow_collection[0].id}/storage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ object_ids: [crypto.randomUUID()] }),
    })).json();
    const put = allocation.media_objects[0].put_url;
    // Exercise the real worker's chunk protocol with an upload deliberately held open.
    const worker = (window as any).testTasmWorker as SharedWorker;
    const channel = new MessageChannel(); let sent = false;
    await new Promise<void>(resolve => {
      channel.port1.onmessage = ({ data }) => {
        if (data.type === 'pull') {
          if (sent) { resolve(); return; }
          sent = true; const chunk = new Uint8Array(65536);
          channel.port1.postMessage({ type: 'chunk', chunk, done: false }, [chunk.buffer]);
        } else if (data.type === 'response') channel.port1.close();
      };
      worker.port.postMessage({ type: 'tasm-request', base: `${location.origin}/`, method: 'PUT', url: put.url,
        headers: { 'content-type': put['content-type'] } }, [channel.port2]);
    });
  });
  await resetAndReload(page);
  await empty(page);
});

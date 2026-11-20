import { test, expect as browserExpect } from './fixtures';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const expect = browserExpect.configure({ timeout: 90000 });
async function ready(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const timeout = test.info().project.name === 'webkit' ? 180000 : 90000;
  await expect(page.locator('body')).not.toHaveClass(/busy/, { timeout });
}
async function named(page: Page, button: string, label: string) {
  await page.locator(button).click(); await page.locator('#entity-name').fill(label); await page.locator('#dialog-submit').click();
  await expect(page.locator('#name-dialog')).not.toBeVisible(); await ready(page);
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const root = await (await fetch(`/api/flows/${(document.getElementById('sources') as HTMLSelectElement).value}`)).json();
    return { root, lanes: await Promise.all(root.flow_collection.map(async ({ id }: { id: string }) => ({ flow: await (await fetch(`/api/flows/${id}`)).json(), segments: await (await fetch(`/api/flows/${id}/segments`)).json() }))) };
  });
}
async function place(page: Page, id: string, time = 0) {
  const clips = page.locator('.clip');
  const before = await clips.count();
  await page.locator(`[data-sample="${id}"]`).click(); await page.locator('#add-sample').click();
  await expect(clips).toHaveCount(before + 1);
  if (time) { await page.locator('#block-start').fill(String(time)); await page.locator('#move-block').click(); }
  await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally');
}
async function save(page: Page) {
  await page.locator('#save-draft').click(); await ready(page);
  if ((await page.locator('#draft-status').textContent()) !== 'All changes saved') throw new Error(`Save failed: ${await page.locator('#notice-text').textContent()}`);
  await expect(page.locator('#draft-status')).toHaveText('All changes saved');
}
async function watch(page: Page) {
  await page.evaluate(() => {
    const real = window.fetch; (window as any).writes = [];
    window.fetch = (input, init) => {
      if (init?.method && !['GET', 'HEAD'].includes(init.method)) (window as any).writes.push({ url: String(input), method: init.method });
      return real(input, init);
    };
  });
}

test('speech drafts persist without writes, Save publishes once, and failures retain a retryable arrangement', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 720000 : 300000);
  await page.setViewportSize({ width: 1600, height: 1100 }); await page.goto('/'); await ready(page);
  await expect(page.locator('#sample-count')).toHaveText('40');
  await page.locator('[data-filter="speech"]').click(); await expect(page.locator('.sample-card')).toHaveCount(32);
  await expect(page.locator('[data-sample="speech-08-want"]')).toContainText('want');
  await expect(page.locator('[data-sample="speech-08-want"] svg')).toBeVisible();
  await named(page, '#new-source', 'Speech workshop'); await watch(page); await named(page, '#add-audio', 'Words');
  await place(page, 'speech-01-i', 2); await place(page, 'speech-08-want', 1); await place(page, 'speech-17-more');
  await expect(page.locator('.clip')).toHaveCount(3);
  await expect(page.locator('.flow-id')).toHaveText('Unsaved flow');
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  expect((await state(page)).root.flow_collection).toEqual([]);
  await expect(page.locator('#preview-empty')).toBeVisible(); await expect(page.locator('#storage-count')).toHaveText('0 objects');
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(3);
  await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally');
  await page.locator('#segments-tab').click(); await expect(page.locator('.clip')).toHaveCount(3);
  await watch(page); await save(page);
  const first = await state(page); expect(first.lanes[0].segments).toHaveLength(3);
  expect((await page.evaluate(() => (window as any).writes)).filter((w: any) => w.url.endsWith('/flow_collection'))).toHaveLength(1);
  await expect(page.locator('.flow-id')).toHaveText(first.lanes[0].flow.id.slice(0, 8));
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; }); await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.locator('#range-start').fill('0'); await page.locator('#range-end').fill('2.4'); await page.locator('#read-range').click(); await ready(page);
  await expect(page.locator('.range-results tbody tr')).toHaveCount(3); await expect(page.locator('#range-result')).toContainText(first.lanes[0].segments[0].object_id);
  await page.locator('#range-api').click(); await expect(page.locator('#review-action option:checked')).toHaveText('Read time range'); await page.keyboard.press('Escape');
  // Several local changes still produce one replacement and no media uploads on Save.
  await page.locator('.clip').last().click(); await page.locator('#block-start').fill('4'); await page.locator('#move-block').click();
  await page.locator('#block-start').fill('5'); await page.locator('#move-block').click();
  expect((await state(page)).root.flow_collection).toEqual(first.root.flow_collection);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith('/segments') && init?.method === 'POST') { window.fetch = real; return Promise.resolve(Response.json({ summary: 'Injected Save failure' }, { status: 503 })); }
      return real(input, init);
    };
  });
  await page.locator('#save-draft').click(); await ready(page); await expect(page.locator('#notice')).toContainText('Draft retained');
  await expect(page.locator('.clip').last()).toHaveAttribute('aria-label', 'I · 1 at 5.00 seconds');
  expect((await state(page)).root.flow_collection).toEqual(first.root.flow_collection);
  await watch(page); await page.locator('#retry-action').click(); await ready(page); await expect(page.locator('#draft-status')).toHaveText('All changes saved');
  const second = await state(page); expect(second.lanes[0].flow.id).not.toBe(first.lanes[0].flow.id);
  expect((await page.evaluate(() => (window as any).writes)).filter((w: any) => w.url.includes('/media/') && w.method === 'PUT')).toEqual([]);
  await expect(page.locator('.flow-transition')).toContainText('Deleted');
  // Discard restores timing without TAMS writes, including after reload.
  await page.locator('.clip').last().click(); await page.locator('#block-start').fill('6'); await page.locator('#move-block').click();
  await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally'); await page.reload(); await ready(page);
  await watch(page); await page.locator('#discard-draft').click(); await ready(page);
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]); expect((await state(page)).root.flow_collection).toEqual(second.root.flow_collection);
  // New flow + repeated word reuse the same object; default ASAP sends no deliberate pauses.
  await named(page, '#add-audio', 'Repeat'); await page.locator('[data-filter="speech"]').click(); await place(page, 'speech-01-i'); await watch(page); await save(page);
  const repeated = await state(page); expect(repeated.lanes).toHaveLength(2);
  expect(repeated.lanes[1].segments[0].object_id).toBe(second.lanes[0].segments.at(-1).object_id);
  expect((await page.evaluate(() => (window as any).writes)).filter((w: any) => w.url.includes('/media/') && w.method === 'PUT')).toEqual([]);
  // Step mode and cancellation keep the last saved source and the local edit.
  await page.locator('.lane-track').last().locator('.clip').click(); await page.locator('#block-start').fill('3'); await page.locator('#move-block').click();
  await page.locator('#ingest-controls').evaluate((el: HTMLDetailsElement) => el.open = true); await page.locator('#save-options > summary').click(); await page.locator('#step-through').check(); await page.locator('#save-draft').click();
  await expect(page.locator('#ingest-title')).toHaveText('Save draft · paused'); await page.locator('#ingest-cancel').click(); await ready(page);
  expect((await state(page)).root.flow_collection).toEqual(repeated.root.flow_collection); await expect(page.locator('#save-draft')).toBeEnabled();
  await page.locator('#asap').check(); await save(page);
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(4); await expect(page.locator('#draft-status')).toHaveText('All changes saved');
  if (browserName === 'chromium') await page.screenshot({ path: test.info().outputPath('draft-review.png'), fullPage: true });
});

test('short mono AAC imports measure packet bounds and reject incompatible placement without losing library media', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto('/'); await ready(page);
  await page.locator('#media-file').setInputFiles({ name: 'Short mono.m4a', mimeType: 'audio/mp4', buffer: await readFile('tests/media/short-mono.m4a') });
  await expect(page.locator('#library-status')).toContainText('Ready in the library');
  await named(page, '#new-source', 'Short AAC'); await named(page, '#add-audio', 'Mono');
  await page.getByRole('button', { name: 'Select Short mono.m4a audio sample', exact: true }).click(); await page.locator('#add-sample').click();
  await ready(page);
  const duration = await page.evaluate(() => new Promise<string>(resolve => {
    const req = indexedDB.open('tasm-playpen-library'); req.onsuccess = () => { const db = req.result, tx = db.transaction('samples'), get = tx.objectStore('samples').getAll(); tx.oncomplete = () => { db.close(); resolve(get.result[0].durationNs); }; };
  }));
  expect(BigInt(duration)).toBeLessThan(1000000000n);
  // Place adjacent copies at exact packet boundaries through edge snapping.
  const card = page.getByRole('button', { name: 'Select Short mono.m4a audio sample', exact: true }); await card.scrollIntoViewIfNeeded();
  const a = await card.boundingBox(), b = await page.locator('.lane-track').boundingBox();
  await page.mouse.move(a!.x + 20, a!.y + 20); await page.mouse.down(); await page.mouse.move(b!.x + Number(duration) / 1e9 * 26, b!.y + 35, { steps: 12 }); await page.mouse.up();
  await expect(page.locator('.clip')).toHaveCount(2); await save(page);
  const saved = await state(page); expect(saved.lanes[0].segments).toHaveLength(2);
  expect(saved.lanes[0].segments[1].timerange.split('_')[0].slice(1)).toBe(saved.lanes[0].segments[0].timerange.split('_')[1].slice(0, -1));
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; }); await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.8);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await named(page, '#add-audio', 'Stereo'); await page.locator('[data-sample="pulse"]').click(); await page.locator('#add-sample').click();
  await ready(page);
  await page.getByRole('button', { name: 'Select Short mono.m4a audio sample', exact: true }).click();
  await page.locator('#add-sample').click(); await expect(page.locator('#notice')).toContainText('1 channel'); await expect(page.locator('#notice')).toContainText('2 channels');
  await expect(page.locator('#sample-count')).toHaveText('41'); await expect(page.locator('.clip')).toHaveCount(3);
  await page.locator('#media-file').setInputFiles({ name: 'Bad.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('invalid media') });
  await expect(page.locator('#library-status.error')).toBeVisible(); await expect(page.locator('#sample-count')).toHaveText('41');
});

test('source navigation asks once, drafts can be saved or discarded, and changed lanes publish together', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 720000 : 300000);
  await page.setViewportSize({ width: 1600, height: 1100 }); await page.goto('/'); await ready(page);
  await named(page, '#new-source', 'First'); const firstId = await page.locator('#sources').inputValue();
  await named(page, '#new-source', 'Second'); const secondId = await page.locator('#sources').inputValue();
  await named(page, '#add-audio', 'Words'); await place(page, 'speech-01-i');
  await page.locator('#sources').selectOption(firstId); await expect(page.locator('#draft-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.locator('#sources')).toHaveValue(secondId); await expect(page.locator('#draft-dialog')).not.toBeVisible();
  await page.locator('#sources').selectOption(firstId); await page.locator('#draft-dialog button[value="save"]').click(); await ready(page);
  await expect(page.locator('#sources')).toHaveValue(firstId); await expect(page.locator('.clip')).toHaveCount(0);
  await page.locator('#sources').selectOption(secondId); await ready(page); await expect(page.locator('.clip')).toHaveCount(1);
  await named(page, '#add-video', 'Newsreader'); await page.locator('[data-filter="video"]').click(); await place(page, 'newsreader');
  await page.getByRole('button', { name: 'Select Words flow', exact: true }).click(); await page.locator('.clip.audio').click();
  await page.locator('#block-start').fill('2'); await page.locator('#move-block').click();
  await watch(page); await save(page); const both = await state(page);
  expect(both.lanes).toHaveLength(2); expect(both.lanes[1].flow.essence_parameters.frame_width).toBe(1920);
  const writes = await page.evaluate(() => (window as any).writes);
  expect(writes.filter((w: any) => w.url.endsWith('/flow_collection'))).toHaveLength(1);
  expect(writes.filter((w: any) => w.url.endsWith('/segments'))).toHaveLength(2);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; }); await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(10);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.locator('.clip.audio').click(); await page.locator('#block-start').fill('3'); await page.locator('#move-block').click();
  await page.locator('#sources').selectOption(firstId); await page.locator('#draft-dialog button[value="discard"]').click(); await ready(page);
  await expect(page.locator('#sources')).toHaveValue(firstId); await page.locator('#sources').selectOption(secondId); await ready(page);
  expect((await state(page)).root.flow_collection).toEqual(both.root.flow_collection); await expect(page.locator('#draft-status')).toHaveText('All changes saved');
  // An API change from another client cannot silently overwrite a draft's base.
  await page.locator('.clip.audio').click(); await page.locator('#block-start').fill('4'); await page.locator('#move-block').click();
  await page.evaluate(async id => { await fetch(`/api/flows/${id}/label`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify('Other tab') }); }, both.lanes[0].flow.id);
  await page.locator('#save-draft').click(); await ready(page); await expect(page.locator('#notice')).toContainText('changed in another tab');
  await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally');
  await page.locator('#discard-draft').click(); await ready(page); await expect(page.locator('.lane-header').first()).toContainText('Other tab');
});

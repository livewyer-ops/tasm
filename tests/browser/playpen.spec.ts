import { test, expect as browserExpect } from './fixtures';
import type { Page } from '@playwright/test';

// UI actions include durable WASM database writes, which take longer in WebKit.
const expect = browserExpect.configure({ timeout: 90000 });
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) console.log('Playpen failure state', await page.evaluate(() => ({ busy: document.body.className, ingest: document.getElementById('ingest-title')?.textContent, summary: document.getElementById('ingest-summary')?.textContent, notice: document.getElementById('notice-text')?.textContent, step: (document.getElementById('step-through') as HTMLInputElement)?.checked, request: document.getElementById('activity-summary')?.textContent })));
});

async function ready(page: Page) {
  const timeout = test.info().project.name === 'webkit' ? 180000 : 90000;
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).not.toHaveClass(/busy/, { timeout });
}
async function name(page: Page, value: string) {
  await page.locator('#entity-name').fill(value);
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#name-dialog')).not.toBeVisible();
  await ready(page);
}
async function source(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await ready(page);
  await expect(page.locator('#playpen-about')).not.toBeVisible();
  await page.getByRole('button', { name: 'About Playpen', exact: true }).click();
  await expect(page.locator('#playpen-about')).toContainText('experiment with arranging video and audio by time');
  await page.keyboard.press('Escape');
  await expect(page.locator('#playpen-about')).not.toBeVisible();
  await page.getByRole('button', { name: 'Create source', exact: true }).click();
  await name(page, 'Evening programme');
  await expect(page.locator('#source-title')).toHaveText('Evening programme');
}
async function lane(page: Page, kind: 'audio' | 'video', label: string) {
  await page.locator(`#add-${kind}`).click(); await name(page, label);
  await expect(page.getByRole('button', { name: `Select ${label} flow`, exact: true })).toBeVisible();
  await ready(page);
}
async function add(page: Page, sample: string) {
  const before = await page.locator('.clip').count();
  await page.getByRole('button', { name: new RegExp(`Select ${sample} .* sample`) }).click();
  await page.locator('#add-sample').click(); await page.locator('#save-draft').click();
  await expect(page.locator('.clip')).toHaveCount(before + 1, { timeout: 90000 });
  await ready(page);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview', { timeout: 90000 });
}
async function contents(page: Page) {
  return page.evaluate(async () => {
    const roots = await (await fetch('/api/flows?tag.tasm.playpen.kind=source')).json();
    const root = roots[0];
    const flows = await Promise.all(root.flow_collection.map(async ({ id }: { id: string }) => ({
      flow: await (await fetch(`/api/flows/${id}`)).json(), segments: await (await fetch(`/api/flows/${id}/segments`)).json(),
    })));
    return { root, flows };
  });
}

test('playpen edits real TAMS media, preserves failed edits and restores the source', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await source(page);
  await expect(page.locator('#preview-empty')).toBeVisible();
  await lane(page, 'video', 'Picture');
  await add(page, 'Orbit');
  const original = await contents(page);
  expect(original.root.format).toBe('urn:x-nmos:format:multi');
  expect(original.flows[0].segments.map((s: any) => s.timerange)).toEqual(['[0:0_2:0)', '[2:0_4:0)', '[4:0_6:0)', '[6:0_6:400000000)']);
  const objectId = original.flows[0].segments[0].object_id;
  await page.locator('.clip').first().click();
  await page.locator('#objects [data-object]').first().click();
  await expect(page.locator('#selected-object-id')).toHaveText(objectId);
  await page.locator('#follow-requests').click();
  await expect(page.locator('#follow-requests')).toHaveAttribute('aria-pressed', 'true');
  // Drag a second copy to 8 seconds, leaving a gap in the actual TAMS flow.
  await page.locator('#timeline-scroll').evaluate(el => el.scrollLeft = 0);
  await page.locator('[data-sample="orbit"]').dragTo(page.locator('.lane-track'), {
    sourcePosition: { x: 30, y: 30 }, targetPosition: { x: 8 * 26, y: 35 }, steps: 15
  });
  await expect(page.locator('.clip')).toHaveCount(2);
  await page.locator('#save-draft').click();
  await ready(page);
  const repeated = await contents(page);
  expect(repeated.flows[0].segments.map((s: any) => s.object_id)).toEqual([...original.flows[0].segments, ...original.flows[0].segments].map((s: any) => s.object_id));
  expect(repeated.flows[0].segments[4].timerange).toBe('[8:0_10:0)');
  // Native Omakase must decode through both repeated bytes and the gap.
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.muted = true; });
  await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(13);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(20);
  // Read-ahead can finish before Save draft, and cached playback makes no new requests.
  await expect(page.locator('#activity-summary')).toHaveText(/^(Playback|Save draft) · Done$/);
  const liveAction = await page.locator('#action-history').inputValue();
  const background = page.locator('#action-history option').filter({ hasText: 'Playback' }).first();
  await page.locator('#action-history').selectOption((await background.getAttribute('value'))!);
  await expect(page.locator('#activity-summary')).toHaveText('Playback · Done');
  await expect(page.locator('#requests .request-row.selected')).toContainText('GET');
  await expect(page.locator('#requests .request-row.selected .path')).toContainText('/media/');
  await expect(page.locator('#follow-requests')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#follow-requests').click();
  await expect(page.locator('#follow-requests')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#action-history')).toHaveValue(liveAction);
  // Starting in the empty gap still rejects an overlap with the following clip.
  await page.locator('.clip').first().click();
  await page.locator('#block-start').fill('7'); await page.locator('#move-block').click(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click();
  await expect(page.locator('#notice')).toContainText('cannot overlap'); await ready(page);
  expect((await contents(page)).root.flow_collection).toEqual(repeated.root.flow_collection);
  // Inject failure at publication, after replacement media has been registered.
  await page.evaluate(() => {
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/flow_collection') && init?.method === 'PUT') {
        window.fetch = realFetch;
        return Response.json({ summary: 'Injected publication failure' }, { status: 503 });
      }
      return realFetch(input, init);
    };
  });
  await page.locator('.clip').nth(1).click(); await page.locator('#block-start').fill('20'); await page.locator('#move-block').click(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click();
  await expect(page.locator('#notice')).toContainText('Injected publication failure'); await ready(page);
  expect((await contents(page)).root.flow_collection).toEqual(repeated.root.flow_collection);
  await page.locator('.clip').nth(1).click(); await page.locator('#block-start').fill('20'); await page.locator('#move-block').click(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click();
  await expect(page.locator('.clip').nth(1)).toHaveAttribute('aria-label', 'Orbit at 20.00 seconds', { timeout: 90000 }); await ready(page);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  const moved = await contents(page);
  expect(moved.flows[0].segments[4].object_id).toBe(objectId);
  expect(moved.flows[0].segments[4].ts_offset).toBe('20:0');
  await page.locator('.clip').nth(1).click(); await page.locator('#remove-block').click(); await page.locator('#save-draft').click();
  await expect(page.locator('.clip')).toHaveCount(1, { timeout: 90000 }); await ready(page);
  await expect(page.locator('#action-history')).toContainText('Draft: remove Orbit');
  await page.locator('#action-history').selectOption({ label: 'Save draft' });
  await page.locator('[data-request]').first().click();
  await expect(page.locator('#request-detail')).toContainText('/api/flows/');
  // An interrupted, unpublished flow is recovered through its ownership tag.
  await page.evaluate(async ({ root, flows }) => {
    const flow = flows[0].flow;
    const id = crypto.randomUUID();
    const response = await fetch(`/api/flows/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id, source_id: crypto.randomUUID(), label: 'Interrupted edit', format: flow.format, codec: flow.codec, container: flow.container, essence_parameters: flow.essence_parameters,
      tags: { 'tasm.playpen.root': [root.id], 'tasm.playpen.lane': [crypto.randomUUID()] },
    }) });
    if (!response.ok) throw new Error(await response.text());
  }, await contents(page));
  await page.reload(); await ready(page);
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#source-title')).toHaveText('Evening programme');
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/flows?label=Interrupted%20edit')).json()).length), { timeout: 15000 }).toBe(0);
  // Save a review image from the real running UI.
  if (browserName === 'chromium') await page.screenshot({ path: test.info().outputPath('playpen-review.png'), fullPage: true });
});

test('audio-only and video/audio source previews decode after upload failures and cross-flow moves', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  if (process.env.TASM_TRACE) page.on('response', response => {
    if (response.url().includes('/api/')) console.log(new Date().toISOString(), response.request().method(), new URL(response.url()).pathname, response.status());
  });
  await source(page); await lane(page, 'audio', 'Sound');
  // Failed object PUT must not publish a phantom block or replace the original lane.
  const empty = await contents(page);
  await page.evaluate(() => {
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes('/media/') && init?.method === 'PUT') {
        window.fetch = realFetch;
        return Response.json({ summary: 'Injected upload failure' }, { status: 507 });
      }
      return realFetch(input, init);
    };
  });
  await page.getByRole('button', { name: 'Select Soft pulse audio sample' }).click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click();
  await expect(page.locator('#notice')).toContainText('Injected upload failure'); await ready(page);
  expect((await contents(page)).root.flow_collection).toEqual(empty.root.flow_collection);
  await expect(page.locator('.clip')).toHaveCount(1);
  await page.locator('#retry-action').click(); await ready(page); await expect(page.locator('#preview-format')).toHaveText('Audio');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; });
  await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15000 }).toBeGreaterThan(0.5);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  // Return to zero before adding a video flow to the same source.
  await page.locator('.ruler').click({ position: { x: 0, y: 10 } });
  await lane(page, 'video', 'Picture'); await add(page, 'Signal grid');
  await expect(page.locator('#preview-format')).toHaveText('Video + audio');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; });
  await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames), { timeout: 15000 }).toBeGreaterThan(10);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await lane(page, 'audio', 'Alternative sound');
  const audio = page.locator('.clip').filter({ hasText: 'Soft pulse' });
  const target = page.locator('.lane-track').last();
  await page.locator('#timeline-scroll').evaluate(el => el.scrollLeft = 0);
  await audio.dragTo(target, {
    sourcePosition: { x: 8, y: 20 }, targetPosition: { x: 8, y: 35 }, steps: 15
  });
  await expect(target.locator('.clip')).toHaveCount(1);
  await page.locator('#save-draft').click();
  await ready(page);
  await expect(target.locator('.clip')).toHaveCount(1);
  await expect(page.locator('.lane-track').first().locator('.clip')).toHaveCount(0);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  await page.locator('.clip').filter({ hasText: 'Soft pulse' }).click(); await page.locator('#remove-block').click(); await page.locator('#save-draft').click(); await ready(page);
  await page.locator('.clip').filter({ hasText: 'Signal grid' }).click(); await page.locator('#remove-block').click(); await page.locator('#save-draft').click(); await ready(page);
  await expect(page.locator('.clip')).toHaveCount(0);
  await expect(page.locator('#preview-empty')).toBeVisible();
});

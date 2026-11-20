import { test, expect as browserExpect } from './fixtures';
import type { Page } from '@playwright/test';
import type { Block, Lane, Workspace } from '../../apps/shared/workspace-store';
import { build } from 'esbuild';
const expect = browserExpect.configure({ timeout: 90000 });

test('edge snapping uses screen distance, excludes the moving item and rejects illegal alignments', async () => {
  const bundle = await build({ entryPoints: ['apps/shared/workspace-store.ts'], bundle: true, format: 'iife', globalName: 'EditingTest', write: false, logLevel: 'silent' });
  const { snapPlacement, samples, NS, range } = new Function(bundle.outputFiles[0].text + '; return EditingTest;')() as typeof import('../../apps/shared/workspace-store');
  const sample = samples[0];
  const block = (key: string, start: bigint, end: bigint): Block => ({ key, start, sample, profile: 'test', checksum: sample.sha256, segments: [{ object_id: key, timerange: range(start, end) }] });
  const lane = (id: string, blocks: Block[]): Lane => ({ id, kind: 'video', flow: { id, source_id: 'source', format: sample.technical.format }, blocks, segments: blocks.flatMap(b => b.segments) });
  const target = lane('target', [block('one', 0n, 2n * NS)]), other = lane('other', [block('two', 5n * NS, 7n * NS)]);
  const workspace: Workspace = { root: target.flow, lanes: [target, other] };
  expect(snapPlacement(workspace, target, sample, 2110000000n, 2n * NS, 26, false).start).toBe(2n * NS);
  expect(snapPlacement(workspace, target, sample, 4900000000n, 2n * NS, 26, true).start).toBe(5n * NS);
  expect(snapPlacement(workspace, target, sample, 4900000000n, 2n * NS, 156, false).snapped).toBeUndefined();
  expect(snapPlacement(workspace, target, sample, 1100000000n, 2n * NS, 26, false).invalid).toBe(true);
  expect(snapPlacement(workspace, other, sample, 5100000000n, 2n * NS, 26, true, { laneId: 'other', key: 'two', segment: { objectId: 'two', timerange: '[5:0_7:0)' } }).snapped).toBeUndefined();
  expect(snapPlacement(workspace, target, sample, 86400n * NS, 2n * NS, 26, true).invalid).toBe(true);
});

async function ready(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  await expect(page.locator('body')).not.toHaveClass(/busy/);
}
async function named(page: Page, button: string, value: string) {
  await page.locator(button).click(); await page.locator('#entity-name').fill(value); await page.locator('#dialog-submit').click();
  await expect(page.locator('#name-dialog')).not.toBeVisible();
  if (button === '#new-source') await expect(page.locator('#source-title')).toHaveText(value);
  else await expect(page.getByRole('button', { name: `Select ${value} flow`, exact: true })).toBeVisible();
  await ready(page);
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const root = await (await fetch(`/api/flows/${(document.getElementById('sources') as HTMLSelectElement).value}`)).json();
    return { root, flows: await Promise.all(root.flow_collection.map(async ({ id }: { id: string }) => ({ flow: await (await fetch(`/api/flows/${id}`)).json(), segments: await (await fetch(`/api/flows/${id}/segments?include_object_timerange=true`)).json() }))) };
  });
}

test('both views edit the same stored segments, replace FLOWs and retain complete sample placement', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 720000 : 240000);
  await page.setViewportSize({ width: 1600, height: 1400 }); await page.goto('/'); await ready(page);
  await expect(page.locator('#flows-tab')).toHaveAttribute('aria-selected', 'true');
  await named(page, '#new-source', 'Segment workshop'); await named(page, '#add-video', 'Video 1');
  await page.evaluate(() => {
    const w = window as any, real = window.fetch; w.editWrites = [];
    window.fetch = async (input, init) => { if (init?.method && init.method !== 'GET') w.editWrites.push({ url: String(input), method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined }); return real(input, init); };
  });
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click();
  await expect(page.locator('#draft-status')).toContainText('Unsaved changes');
  await expect(page.locator('.clip')).toHaveCount(1); await ready(page);
  const original = await state(page), ids = original.flows[0].segments.map((s: any) => s.object_id);
  await expect(page.locator('.flow-id')).toHaveText(original.flows[0].flow.id.slice(0, 8));
  const writes = await page.evaluate(() => (window as any).editWrites);
  expect(writes.filter((w: any) => w.url.endsWith('/storage'))).toHaveLength(1);
  expect(writes.find((w: any) => w.url.endsWith('/storage')).body.object_ids).toHaveLength(4);
  expect(writes.filter((w: any) => w.url.endsWith('/segments'))).toHaveLength(1);
  // A nearby library drop snaps to the end of the first clip, even though 6.4s is not the pointer position.
  await page.locator('.lane-track').scrollIntoViewIfNeeded(); await page.locator('[data-sample="orbit"]').scrollIntoViewIfNeeded();
  await page.locator('#timeline-scroll').evaluate(el => el.scrollLeft = 0);
  const card = await page.locator('[data-sample="orbit"]').boundingBox(), track = await page.locator('.lane-track').boundingBox();
  await page.mouse.move(card!.x + 25, card!.y + 25); await page.mouse.down();
  await page.mouse.move(track!.x + 6.35 * 26, track!.y + 35, { steps: 12 });
  await expect(page.locator('.snap-guide')).toBeVisible({ timeout: 5000 }); await page.mouse.up(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click();
  await expect(page.locator('.clip')).toHaveCount(2); await ready(page);
  expect((await state(page)).flows[0].segments[4].timerange).toBe('[6:400000000_8:400000000)');
  await page.locator('.clip').nth(1).click(); await page.locator('#remove-block').click(); await page.locator('#save-draft').click(); await ready(page);
  await expect(page.locator('.clip')).toHaveCount(1);
  await page.locator('#segments-tab').click(); await expect(page.locator('.segment-clip')).toHaveCount(4);
  await page.locator('.segment-clip').nth(1).click(); await page.locator('#block-start').fill('12.123456789'); await page.locator('#move-block').click(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click(); await ready(page);
  const moved = await state(page);
  expect(moved.flows[0].segments.map((s: any) => s.object_id)).toEqual([ids[0], ids[2], ids[3], ids[1]]);
  expect(moved.flows[0].segments[3].timerange).toBe('[12:123456789_14:123456789)');
  expect(moved.flows[0].segments[3].object_timerange).toBe(original.flows[0].segments[1].object_timerange);
  expect(moved.flows[0].flow.id).not.toBe(original.flows[0].flow.id);
  await expect(page.locator('.flow-transition')).toContainText('Created → Published');
  await expect(page.locator('.flow-transition')).toContainText('Deleted');
  await page.locator('#walkthrough-requests').click();
  await page.locator('#review-action').selectOption({ label: 'Save draft' });
  await expect(page.locator('#review-requests-list')).toContainText('Reuse stored media');
  await expect(page.locator('#review-requests-list')).toContainText('Create replacement FLOW');
  await expect(page.locator('#review-requests-list')).toContainText('Publish flow collection');
  await page.keyboard.press('Escape');
  await named(page, '#add-video', 'Video 2');
  await page.locator('#timeline-scroll').evaluate(el => el.scrollLeft = 0);
  const item = await page.locator(`.segment-clip[data-object-id="${ids[1]}"]`).boundingBox(), destination = await page.locator('.lane-track').nth(1).boundingBox();
  await page.mouse.move(item!.x + 5, item!.y + 25); await page.mouse.down();
  await page.mouse.move(destination!.x + 6.1 * 26 + 5, destination!.y + 35, { steps: 12 }); await page.mouse.up(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click();
  await ready(page);
  await expect(page.locator('.lane-track').nth(1).locator('.segment-clip')).toHaveCount(1);
  const transferred = await state(page);
  expect(transferred.flows[0].segments.map((s: any) => s.object_id)).toEqual([ids[0], ids[2], ids[3]]);
  expect(transferred.flows[1].segments[0].object_id).toBe(ids[1]);
  expect(transferred.flows[1].segments[0].timerange).toBe('[6:0_8:0)');
  expect((await page.evaluate(() => (window as any).editWrites)).filter((w: any) => w.url.includes('/media/') && w.method === 'PUT')).toHaveLength(4);
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(3);
  await page.locator('#segments-tab').click(); await expect(page.locator('.segment-clip')).toHaveCount(4);
  // Every saved block is now partial; adding Orbit must still place all four segments.
  await page.getByRole('button', { name: 'Select Video 1 flow', exact: true }).click();
  await page.locator('#timeline-scroll').evaluate(el => el.scrollLeft = 0);
  const sample = await page.locator('[data-sample="orbit"]').boundingBox(), target = await page.locator('.lane-track').first().boundingBox();
  await page.mouse.move(sample!.x + 25, sample!.y + 25); await page.mouse.down();
  await page.mouse.move(target!.x + 20 * 26, target!.y + 35, { steps: 12 }); await page.mouse.up(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click();
  await expect(page.locator('.segment-clip')).toHaveCount(8); await ready(page);
  expect((await state(page)).flows[0].segments).toHaveLength(7);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; });
  await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
  // Slow preview/storage reads must not keep editing locked or overwrite a later edit.
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      const response = await real(input, init);
      if (String(input).includes('/media/') && (init?.method === 'GET' || init?.method === 'HEAD')) await new Promise(resolve => setTimeout(resolve, 2500));
      return response;
    };
  });
  await page.locator('.lane-track').first().locator('.segment-clip').last().click();
  await page.locator('#block-start').fill('30'); await page.locator('#move-block').click(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click(); await ready(page);
  await expect(page.locator('#move-block')).toBeEnabled();
  await page.locator('#block-start').fill('32'); await page.locator('#move-block').click(); if (await page.locator('#save-draft').isEnabled()) await page.locator('#save-draft').click(); await ready(page);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview');
  const final = await state(page);
  expect(final.flows[0].segments.at(-1).timerange).toBe('[32:0_32:400000000)');
  await expect(page.locator('#block-start')).toHaveValue('32.000000000');
  await expect(page.locator('#notice')).not.toBeVisible();
});

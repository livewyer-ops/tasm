import { test, expect, ready, dragToTime } from './fixtures';

test('unsaved insertion saves and reloads with shared media, and plays across both joins', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 360000 : 180000);
  await page.setViewportSize({ width: 1600, height: 1400 }); await page.goto('/');
  await ready(page);
  for (const [button, name] of [['#new-source', 'Insert example'], ['#add-video', 'Picture']]) {
    await page.locator(button).click(); await page.locator('#entity-name').fill(name); await page.locator('#dialog-submit').click(); await ready(page);
  }
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await ready(page);
  await page.locator('.clip').click(); await page.locator('#block-start').fill('10'); await page.locator('#move-block').click(); await ready(page);
  // Seek within the unsaved A; the source player has no saved duration yet, so use an actual drag.
  await dragToTime(page, page.locator('[data-sample="orbit"]'), page.locator('.lane-track'), 13.9, () => expect(page.locator('.drop-preview')).toContainText('Insert at 00:14.000')); await ready(page);
  await expect(page.locator('.clip')).toHaveCount(3);
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(3);
  await page.locator('#save-draft').click(); await ready(page);
  const read = () => page.evaluate(async () => {
    const root = await (await fetch(`/api/flows/${(document.getElementById('sources') as HTMLSelectElement).value}`)).json();
    return await (await fetch(`/api/flows/${root.flow_collection[0].id}/segments?include_object_timerange=true`)).json();
  });
  const segments = await read();
  expect(segments).toHaveLength(8);
  expect(new Set(segments.map((s: any) => s.object_id)).size).toBe(4);
  expect(segments[0].timerange).toBe('[10:0_12:0)');
  expect(segments[2].timerange).toBe('[14:0_16:0)');
  expect(segments[6].timerange).toBe('[20:400000000_22:400000000)');
  expect(segments[6].ts_offset).toBe('16:400000000');
  await page.reload(); await ready(page); expect(await read()).toEqual(segments);
  await expect(page.locator('#preview-status')).toContainText('Source ready', { timeout: 60000 });
  await page.locator('#range-start').fill('13'); await page.locator('#range-end').fill('22'); await page.locator('#read-range').click();
  await expect(page.locator('#play-range')).toBeEnabled({ timeout: 60000 }); await page.locator('#play-range').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30000 }).toBeGreaterThanOrEqual(21.95);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

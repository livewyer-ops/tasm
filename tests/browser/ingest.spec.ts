import { test, expect as browserExpect, save, ready, named, savedWorkspace, recordWrites } from './fixtures';
import type { Page } from '@playwright/test';
const expect = browserExpect.configure({ timeout: 60000 });
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/'); await ready(page);
  await named(page, '#new-source', 'Ingest laboratory'); await named(page, '#add-video', 'Picture');
  await expect(page.locator('#storage-title')).toHaveText('Media store');
  await expect(page.locator('#storage-summary')).toHaveText('No objects stored yet.');
  await expect(page.locator('#ingest-stages')).toHaveCount(0);
  await page.locator('#ingest-controls > summary').click();
  await recordWrites(page);
}
async function state(page: Page) { return { ...await savedWorkspace(page, true), writes: await page.evaluate(() => (window as any).writes) }; }
async function add(page: Page, id: string) { await page.locator(`[data-sample="${id}"]`).click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); }


test('step mode sends one write, groups real objects, reuses bytes and reads a bounded range', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 300000);
  await open(page); await page.locator('#storage > summary').click();
  await page.locator('#save-options > summary').click(); await page.locator('#step-through').check(); await add(page, 'orbit');
  await expect(page.locator('#ingest-title')).toHaveText('Save draft · paused');
  await expect(page.locator('#storage')).toHaveJSProperty('open', true);
  await expect(page.locator('#objects tbody tr')).toHaveCount(4);
  await expect(page.locator('#planned-request')).toContainText('not sent');
  expect((await state(page)).writes).toHaveLength(0);
  // One click executes exactly one write and pauses before the next operation.
  for (const count of [1, 2, 3, 4]) {
    await page.locator('#ingest-next').click();
    await expect.poll(async () => (await state(page)).writes.length).toBe(count);
    await expect(page.locator('#ingest-title')).toHaveText('Save draft · paused');
  }
  const paused = await state(page);
  expect(paused.writes.map((w: any) => w.method)).toEqual(['PUT', 'POST', 'PUT', 'POST']);
  expect(paused.writes[1].url).toMatch(/\/storage$/);
  expect(paused.writes[2].url).toContain('/media/');
  expect(paused.writes[3].url).toMatch(/\/segments$/);
  expect(paused.flows[0].segments).toHaveLength(0);
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#draft-status')).toContainText('Unsaved changes');
  await page.locator('#ingest-run').click(); await ready(page);
  await expect(page.locator('#ingest-title')).toHaveText('Save draft · complete');
  await expect(page.locator('#objects tr[data-state="stored"]')).toHaveCount(4);
  await expect(page.locator('#storage-summary')).toContainText('4 of 4 objects stored');
  await page.locator('#follow-requests').click();
  await expect(page.locator('#action-history option:checked')).toHaveText('Playback');
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('.clip .segment-mark')).toHaveCount(4);
  const original = await state(page);
  const ids = original.flows[0].segments.map((s: any) => s.object_id);
  expect(new Set(ids).size).toBe(4);
  const metadata = JSON.parse(original.flows[0].flow.tags['tasm.playpen.blocks.v1'][0]);
  expect(metadata.segments.map((s: any) => s.object_id)).toEqual(ids);
  // Reopening retains one movable block and its segment/object identity.
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#objects tr[data-state="stored"]')).toHaveCount(4);
  await expect(page.locator('#objects tbody td:nth-child(4)').first()).toContainText(' B');
  await page.locator('#ingest-controls > summary').click();
  if (!await page.locator('#asap').isVisible()) await page.locator('#save-options > summary').click();
  await page.locator('#asap').check();
  // Object reads can locate their timeline block after reopening, without an ingest session.
  await page.locator('#range-start').fill('0.5'); await page.locator('#range-end').fill('1.5'); await page.locator('#read-range').click();
  await expect(page.locator('#play-range')).toBeEnabled();
  await page.locator('#action-history').selectOption({ label: 'Read time range' });
  await page.locator('[data-request]').last().click();
  await expect(page.locator('.clip.selected')).toHaveCount(1);
  await expect(page.locator('#objects tr.selected [data-object]')).toHaveAttribute('data-object', ids[0]);
  await page.locator('.clip').click(); await page.locator('#block-start').fill('2'); await page.locator('#move-block').click(); await save(page); await ready(page);
  await expect(page.locator('#ingest-summary')).toContainText('4 reused · 0 bytes uploaded');
  const moved = await state(page);
  expect(moved.flows[0].segments.map((s: any) => s.object_id)).toEqual(ids);
  expect(JSON.parse(moved.flows[0].flow.tags['tasm.playpen.blocks.v1'][0]).id).toBe(metadata.id);
  expect(moved.flows[0].segments[0].timerange).toBe('[2:0_4:0)');
  await expect(page.locator('#objects tbody tr')).toHaveCount(4);
  await expect(page.locator('#objects [data-object]').first()).toHaveText(ids[0].split(':').at(-1));
  // Read overlaps two complete objects, although playback is only one second.
  await page.locator('#range-start').fill('3.5'); await page.locator('#range-end').fill('4.5'); await page.locator('#read-range').click();
  await expect(page.locator('#range-result')).toContainText('2 segments · 2 unique objects');
  await expect(page.locator('#action-history')).toHaveValue(await page.locator('#action-history option').filter({ hasText: 'Read time range' }).first().getAttribute('value') as string);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { (window as any).rangeStops = []; video.addEventListener('pause', () => (window as any).rangeStops.push(video.currentTime), { capture: true }); });
  await page.locator('#play-range').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(4.4);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => Math.abs(v.currentTime - 4.5))).toBeLessThanOrEqual(0.04);
  await expect.poll(() => page.evaluate(() => ((window as any).rangeStops as number[])
    .some(t => Math.abs(t - 4.5) <= 0.04))).toBe(true);
  const stopped = await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(Math.abs(stopped - 4.5)).toBeLessThanOrEqual(0.04);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.locator('#range-end').fill('5'); await expect(page.locator('#play-range')).toBeDisabled();
  const storedSummary = await page.locator('#storage-summary').textContent();
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (init?.method === 'HEAD') { window.fetch = real; return new Response(null, { status: 404 }); }
      return real(input, init);
    };
  });
  await page.locator('#storage-refresh').click();
  await expect(page.locator('#objects tr[data-state="missing"]')).toHaveCount(1);
  await expect(page.locator('#storage-summary')).toContainText('3 of 4 objects stored');
  await page.locator('#storage-refresh').click();
  await expect(page.locator('#storage-summary')).toHaveText(storedSummary!);
});

test('cancel and registration failure preserve the published source; lost publication responses are reconciled', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 300000);
  await open(page); const empty = await state(page);
  await page.locator('#save-options > summary').click(); await page.locator('#step-through').check(); await add(page, 'grid');
  await expect(page.locator('#ingest-title')).toContainText('paused');
  for (let i = 0; i < 3; i++) { await page.locator('#ingest-next').click(); await expect(page.locator('#ingest-next')).toBeEnabled(); }
  await expect(page.locator('#objects tbody tr').first()).toContainText('Stored');
  await page.locator('#ingest-cancel').click(); await ready(page);
  expect((await state(page)).root.flow_collection).toEqual(empty.root.flow_collection);
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#objects tbody tr')).toHaveCount(0);
  await expect(page.locator('#ingest-title')).toContainText('cancelled');
  await page.locator('#asap').check();
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/segments') && init?.method === 'POST') {
        window.fetch = real;
        const segments = JSON.parse(init.body as string);
        await real(input, { ...init, body: JSON.stringify(segments.slice(0, 1)) });
        return Response.json({ failed_segments: [{ object_id: segments[1].object_id, timerange: segments[1].timerange, error: { summary: 'Injected partial failure' } }] });
      }
      return real(input, init);
    };
  });
  await page.locator('#save-draft').click(); await expect(page.locator('#notice')).toContainText('partially failed'); await ready(page);
  expect((await state(page)).root.flow_collection).toEqual(empty.root.flow_collection);
  await expect(page.locator('.clip')).toHaveCount(1);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/segments') && init?.method === 'POST') { window.fetch = real; return Response.json({ summary: 'Injected registration failure' }, { status: 503 }); }
      return real(input, init);
    };
  });
  await page.locator('#save-draft').click(); await expect(page.locator('#notice')).toContainText('Injected registration failure'); await ready(page);
  expect((await state(page)).root.flow_collection).toEqual(empty.root.flow_collection);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      const result = await real(input, init);
      if (String(input).endsWith('/flow_collection') && init?.method === 'PUT') { window.fetch = real; throw new TypeError('Lost publication response'); }
      return result;
    };
  });
  await page.locator('#retry-action').click(); await ready(page);
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#ingest-title')).toContainText('complete');
  const recovered = await state(page);
  expect(recovered.flows[0].segments).toHaveLength(2);
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/flows')).json()).length)).toBe(2);
  // If the collection cannot be read after a lost response, neither old nor new flow may be deleted.
  await page.evaluate(rootId => {
    const real = window.fetch; let published = false;
    (window as any).unconfirmedDeletes = []; (window as any).restoreFetch = () => window.fetch = real;
    window.fetch = async (input, init) => {
      if (published && String(input).endsWith(`/flows/${rootId}`) && (!init?.method || init.method === 'GET')) return Response.json({ summary: 'Injected collection read failure' }, { status: 503 });
      if (init?.method === 'DELETE') (window as any).unconfirmedDeletes.push(String(input));
      const result = await real(input, init);
      if (String(input).endsWith('/flow_collection') && init?.method === 'PUT') { published = true; throw new TypeError('Lost publication response'); }
      return result;
    };
  }, recovered.root.id);
  await page.locator('.clip').click(); await page.locator('#block-start').fill('4'); await page.locator('#move-block').click(); await save(page, false);
  await expect(page.locator('#notice')).toContainText('Injected collection read failure'); await ready(page);
  await expect(page.locator('.flow-transition')).toContainText('Publication unconfirmed');
  expect(await page.evaluate(() => (window as any).unconfirmedDeletes)).toEqual([]);
  await page.evaluate(() => (window as any).restoreFetch());
  expect((await state(page)).flows[0].segments[0].timerange).toBe('[4:0_6:0)');
  await page.reload(); await ready(page); await expect(page.locator('.clip .segment-mark')).toHaveCount(2);
  await page.locator('#discard-draft').click(); await ready(page);
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/flows')).json()).length)).toBe(2);
});

test('switching workspaces discards a pending storage result', async ({ page, browserName }) => {
  if (browserName === 'webkit') test.slow();
  await open(page);
  await add(page, 'orbit');
  await ready(page);
  const stored = page.locator('#objects tr[data-state="stored"]');
  await expect(stored).toHaveCount(4);
  if (!await page.locator('#storage-refresh').isVisible()) await page.locator('#storage > summary').click();
  const original = await page.locator('#sources').inputValue();
  await named(page, '#new-source', 'Empty');
  const empty = await page.locator('#sources').inputValue();
  await page.locator('#sources').selectOption(original);
  await expect(page.locator('#storage-refresh')).toBeEnabled();

  const pending: (() => void)[] = [];
  await page.exposeFunction('holdStorageRead', () => new Promise<void>(resolve => pending.push(resolve)));
  await page.evaluate(() => {
    const real = window.fetch;
    let reads = 0;
    window.fetch = async (input, init) => {
      if (init?.method === 'HEAD' && String(input).includes('/media/') && ++reads <= 2) {
        const stale = reads === 1;
        await (window as typeof window & { holdStorageRead(): Promise<void> }).holdStorageRead();
        if (stale) return new Response(null, { status: 404 });
      }
      return real(input, init);
    };
  });
  await page.locator('#storage-refresh').click();
  await expect.poll(() => pending.length).toBe(1);
  await page.locator('#sources').selectOption(empty);
  await expect(page.locator('#source-title')).toHaveText('Empty');
  await page.locator('#sources').selectOption(original);
  await expect(page.locator('#source-title')).toHaveText('Ingest laboratory');
  pending[0]();
  await expect.poll(() => pending.length).toBe(2);
  await expect(stored).toHaveCount(4);
  pending[1]();
  await expect(page.locator('#storage-refresh')).toBeEnabled();
  await expect(stored).toHaveCount(4);
});

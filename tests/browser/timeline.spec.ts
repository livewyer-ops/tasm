import { expect } from './fixtures';
import { test, output, expectOutput } from './media-output';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  await expect(page.locator('body')).not.toHaveClass(/busy/, { timeout: test.info().project.name === 'webkit' ? 240000 : 90000 });
  await expect(page.locator('#preview-status')).toContainText('Source ready', { timeout: 60000 });
}

test('inserted video and audio decode before, within and after the inserted clips', async ({ page, browserName, audioOutput }) => {
  test.setTimeout(browserName === 'webkit' ? 720000 : 240000);
  await page.setViewportSize({ width: 1600, height: 1400 }); await page.goto('/');
  const idle = async () => {
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
    await expect(page.locator('body')).not.toHaveClass(/busy/, { timeout: 90000 });
  };
  const named = async (button: string, name: string) => {
    await page.locator(button).click(); await page.locator('#entity-name').fill(name); await page.locator('#dialog-submit').click(); await idle();
  };
  const add = async (sample: string) => {
    await page.locator(`[data-sample="${sample}"]`).click(); await page.locator('#add-sample').click(); await idle();
  };
  await idle(); await named('#new-source', 'Decoded insertion');
  await named('#add-video', 'Picture'); await add('bars');
  await named('#add-audio', 'Sound'); await add('chord');
  await page.locator('#save-draft').click(); await ready(page);
  await page.locator('#seek-time').fill('1.8'); await page.locator('#seek-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1.8, 1);
  await page.getByRole('button', { name: 'Select Picture flow', exact: true }).click(); await add('grid');
  await page.getByRole('button', { name: 'Select Sound flow', exact: true }).click(); await add('ping');
  await page.locator('#save-draft').click(); await ready(page);
  await page.reload(); await ready(page);
  const before = await output(page, 1, audioOutput), within = await output(page, 3, audioOutput), after = await output(page, 6, audioOutput);
  for (const result of [before, within, after]) { expect(result.brightness).toBeGreaterThan(10); expect(result.rms).toBeGreaterThan(0.001); }
  expect(Math.abs(before.brightness - within.brightness)).toBeGreaterThan(15);
  expect(Math.abs(before.brightness - after.brightness)).toBeLessThan(3);
});

test('source clock preserves offsets, empty intervals, tails and independent preview choices', async ({ page, browserName, audioOutput }) => {
  test.setTimeout(browserName === 'webkit' ? 720000 : 240000);
  await page.addInitScript(() => {
    (window as any).previewWrites = [];
    const fetch = window.fetch; window.fetch = (input, init) => { if (init?.method && !['GET', 'HEAD'].includes(init.method)) (window as any).previewWrites.push({ url: String(input), method: init.method }); return fetch(input, init); };
  });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  const seeded = await page.evaluate(async () => {
    const request = async (path: string, method = 'GET', body?: any) => {
      const response = await fetch(`/api/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(await response.text());
      const text = await response.text(); return text ? JSON.parse(text) : null;
    };
    const manifest = await (await fetch('/samples/manifest.json')).json();
    const root = { id: crypto.randomUUID(), source_id: crypto.randomUUID(), format: 'urn:x-nmos:format:multi', label: 'Timing laboratory', tags: { 'tasm.playpen.kind': ['source'] }, flow_collection: [] as any[] };
    await request(`flows/${root.id}`, 'PUT', root);
    const ids: Record<string, string> = {};
    const timestamp = (ns: bigint) => `${ns / 1000000000n}:${ns % 1000000000n}`;
    const lanes: [string, string, number[]][] = [['Picture zero', 'grid', [0, 6]], ['Sound two', 'ping', [2, 8]], ['Picture two', 'orbit', [2]], ['Sound zero', 'chord', [0]], ['Source tail', 'bars', [10]]];
    for (const [label, sampleId, starts] of lanes) {
      const sample = manifest.find((s: any) => s.id === sampleId), id = crypto.randomUUID(), laneId = crypto.randomUUID();
      ids[label] = laneId;
      await request(`flows/${id}`, 'PUT', { ...sample.technical, id, source_id: crypto.randomUUID(), label, tags: { 'tasm.playpen.root': [root.id], 'tasm.playpen.lane': [laneId] } });
      // Exercise new packet-segmented video/audio alongside unmodified legacy blocks.
      const segmented = sampleId === 'orbit' || sampleId === 'chord';
      const bytes = await (await fetch(`/samples/${sample.file}`)).arrayBuffer();
      const objects: { bytes: ArrayBuffer; start: string; end: string; id?: string }[] = segmented ? await new Promise((resolve, reject) => {
        const worker = new Worker('/ingest-worker.js', { type: 'module' });
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
        worker.onmessage = ({ data }) => { worker.terminate(); if (data.error) reject(new Error(data.error)); else resolve(data.objects); };
        worker.postMessage({ bytes, kind: sample.kind }, [bytes]);
      }) : [{ bytes, start: sample.startNs, end: String(BigInt(sample.startNs) + BigInt(sample.durationNs)) }];
      for (const object of objects) {
        object.id = `playpen:${root.source_id}:${sampleId}:${sample.sha256.slice(0, 12)}:${crypto.randomUUID()}`;
        const allocation = await request(`flows/${id}/storage`, 'POST', { object_ids: [object.id] });
        const uploaded = await fetch(allocation.media_objects[0].put_url.url, { method: 'PUT', body: object.bytes, headers: { 'content-type': 'video/mp2t' } });
        if (!uploaded.ok) throw new Error(await uploaded.text());
      }
      const groups = [];
      for (const start of starts) {
        const offset = BigInt(start) * 1000000000n - BigInt(sample.startNs), refs = [];
        for (const object of objects) {
          const segment = { object_id: object.id, timerange: `[${timestamp(BigInt(object.start) + offset)}_${timestamp(BigInt(object.end) + offset)})`, ts_offset: timestamp(offset) };
          await request(`flows/${id}/segments`, 'POST', { ...segment, ...(start === starts[0] ? { object_timerange: `[${timestamp(BigInt(object.start))}_${timestamp(BigInt(object.end))})` } : {}) });
          refs.push({ object_id: segment.object_id, timerange: segment.timerange });
        }
        groups.push(JSON.stringify({ id: crypto.randomUUID(), sample: sample.id, checksum: sample.sha256, profile: 'mediabunny-1.58.0/mpegts/hls-2s/v1', segments: refs }));
      }
      if (segmented) await request(`flows/${id}/tags/tasm.playpen.blocks.v1`, 'PUT', groups);
      root.flow_collection.push({ id, role: sample.kind });
    }
    await request(`flows/${root.id}/flow_collection`, 'PUT', root.flow_collection);
    localStorage.setItem(`tasm-playpen:selected:${location.pathname}`, root.id);
    return { root, ids };
  });
  await page.reload(); await ready(page);
  await expect(page.locator('#preview-video')).toHaveValue(seeded.ids['Picture zero']);
  await expect(page.locator('#preview-audio')).toHaveValue(seeded.ids['Sound two']);
  await expect(page.locator('#source-duration')).toHaveText('End 00:16.400');
  await expectOutput(page, 0.7, true, false, audioOutput);
  await expectOutput(page, 2.15, true, true, audioOutput);
  await expectOutput(page, 3.7, false, true, audioOutput);
  await expectOutput(page, 5.5, false, false, audioOutput);
  await expectOutput(page, 6.5, true, false, audioOutput);
  await expectOutput(page, 8.15, true, true, audioOutput);
  await expectOutput(page, 12, false, false, audioOutput);
  // Changing the editing lane never changes the preview pair.
  await page.getByRole('button', { name: 'Select Source tail flow', exact: true }).click();
  await expect(page.locator('#preview-video')).toHaveValue(seeded.ids['Picture zero']);
  const switchFlow = async (kind: string, label: string) => { await page.locator(`#preview-${kind}`).selectOption(seeded.ids[label] ?? ''); await ready(page); };
  await switchFlow('video', 'Picture two'); await switchFlow('audio', 'Sound zero');
  await expectOutput(page, 0.7, false, true, audioOutput);
  await expectOutput(page, 2.3, true, true, audioOutput);
  await expectOutput(page, 7, true, false, audioOutput);
  await switchFlow('audio', 'Sound two');
  await expectOutput(page, 0.7, false, false, audioOutput); // Both flows begin late.
  await switchFlow('video', 'none'); await expectOutput(page, 2.15, false, true, audioOutput);
  await switchFlow('video', 'Picture two'); await switchFlow('audio', 'none'); await expectOutput(page, 2.15, true, false, audioOutput);
  // Switching the preview while playing keeps both the source position and play state.
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; });
  await page.locator('omakase-play-button').click();
  const beforeSwitch = await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
  await switchFlow('video', 'none');
  const switched = await page.locator('video').evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime }));
  expect(switched.paused).toBe(false);
  expect(switched.time).toBeGreaterThanOrEqual(beforeSwitch - 0.08);
  expect(switched.time).toBeLessThan(beforeSwitch + 1.2);
  await switchFlow('video', 'Picture two');
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.reload(); await ready(page);
  await expect(page.locator('#preview-video')).toHaveValue(seeded.ids['Picture two']);
  await expect(page.locator('#preview-audio')).toHaveValue('');
  // No auto-seeking over empty time, including at a changed playback rate.
  await page.locator('#seek-time').fill('0.4'); await page.locator('#seek-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => !v.seeking && Math.abs(v.currentTime - 0.4) < 0.05), { timeout: 15000 }).toBe(true);
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.playbackRate = 2; v.muted = true; });
  // Pause on the first advancing frame, before a round trip to the test runner can span the gap.
  const [sample] = await Promise.all([page.waitForFunction(() => {
    const video = document.querySelector('video')!;
    if (!video.paused && video.currentTime > 0.5) {
      video.pause();
      return video.currentTime;
    }
  }, undefined, { timeout: 15000 }), page.locator('omakase-play-button').click()]);
  const time = await sample.jsonValue();
  expect(time).toBeGreaterThan(0.5); expect(time).toBeLessThan(1.7);
  // Preview generation must not add stored flows, segments or media objects.
  expect(await page.evaluate(async () => (await (await fetch('/api/flows')).json()).length)).toBe(6);
  expect(await page.evaluate(() => (window as any).previewWrites)).toEqual([]);
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#api-content')).toBeVisible();
    if (browserName === 'chromium') await page.screenshot({ path: `.local/workspace-${width}.png`, fullPage: true });
  }
  // Logical preview selection survives replacement of the edited physical flow.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.clip').filter({ hasText: 'Orbit' }).click();
  await page.locator('#block-start').fill('2.16'); await page.locator('#block-start').press('Enter');
  await expect(page.locator('.clip').filter({ hasText: 'Orbit' })).toHaveAttribute('aria-label', 'Orbit at 2.16 seconds', { timeout: 90000 }); await ready(page);
  await expect(page.locator('#preview-video')).toHaveValue(seeded.ids['Picture two']);
  await page.reload(); await ready(page);
  await expect(page.locator('#preview-video')).toHaveValue(seeded.ids['Picture two']);
  await expect(page.locator('#preview-audio')).toHaveValue('');

});

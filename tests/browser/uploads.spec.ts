import { test, expect, save, ready as waitForApp, named, savedWorkspace, dragToTime } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

let directory: string, video: Buffer, audio: Buffer;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tasm-upload-fixtures-'));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-itsoffset', '0.25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4',
    '-c:v', 'libx264', '-preset', 'fast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', join(directory, 'clip.mp4')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100',
    '-t', '3', '-c:a', 'aac', '-ac', '1', join(directory, 'sound.m4a')]);
  video = await readFile(join(directory, 'clip.mp4')); audio = await readFile(join(directory, 'sound.m4a'));
});
test.afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const clipName = 'My <clip>.mp4';
async function ready(page: Page) {
  await waitForApp(page);
  await expect(page.locator('#library-section')).toHaveAttribute('aria-busy', 'false');
}
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1400 }); await page.goto('/'); await ready(page);
  await expect(page.locator('#import-media')).toBeEnabled();
}
async function importClip(page: Page) {
  await page.locator('#media-file').setInputFiles({ name: clipName, mimeType: 'video/mp4', buffer: video });
  await expect(page.locator('#library-status')).toContainText('Ready in the library', { timeout: 30000 }); await ready(page);
}
const card = (page: Page, kind: string) => page.getByRole('button', { name: `Select ${clipName} ${kind} sample`, exact: true });
test('imported video and audio insert by reference while other flows keep their timing', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 480000 : 240000);
  await open(page); await importClip(page); await named(page, '#new-source', 'Imported insert'); await named(page, '#add-video', 'Picture');
  await card(page, 'video').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready(page);
  await named(page, '#add-audio', 'Sound'); await card(page, 'audio').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready(page);
  const original = await state(page), videoLane = original.find((l: any) => l.flow.format.endsWith(':video')), audioLane = original.find((l: any) => l.flow.format.endsWith(':audio'));
  await page.evaluate(() => {
    const real = window.fetch; (window as any).insertUploads = [];
    window.fetch = (input, init) => { if (init?.method === 'PUT' && String(input).includes('/media/')) (window as any).insertUploads.push(String(input)); return real(input, init); };
  });
  await page.locator('#segments-tab').click();
  await page.locator('.lane-track').first().evaluate((track, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'Inserted.mp4', { type: 'video/mp4' }));
    const rect = track.getBoundingClientRect(); track.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 1.4 * 26, clientY: rect.top + 35 }));
  }, [...video]);
  await expect(page.locator('#notice')).toContainText('Inserted at 00:02.000'); await ready(page);
  await page.locator('#save-draft').click(); await ready(page);
  const afterVideo = await state(page), editedVideo = afterVideo.find((l: any) => l.flow.format.endsWith(':video'));
  expect(afterVideo.find((l: any) => l.flow.format.endsWith(':audio'))).toEqual(audioLane);
  expect(editedVideo.segments.map((s: any) => s.object_id)).toEqual([videoLane.segments[0].object_id, ...videoLane.segments.map((s: any) => s.object_id), videoLane.segments[1].object_id]);
  expect(editedVideo.segments.at(-1).timerange).toBe('[6:0_8:0)');
  await expect(page.locator('#preview-status')).toContainText('Source ready', { timeout: 60000 });
  await page.locator('#seek-time').fill('1.4'); await page.locator('#seek-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1.4, 1);
  await page.getByRole('button', { name: 'Select Inserted.mp4 audio sample', exact: true }).click();
  await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready(page);
  const afterAudio = await state(page), editedAudio = afterAudio.find((l: any) => l.flow.format.endsWith(':audio'));
  expect(afterAudio.find((l: any) => l.flow.format.endsWith(':video'))).toEqual(editedVideo);
  expect(editedAudio.segments.map((s: any) => s.object_id)).toEqual([audioLane.segments[0].object_id, ...audioLane.segments.map((s: any) => s.object_id), ...audioLane.segments.slice(1).map((s: any) => s.object_id)]);
  expect(await page.evaluate(() => (window as any).insertUploads)).toEqual([]);
  await page.reload(); await ready(page); expect(await state(page)).toEqual(afterAudio);
});
test('files drop directly into both timeline views and leave unmatched tracks in the library', async ({ page }) => {
  test.setTimeout(240000);
  await open(page); await named(page, '#new-source', 'Direct import'); await named(page, '#add-video', 'Video 1');
  const drop = async (selector: string, name: string, buffer: Buffer, time: number) => {
    await page.locator(selector).evaluate((track, input) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(input.bytes)], input.name, { type: 'video/mp4' }));
      const rect = track.getBoundingClientRect(); track.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + input.time * 26, clientY: rect.top + 35 }));
    }, { name, bytes: [...buffer], time });
  };
  await drop('.lane-track', clipName, video, 0);
  await expect(page.locator('.pending-placement')).toContainText('importing');
  await expect(page.locator('.clip')).toHaveCount(1, { timeout: 90000 }); await ready(page);
  await page.locator('#save-draft').click(); await ready(page);
  const first = await state(page);
  expect(first).toHaveLength(1); expect(first[0].segments).toHaveLength(2);
  await expect(card(page, 'video')).toBeVisible(); await expect(card(page, 'audio')).toBeVisible();
  await page.locator('#walkthrough-requests').click();
  await page.locator('#review-action').selectOption({ label: `Import ${clipName}` });
  await expect(page.locator('#review-requests-list')).toContainText('Prepare imported media');
  await expect(page.locator('#review-requests-list')).toContainText('Save library samples');
  await page.locator('#review-action').selectOption({ label: 'Save draft' });
  await expect(page.locator('#review-requests-list')).toContainText('Upload media bytes');
  await page.keyboard.press('Escape');
  await page.locator('#segments-tab').click();
  await drop('.lane-track', clipName, video, 8);
  await expect(page.locator('#draft-status')).toContainText('Unsaved changes'); await page.locator('#save-draft').click(); await ready(page);
  await expect(page.locator('.segment-clip')).toHaveCount(4, { timeout: 90000 }); await ready(page);
  const second = await state(page);
  expect(second[0].segments.map((s: any) => s.object_id)).toEqual([...first[0].segments, ...first[0].segments].map((s: any) => s.object_id));
  // The audio file is imported but cannot be placed on a VIDEO channel.
  await drop('.lane-track', 'Sound only.m4a', audio, 16);
  await expect(page.locator('#library-status')).toContainText('matching track'); await ready(page);
  expect((await state(page))[0].segments).toHaveLength(4);
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(2);
});
const state = async (page: Page) => (await savedWorkspace(page)).flows;
async function watchApi(page: Page) {
  await page.evaluate(() => {
    const real = window.fetch; (window as any).apiCalls = [];
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
      if (['api/', 'media/'].some(prefix => url.startsWith(new URL(prefix, location.href).href))) {
        (window as any).apiCalls.push({ url, method: init?.method ?? (input instanceof Request ? input.method : 'GET') });
      }
      return real(input, init);
    };
  });
}
async function libraryCounts(page: Page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('tasm-playpen-library');
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['samples', 'media']);
      const samples = tx.objectStore('samples').count(), media = tx.objectStore('media').count();
      tx.oncomplete = () => { db.close(); resolve([samples.result, media.result]); };
    };
  }));
}
async function dragVideo(page: Page, start: number) {
  const sample = card(page, 'video'), track = page.locator('.lane-track').first();
  await sample.scrollIntoViewIfNeeded(); await track.scrollIntoViewIfNeeded();
  await page.locator('#timeline-scroll').evaluate(el => el.scrollLeft = 0);
  await dragToTime(page, sample, track, start); await save(page);
  await ready(page);
}

test('library imports stay separate and persistent until dragged or added to a flow', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await open(page); await watchApi(page);
  await importClip(page);
  await expect(card(page, 'video')).toBeVisible(); await expect(card(page, 'audio')).toBeVisible();
  await expect(page.locator('#sample-count')).toHaveText('42');
  expect(await libraryCounts(page)).toEqual([2, 2]);
  expect(await page.evaluate(() => (window as any).apiCalls)).toEqual([]);
  await expect(page.locator('#activity-summary')).toHaveText(`Import ${clipName} · Done`);
  await expect(page.locator('#request-count')).toHaveText('0');
  await expect(page.locator('#flow-count')).toHaveText('0 flows');
  await expect(page.locator('#storage-count')).toHaveText('0 objects');
  await expect(page.locator('#ingest-controls')).not.toHaveAttribute('open');
  await page.reload(); await ready(page); await expect(card(page, 'video')).toBeVisible();
  await watchApi(page);
  const transfer = await page.evaluateHandle(data => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'renamed.mp4', { type: 'video/mp4' })); return transfer;
  }, [...video]);
  await page.locator('#library-section').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('#library-status')).toContainText('Ready in the library'); await ready(page);
  expect(await libraryCounts(page)).toEqual([2, 2]);
  expect(await page.evaluate(() => (window as any).apiCalls)).toEqual([]);
  await importClip(page);
  await page.locator('#media-file').setInputFiles({ name: 'sound.m4a', mimeType: 'audio/mp4', buffer: audio });
  await expect(page.locator('#sample-count')).toHaveText('43'); await ready(page);
  await page.locator('[data-filter="audio"]').click(); await expect(page.locator('.sample-card')).toHaveCount(37);
  await page.locator('[data-filter="all"]').click();
  expect(await page.evaluate(() => (window as any).apiCalls)).toEqual([]);
  await named(page, '#new-source', 'My recordings'); await named(page, '#add-video', 'Picture');
  await dragVideo(page, 2); await expect(page.locator('.clip')).toHaveCount(1, { timeout: 90000 }); await ready(page);
  await named(page, '#add-audio', 'Sound'); await card(page, 'audio').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready(page);
  await expect(page.locator('.clip')).toHaveCount(2);
  const saved = await state(page), picture = saved.find((s: any) => s.flow.format.endsWith(':video')), sound = saved.find((s: any) => s.flow.format.endsWith(':audio'));
  expect(picture.flow.essence_parameters.frame_width).toBe(320);
  expect(picture.flow.essence_parameters.frame_rate.numerator / picture.flow.essence_parameters.frame_rate.denominator).toBe(30);
  expect(sound.flow.essence_parameters).toEqual({ sample_rate: 44100, channels: 1 });
  expect(picture.segments[0].timerange).toBe('[2:0_4:0)');
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', join(directory, 'clip.mp4')], { encoding: 'utf8' });
  const streams: { codec_type: string; start_time: string }[] = JSON.parse(probe).streams;
  const offset = Number(streams.find(s => s.codec_type === 'audio')!.start_time) - Number(streams.find(s => s.codec_type === 'video')!.start_time);
  const [, seconds, nanos] = /^\[(\d+):(\d+)_/.exec(sound.segments[0].timerange)!;
  expect(offset).toBeGreaterThan(0);
  expect(Math.abs(Number(seconds) + Number(nanos) / 1e9 - offset)).toBeLessThan(2 / 90000);
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; v.playbackRate = 4; });
  await page.locator('omakase-play-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20000 }).toBeGreaterThan(2.5);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(10);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.evaluate(() => { (window as any).apiCalls = []; });
  await dragVideo(page, 6); await expect(page.locator('.clip')).toHaveCount(3); await ready(page);
  const repeated = (await state(page)).find((s: any) => s.flow.format.endsWith(':video'));
  expect(repeated.segments.map((s: any) => s.object_id)).toEqual([...picture.segments, ...picture.segments].map((s: any) => s.object_id));
  expect(await page.evaluate(() => (window as any).apiCalls.filter((c: any) => c.method === 'PUT' && c.url.includes('/media/')))).toEqual([]);
  await expect(page.locator('#objects tr[data-state="stored"]')).toHaveCount(picture.segments.length + sound.segments.length);
  expect(await page.evaluate(() => (window as any).apiCalls.length)).toBeGreaterThan(0);
  const beforeRemoval = await state(page);
  await page.evaluate(() => { (window as any).apiCalls = []; });
  await page.getByRole('button', { name: `Remove ${clipName} video from library`, exact: true }).click();
  await expect(card(page, 'video')).toHaveCount(0); await ready(page);
  expect(await page.evaluate(() => (window as any).apiCalls)).toEqual([]);
  expect(await state(page)).toEqual(beforeRemoval);
  await page.reload(); await ready(page); await expect(page.locator('.clip')).toHaveCount(3);
  await page.locator('.clip.video').first().click(); await page.locator('#block-start').fill('1'); await page.locator('#move-block').click(); await save(page); await ready(page);
  const moved = (await state(page)).find((s: any) => s.flow.format.endsWith(':video'));
  expect(moved.segments[0].object_id).toBe(picture.segments[0].object_id);
  expect(moved.segments[0].timerange).toBe('[1:0_3:0)');
  await named(page, '#new-source', 'Another source');
  await expect(card(page, 'audio')).toBeVisible(); await expect(page.locator('#sample-count')).toHaveText('42');
  await expect(page.locator('#storage-count')).toHaveText('0 objects');
});

test('invalid, cancelled and quota-failed imports leave the library and TAMS unchanged', { tag: '@pr' }, async ({ page }) => {
  await open(page); await watchApi(page);
  for (const buffer of [Buffer.alloc(0), Buffer.from('not a media file')]) {
    await page.locator('#media-file').setInputFiles({ name: 'invalid.mp4', mimeType: 'video/mp4', buffer });
    await expect(page.locator('#library-status.error')).toBeVisible(); await ready(page);
    expect(await libraryCounts(page)).toEqual([0, 0]);
  }
  await page.evaluate(() => {
    const real = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message.file) { Worker.prototype.postMessage = real; return; }
      Reflect.apply(real, this, [message, transfer]);
    };
  });
  await page.locator('#media-file').setInputFiles({ name: clipName, mimeType: 'video/mp4', buffer: video });
  await page.locator('#import-cancel').click(); await expect(page.locator('#library-status')).toHaveText('Import cancelled.'); await ready(page);
  expect(await libraryCounts(page)).toEqual([0, 0]);
  await page.evaluate(() => {
    const real = IDBObjectStore.prototype.put; let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'media' && ++writes === 2) { IDBObjectStore.prototype.put = real; throw new DOMException('Injected storage limit', 'QuotaExceededError'); }
      return real.apply(this, args);
    };
  });
  await page.locator('#media-file').setInputFiles({ name: clipName, mimeType: 'video/mp4', buffer: video });
  await expect(page.locator('#library-status.error')).toContainText('storage is full'); await ready(page);
  expect(await libraryCounts(page)).toEqual([0, 0]);
  await expect(page.locator('#sample-count')).toHaveText('40');
  await expect(page.locator('#storage-count')).toHaveText('0 objects');
  expect(await page.evaluate(() => (window as any).apiCalls)).toEqual([]);
  await importClip(page); expect(await libraryCounts(page)).toEqual([2, 2]);
});

test('imported samples retain the existing ingest cancel and retry controls', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 360000 : 180000);
  await open(page); await importClip(page);
  await named(page, '#new-source', 'My recordings'); await named(page, '#add-video', 'Picture');
  await page.locator('#ingest-controls > summary').click(); await page.locator('#save-options > summary').click(); await page.locator('#step-through').check();
  await card(page, 'video').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click();
  await expect(page.locator('#ingest-title')).toContainText('paused', { timeout: 30000 });
  await page.locator('#ingest-cancel').click(); await ready(page);
  expect((await state(page))[0].segments).toEqual([]); expect(await libraryCounts(page)).toEqual([2, 2]);
  await page.locator('#asap').check();
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/segments') && init?.method === 'POST') {
        window.fetch = real; return Response.json({ summary: 'Injected registration failure' }, { status: 503 });
      }
      return real(input, init);
    };
  });
  await page.locator('#save-draft').click();
  await expect(page.locator('#notice')).toContainText('Injected registration failure', { timeout: 90000 }); await ready(page);
  expect((await state(page))[0].segments).toEqual([]); expect(await libraryCounts(page)).toEqual([2, 2]);
  await page.locator('#retry-action').click(); await expect(page.locator('.clip')).toHaveCount(1, { timeout: 90000 }); await ready(page);
  // Storage checks run in the background, one HEAD per object with a 10 s deadline each.
  await expect(page.locator('#objects tr[data-state="stored"]')).toHaveCount(2, { timeout: 30000 });
});

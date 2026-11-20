import { test, expect as browserExpect } from './fixtures';
const expect = browserExpect.configure({ timeout: 60000 });
import { ready, branding, state, advance, structure, example } from './demo-fixtures';
test.use({ app: 'demo' });

test('demo walks through real media, survives reload and preserves Playpen storage', async ({ page, context, browserName, playpenURL }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  // Keep Playpen open while using Demo: neither worker may take over the other.
  const playpen = await context.newPage(); await playpen.goto(playpenURL);
  await expect(playpen.locator('#new-source')).toBeEnabled({ timeout: 90000 });
  await playpen.locator('#new-source').click(); await playpen.locator('#entity-name').fill('Keep my Playpen work');
  await playpen.locator('#dialog-submit').click(); await expect(playpen.locator('#source-title')).toHaveText('Keep my Playpen work');
  const saved = await playpen.evaluate(async () => (await (await fetch('/api/flows')).json()));
  await page.bringToFront(); await page.setViewportSize({ width: 1280, height: 800 }); await page.goto('/'); await ready(page);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page).toHaveTitle('TAMS in Practice');
  await branding(page);
  await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await expect(page.locator('#explanation')).toContainText('A source identifies a piece of content');
  await expect(page.locator('#status')).toBeEmpty();
  await expect(page.locator('#source-state')).toBeEmpty();
  await expect(page.locator('#storage-summary')).toHaveText('No objects stored yet.');
  expect((await state(page)).roots).toHaveLength(0);
  await advance(page, 'Step 2. Add a video flow');
  await expect(page.locator('#explanation')).toContainText('A flow represents the content with a particular media format and timeline');
  await expect(page.locator('#status')).toHaveText('Source created. Next, add its video flow.');
  expect((await state(page)).roots).toHaveLength(1);
  expect((await state(page)).flows).toHaveLength(0);
  await expect(page.locator('#source-empty')).toBeHidden();
  await expect(page.locator('.source-heading')).not.toContainText('Orbit demonstration');
  await expect(page.locator('#flow')).toBeHidden();
  await advance(page, 'Step 3. Store the sample media');
  await expect(page.locator('#explanation')).toContainText('Store the 6.4-second sample as four media objects');
  await expect(page.locator('#status')).toHaveText('Video flow created. Next, store the sample media on its timeline.');
  expect((await state(page)).flows[0].segments).toHaveLength(0);
  await expect(page.locator('#flow')).toBeVisible();
  await expect(page.locator('#timeline-state')).toHaveText('Empty flow');
  await expect(page.locator('.flow-heading button, .flow-label:visible')).toHaveCount(0);
  // Hold real writes, rather than replacing the API: provisional state must be
  // inspectable before bytes arrive and before the new flow is published.
  await page.evaluate(() => {
    const real = window.fetch; let heldUpload = false;
    // Deliberately collide short suffixes: labels must remain distinguishable.
    const uuid = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = () => (uuid().slice(0, -6) + 'abcdef') as ReturnType<typeof crypto.randomUUID>;
    window.fetch = async (input, init) => {
      const upload = String(input).includes('/media/') && init?.method === 'PUT' && !heldUpload;
      const publication = String(input).endsWith('/flow_collection') && init?.method === 'PUT';
      if (upload || publication) {
        if (upload) heldUpload = true;
        (window as any).heldDemoPhase = upload ? 'upload' : 'publication';
        await new Promise<void>(resolve => { (window as any).releaseDemoRequest = resolve; });
        if (publication) window.fetch = real;
      }
      return real(input, init);
    };
  });
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => (window as any).heldDemoPhase), { timeout: browserName === 'webkit' ? 240000 : 60000 }).toBe('upload');
  await expect(page.locator('[data-piece]')).toHaveCount(4);
  await expect(page.locator('#timeline-state')).toContainText('not playable yet');
  await expect(page.locator('#playback-controls')).toBeHidden();
  await expect(page.locator('#requests .action[open]')).toContainText('Working · Store object for segment 1');
  await expect(page.locator('[data-piece="0"]')).toHaveAttribute('data-state', 'allocated');
  await expect(page.locator('#storage-objects tr')).toHaveCount(4);
  await expect(page.locator('#storage-objects tr').first()).toHaveAttribute('data-state', 'uploading');
  await expect(page.locator('#storage-summary')).toHaveText('0 of 4 objects stored · 0 bytes');
  const labels = await page.locator('.object-label').allTextContents();
  expect(new Set(labels).size).toBe(4);
  expect(labels.every(label => label.length > 6)).toBe(true);
  expect(await page.locator('#storage-objects button').allTextContents()).toEqual(labels);
  await expect(page.locator('[data-step="4"]')).toBeDisabled();
  await expect(page.locator('#primary')).toBeDisabled();
  const upload = page.locator('#requests .operations > li').filter({ hasText: 'Working · Store object for segment 1' });
  await upload.locator('summary').click();
  await expect(upload.locator('pre')).toContainText('"method": "PUT"');
  await page.locator('[data-piece="1"]').click();
  await expect(page.locator('#piece-description')).toContainText('Not ready to play yet');
  expect((await state(page)).flows[0].segments).toHaveLength(0);
  await page.evaluate(() => (window as any).releaseDemoRequest());
  await expect.poll(() => page.evaluate(() => (window as any).heldDemoPhase), { timeout: browserName === 'webkit' ? 240000 : 60000 }).toBe('publication');
  await expect(page.locator('[data-piece][data-state="registered"]')).toHaveCount(4);
  await expect(page.locator('#storage-objects tr[data-state="stored"]')).toHaveCount(4);
  await expect(page.locator('#storage-summary')).toContainText('4 of 4 objects stored');
  await expect(page.locator('#requests .operations > li').filter({ hasText: 'Done · Store object for segment 1' }).locator('details')).toHaveAttribute('open', '');
  await expect(page.locator('#timeline-state')).toContainText('not playable yet');
  await expect(page.locator('#playback-controls')).toBeHidden();
  expect((await state(page)).flows[0].segments).toHaveLength(0);
  await page.evaluate(() => (window as any).releaseDemoRequest());
  await expect(page.locator('#step-title')).toHaveText('Step 4. Play a time range'); await ready(page);
  await expect(page.locator('#explanation')).toContainText('Choose a time range and play it');
  await expect(page.locator('#status')).toHaveText('4 segments stored and ready to play.');
  await expect(page.locator('[data-piece][data-state="published"]')).toHaveCount(4);
  await expect(page.locator('#playback-controls')).toBeVisible();
  await expect(page.locator('omakase-play-button')).toHaveCount(0);
  const original = await state(page);
  expect(original.roots).toHaveLength(1);
  expect(original.flows).toHaveLength(1);
  expect(original.flows[0].segments.map((s: any) => s.timerange)).toEqual(['[0:0_2:0)', '[2:0_4:0)', '[4:0_6:0)', '[6:0_6:400000000)']);
  const firstWidth = (await page.locator('[data-piece="0"]').boundingBox())!.width;
  const lastWidth = (await page.locator('[data-piece="3"]').boundingBox())!.width;
  expect(Math.abs(firstWidth / lastWidth - 5)).toBeLessThan(.05);
  // The compact layout keeps the original FLOW timeline alongside the current API activity.
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const selector of ['#primary', '#status', '#technical', '#ranges', '#structure']) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(800);
  }
  await page.locator('[data-piece="1"]').focus(); await page.keyboard.press('Enter'); await ready(page);
  await expect(page.locator('#piece-description')).toContainText('2 s to 4 s');
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(1.96);
  await expect(page.locator('#playhead-time')).toContainText('2 s');
  await expect(page.locator('#requests .related')).not.toHaveCount(0);
  await expect(page.locator('#storage-objects tr').nth(1)).toHaveClass('selected');
  await page.locator('#storage-objects button').first().focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-piece="0"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#object-details > summary').click();
  await expect(page.locator('#full-object-id')).toHaveText(original.flows[0].segments[0].object_id);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { (window as any).copiedObjectId = text; },
  } }));
  await page.locator('#copy-object-id').click();
  expect(await page.evaluate(() => (window as any).copiedObjectId)).toBe(original.flows[0].segments[0].object_id);
  await expect(page.locator('#copy-status')).toHaveText('ID copied.');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); }; });
  await page.locator('#copy-object-id').click();
  await expect(page.locator('#copy-status')).toHaveText('Copy unavailable. Select the full ID to copy it.');
  await page.locator('#object-details > summary').click();
  // The short final segment remains keyboard-selectable.
  await page.locator('[data-piece="3"]').focus(); await page.keyboard.press('Enter'); await ready(page);
  await expect(page.locator('#piece-description')).toContainText('6 s to 6.4 s');
  await page.locator('#range-select').selectOption('first'); await ready(page);
  await expect(page.locator('#range-result')).toContainText('1 stored object read');
  await expect(page.locator('.pieces .matched')).toHaveCount(1);
  await page.locator('#primary').click(); await ready(page);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.9);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused && Math.abs(v.currentTime - 2) <= .08)).toBe(true);
  await page.locator('#range-select').selectOption('last'); await ready(page);
  await expect(page.locator('#range-result')).toContainText('4.4 s to 6.4 s · 2 stored objects read');
  await expect(page.locator('.pieces .matched')).toHaveCount(2);
  await expect(page.locator('#replay')).toBeEnabled();
  await page.locator('#replay').click(); await ready(page);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(6.3);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(10);
  expect(Number((await page.locator('#playhead-time').textContent())!.split(' ')[1])).toBeLessThanOrEqual(6.4);
  await expect(page.locator('#requests')).toContainText('Read selected section');
  await expect(page.locator('#requests')).not.toContainText('Playback');
  await expect(page.locator('#requests')).not.toContainText('Verify stored media');
  const storedSummary = await page.locator('#storage-summary').textContent();
  const sizes = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll<HTMLElement>('#storage-objects tr')];
    const segments = await (await fetch('/api/flows?tag.tasm.playpen.kind=source')).json();
    const flow = await (await fetch('/api/flows/' + segments[0].flow_collection[0].id + '/segments')).json();
    return Promise.all(rows.map(async row => Number((await fetch(flow.find((s: any) => s.object_id === row.dataset.object).get_urls[0].url, { method: 'HEAD' })).headers.get('content-length'))));
  });
  expect(sizes.every(size => size > 0)).toBe(true);
  expect(storedSummary).toBe('4 of 4 objects stored · ' + sizes.reduce((a, b) => a + b, 0).toLocaleString() + ' bytes');
  for (const status of [404, 503]) {
    await page.evaluate(status => {
      const real = window.fetch;
      window.fetch = async (input, init) => {
        if (String(input).includes('/media/') && init?.method === 'HEAD') {
          window.fetch = real; return new Response(null, { status });
        }
        return real(input, init);
      };
    }, status);
    await page.locator('#storage-refresh').click();
    await expect(page.locator('#storage')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#storage-objects tr').first()).toHaveAttribute('data-state', status === 404 ? 'missing' : 'unknown');
    await expect(page.locator('#storage-summary')).toContainText('3 of 4 objects stored');
  }
  await page.locator('#storage-refresh').click();
  await expect(page.locator('#storage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#storage-summary')).toHaveText(storedSummary!);
  await page.locator('#background > summary').click();
  await expect(page.locator('#background-requests')).toContainText('Playback');
  await expect(page.locator('#background-requests')).toContainText('Verify stored media');
  const verification = page.locator('#background-requests .action').filter({ hasText: 'Verify stored media' }).first();
  expect(await verification.locator('pre').allTextContents()).toHaveLength(4);
  expect((await verification.locator('pre').allTextContents()).every(text => JSON.parse(text).method === 'HEAD')).toBe(true);
  await page.locator('#background > summary').click();
  if (browserName === 'chromium') await page.screenshot({ path: '.local/demo-copy-desktop.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await branding(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.locator('#primary').boundingBox())!.height).toBeGreaterThanOrEqual(56);
  const track = (await page.locator('#track').boundingBox())!;
  let previousLabelEnd = track.x;
  for (const label of await page.locator('.object-label').all()) {
    const box = (await label.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(previousLabelEnd);
    expect(box.x + box.width).toBeLessThanOrEqual(track.x + track.width);
    expect(box.y + box.height).toBeLessThanOrEqual(track.y + track.height);
    previousLabelEnd = box.x + box.width;
  }
  if (browserName === 'chromium') await page.screenshot({ path: '.local/demo-copy-mobile.png', fullPage: true });
  await page.locator('#restart').click(); await ready(page);
  await expect(page.locator('#status')).toHaveText('Walkthrough restarted. Stored media retained.');
  await expect(page.locator('#primary')).toHaveText('Use saved source');
  expect(await state(page)).toEqual(original);
  await expect(page.locator('#storage-summary')).toHaveText(storedSummary!);
  await example(page); await expect(page.locator('#status')).toHaveText('Using stored media.');
  expect(await state(page)).toEqual(original);
  await page.reload(); await ready(page); await expect(page).toHaveTitle('TAMS in Practice');
  await expect(page.locator('#status')).toHaveText('Saved demo loaded.');
  await expect(page.locator('#primary')).toHaveText('Use saved source');
  await expect(page.locator('[data-piece][data-state="published"]')).toHaveCount(4);
  await expect(page.locator('#playback-controls')).toBeVisible();
  await expect(page.locator('#storage-summary')).toHaveText(storedSummary!);
  await expect(page.locator('#storage-objects tr')).toHaveCount(4);
  // A service-worker-controlled reload must serve Demo, including offline.
  if (browserName === 'chromium') {
    await context.setOffline(true);
    try { await page.reload(); await ready(page); await expect(page).toHaveTitle('TAMS in Practice'); await branding(page); }
    finally { await context.setOffline(false); }
  }
  expect(await state(page)).toEqual(original);
  expect(await playpen.evaluate(async () => (await (await fetch('/api/flows')).json()))).toEqual(saved);
  await playpen.reload(); await expect(playpen).toHaveTitle('TAMS Playpen');
  await expect(playpen.locator('#source-title')).toHaveText('Keep my Playpen work');
  if (browserName === 'chromium') {
    // Model two references to one stored object without changing saved media.
    await page.addInitScript(() => {
      const real = window.fetch;
      window.fetch = async (input, init) => {
        const response = await real(input, init);
        const path = new URL(String(input), location.href).pathname;
        if (path.includes('/api/flows/') && response.ok) {
          const data = await response.clone().json();
          if (path.endsWith('/segments') && data.length === 4) return Response.json([
            { ...data[0], timerange: '[0:0_1:0)' },
            { ...data[0], timerange: '[1:0_2:0)' }, ...data.slice(1),
          ]);
          // Use supported legacy references, not the original four-piece grouping.
          if (data.tags?.['tasm.playpen.blocks.v1']) {
            delete data.tags['tasm.playpen.blocks.v1']; return Response.json(data);
          }
        }
        return response;
      };
    });
    await page.reload(); await ready(page);
    await expect(page.locator('[data-piece]')).toHaveCount(5);
    await expect(page.locator('#storage-objects tr')).toHaveCount(4);
    await expect(page.locator('#storage-summary')).toHaveText(storedSummary!);
    await expect(page.locator('#storage-objects tr').first().locator('td').nth(1)).toHaveText('1, 2');
    await page.locator('#storage-objects button').first().click();
    await expect(page.locator('[data-piece][aria-pressed="true"]')).toHaveCount(2);
  }
});

test('demo retries interrupted preparation and range reads without duplicate examples', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await page.addInitScript(() => {
    const listen = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, callback, options) {
      // Exercise the existing player-error UI without changing the media engine.
      if (type === 'error' && this.constructor.name === 'Preview') {
        (window as any).failDemoPlayback = () => this.dispatchEvent(new CustomEvent('error', { detail: 'Injected playback failure' }));
      }
      return listen.call(this, type, callback, options);
    };
  });
  await page.goto('/'); await ready(page);
  await structure(page);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes('/media/') && init?.method === 'PUT') {
        window.fetch = real;
        return Response.json({ summary: 'Injected upload failure' }, { status: 507 });
      }
      return real(input, init);
    };
    const button = document.getElementById('primary') as HTMLButtonElement;
    button.click(); button.click();
  });
  await expect(page.locator('#error')).toBeVisible({ timeout: browserName === 'webkit' ? 180000 : 60000 }); await ready(page);
  await expect(page.locator('#error-detail')).toContainText('Injected upload failure');
  await expect(page.locator('#playback-controls')).toBeHidden();
  await expect(page.locator('#timeline-state')).toContainText('not ready to play');
  await expect(page.locator('#requests .action[open]')).toContainText('Failed · Store object for segment 1');
  await expect(page.locator('#error-message')).toHaveText('Store the sample media failed. Retry to continue.');
  await expect(page.locator('#storage-summary')).toHaveText('0 of 4 objects stored · 0 bytes');
  await expect(page.locator('#storage-objects tr[data-state="stored"]')).toHaveCount(0);
  const interrupted = await state(page);
  expect(interrupted.roots).toHaveLength(1); expect(interrupted.flows).toHaveLength(1);
  expect(interrupted.flows[0].segments).toHaveLength(0);
  await page.reload(); await ready(page); await example(page);
  const published = await state(page);
  expect(published.roots[0].id).toBe(interrupted.roots[0].id);
  expect(published.flows[0].segments).toHaveLength(4);
  await expect(page.locator('#playback-controls')).toBeVisible();
  await expect(page.locator('#storage-objects tr')).toHaveCount(4);
  await expect(page.locator('#storage-objects tr[data-state="stored"]')).toHaveCount(4);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes('/segments?timerange=')) {
        window.fetch = real;
        return Response.json({ summary: 'Injected range failure' }, { status: 503 });
      }
      return real(input, init);
    };
  });
  await page.locator('#range-select').selectOption('first'); await ready(page);
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error-detail')).toContainText('Injected range failure');
  await page.locator('#retry').click(); await ready(page);
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#range-result')).toContainText('1 stored object read');
  expect(await state(page)).toEqual(published);
  await page.locator('#primary').click(); await ready(page);
  await page.evaluate(() => (window as any).failDemoPlayback());
  await expect(page.locator('#error-message')).toHaveText('Playback failed. Retry to reload the preview.');
  await expect(page.locator('#error-detail')).toHaveText('Injected playback failure');
  await expect(page.locator('#primary')).toHaveText('Play a time range');
  await expect(page.locator('#replay')).toBeDisabled();
  await page.locator('#retry').click(); await ready(page);
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#status')).toHaveText('Preview ready.');
  expect(await state(page)).toEqual(published);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 5. Find the available video flows');
  await expect(page.locator('#primary')).toHaveText('Find the available video flows');
});

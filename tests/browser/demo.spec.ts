import { test, expect as browserExpect } from './fixtures';
const expect = browserExpect.configure({ timeout: 60000 });
import { ready, state, advance, structure, example } from './demo-fixtures';
import { readFile } from 'node:fs/promises';
test.use({ app: 'demo' });

test('demo lists real FLOWs, reuses two objects and verifies asynchronous deletion', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await page.goto('/'); await ready(page);
  await expect(page.locator('#explanation')).toContainText('A source identifies a piece of content');
  await expect(page.getByRole('link', { name: 'Read more in the TAMS reference' })).toHaveAttribute('href', /bbc\/tams/);
  for (const viewport of [1440, 1280, 1050, 950, 760, 550, 390].map(width => ({ width, height: 844 }))) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const video = (await page.locator('.preview').boundingBox())!;
    await expect(page.locator('.playback-controls')).toBeHidden();
    const actions = (await page.locator('.actions').boundingBox())!;
    expect(video.width / video.height).toBeCloseTo(16 / 9, 2);
    if (viewport.width >= 760) expect(actions.y + actions.height).toBeCloseTo(video.y + video.height, 0);
    else expect(actions.y + actions.height).toBeLessThanOrEqual(video.y);
    const columns = viewport.width >= 1100 ? 8 : viewport.width >= 520 ? 4 : 2;
    const steps = await page.locator('.steps button').all();
    expect(steps).toHaveLength(8);
    for (let i = 0; i < steps.length; i++) {
      const step = (await steps[i].boundingBox())!;
      const first = (await steps[Math.floor(i / columns) * columns].boundingBox())!;
      expect(step.y).toBeCloseTo(first.y, 0);
      expect(step.height).toBeGreaterThanOrEqual(44);
      await expect(steps[i]).toHaveAccessibleName(new RegExp(`Step ${i + 1}\\.`));
    }
    const technical = (await page.locator('#technical').boundingBox())!;
    const walkthrough = (await page.locator('.walkthrough').boundingBox())!;
    if (viewport.width >= 1100) expect(technical.x).toBeGreaterThanOrEqual(walkthrough.x + walkthrough.width);
    else expect(technical.y).toBeGreaterThanOrEqual(walkthrough.y + walkthrough.height);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-step="1"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#step-title')).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('demo-compact-start.png') });
  await example(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const selector of ['.instruction', '.media-panel', '#structure', '#activity-title']) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(800);
  }
  const rowTop = () => page.locator('.actions').evaluate(e => e.getBoundingClientRect().top + scrollY);
  const playbackRowTop = await rowTop();
  const saved = await state(page), parts = saved.flows[0].segments;
  const originalId = saved.flows[0].id;
  const hashes = await page.evaluate(async (segments: any[]) => Promise.all(segments.map(async s => {
    const bytes = await (await fetch(s.get_urls[0].url)).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  })), parts);
  await page.locator('#list-flows').click();
  await expect(page.locator('#api-result')).toBeHidden();
  await expect(page.locator('#primary')).toHaveText('Find the available video flows');
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#api-result')).toContainText('GET ');
  await expect(page.locator('#api-result')).toContainText('collected_by_ids=' + saved.roots[0].id);
  await expect(page.locator('#api-result')).toContainText('HTTP 200');
  await expect(page.locator('#api-result')).toContainText(originalId);
  await expect(page.locator('#status')).toHaveText('1 video flow found for this example. Each record describes an available video representation.');
  expect(await rowTop()).toBeCloseTo(playbackRowTop, 0);
  // Fail the second registration once, then lose the publication response after the server commits it.
  await page.evaluate(() => {
    const real = window.fetch; let registrations = 0, failed = false;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/segments') && init?.method === 'POST' && ++registrations === 2) {
        failed = true; return Response.json({ summary: 'Injected excerpt registration failure' }, { status: 503 });
      }
      const response = await real(input, init);
      if (failed && url.endsWith('/flow_collection') && init?.method === 'PUT') {
        window.fetch = real; throw new Error('Lost excerpt publication response');
      }
      return response;
    };
  });
  await page.locator('#create-excerpt').click();
  expect((await state(page)).flows).toHaveLength(1);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#error-detail')).toContainText('Injected excerpt registration failure');
  expect((await state(page)).flows).toHaveLength(1);
  await page.locator('#retry').click(); await ready(page);
  await expect(page.locator('.flow-row:visible')).toHaveCount(2);
  await expect(page.locator('#storage-objects tr')).toHaveCount(4);
  await expect(page.locator('#create-excerpt')).toHaveClass('complete');
  await expect(page.locator('#primary')).toHaveText('Next: Delete the original flow');
  expect(await rowTop()).toBeCloseTo(playbackRowTop, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('demo-compact-reuse.png') });
  const created = await state(page);
  expect(created.flows[1].segments.map((s: any) => [s.object_id, s.timerange])).toEqual(parts.slice(0, 2).map((s: any) => [s.object_id, s.timerange]));
  expect(created.flows[0].id).toBe(originalId);
  const registered = await page.evaluate(async () => (await (await fetch('/api/flows?tag.tasm.demo.role=excerpt')).json()));
  expect(registered).toHaveLength(1);
  await expect(page.locator('.flow-heading button')).toHaveCount(0);
  await expect(page.locator('.flow-label:visible')).toHaveText(['Original video', 'Four-second excerpt']);
  await page.locator('.flow-row:visible').nth(1).locator('[data-piece]').first().click(); await ready(page);
  await page.locator('#list-segments').click();
  await expect(page.locator('#api-result')).toBeHidden();
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#api-result')).toContainText('/flows/' + created.flows[1].id + '/segments');
  await expect(page.locator('#api-result')).toContainText(parts[0].object_id);
  await expect(page.locator('#api-result')).not.toContainText(parts[2].object_id);
  await expect(page.locator('#status')).toHaveText('2 segments found in this flow. Match their object IDs to the stored media below.');
  const media = (await page.locator('.media-panel').boundingBox())!, controls = (await page.locator('.actions').boundingBox())!, result = (await page.locator('#api-result').boundingBox())!;
  expect(controls.y).toBeGreaterThanOrEqual(result.y + result.height);
  expect(await rowTop()).toBeCloseTo(playbackRowTop, 0);
  expect(controls.y + controls.height).toBeCloseTo(media.y + media.height, 0);
  expect(await page.locator('#api-result').evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
  await page.locator('#api-result').focus(); await page.keyboard.press('End');
  await expect.poll(() => page.locator('#api-result').evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  await page.locator('#api-result').evaluate(e => e.scrollTop = 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('demo-compact-api.png') });
  await page.evaluate(() => {
    const real = window.fetch; let held = false;
    window.fetch = async (input, init) => {
      if (String(input).includes('/flow-delete-requests/') && !held) {
        held = true; (window as any).heldDeletion = true;
        await new Promise<void>(resolve => { (window as any).releaseDeletion = resolve; });
        window.fetch = real; return Response.json({ summary: 'Injected deletion status failure' }, { status: 503 });
      }
      return real(input, init);
    };
  });
  await page.locator('#delete-previous').click();
  await expect(page.locator('.flow-row:visible')).toHaveCount(2);
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => (window as any).heldDeletion)).toBe(true);
  await expect(page.locator('.flow-row:visible')).toHaveCount(1);
  await expect(page.locator('#storage-objects tr[data-state="deleting"]')).toHaveCount(2);
  await expect(page.locator('#storage-objects tr')).toHaveCount(4);
  await page.evaluate(() => (window as any).releaseDeletion()); await ready(page);
  await expect(page.locator('#error-detail')).toContainText('Injected deletion status failure');
  await expect(page.locator('#storage-objects tr[data-state="deleting"]')).toHaveCount(2);
  await page.reload(); await ready(page);
  await expect(page.locator('#storage-objects tr')).toHaveCount(2);
  await expect(page.locator('#storage-summary')).toContainText('2 of 2 objects stored');
  const remaining = await state(page);
  expect(remaining.flows).toHaveLength(1);
  expect(remaining.flows[0].id).toBe(created.flows[1].id);
  expect(await page.evaluate(async (segments: any[]) => Promise.all(segments.map(async s => (await fetch(s.get_urls[0].url, { method: 'HEAD' })).status)), parts)).toEqual([200, 200, 404, 404]);
  expect(await page.evaluate(async (segments: any[]) => Promise.all(segments.map(async s => {
    const bytes = await (await fetch(s.get_urls[0].url)).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  })), remaining.flows[0].segments)).toEqual(hashes.slice(0, 2));
  await expect(page.locator('#primary')).toHaveText('Restart walkthrough');
  await page.locator('#primary').click(); await ready(page);
  await advance(page, 'Step 2. Add a video flow'); await advance(page, 'Step 3. Store the sample media'); await advance(page, 'Step 4. Play a time range');
  await page.locator('#primary').click(); await ready(page);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(3.9);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(page.locator('#step-title')).toHaveText('Step 5. Find the available video flows');
});

test('demo continues all eight steps with the green button and keeps replay independent', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  await page.goto('/'); await ready(page);
  await expect(page.locator('#playback-controls')).toBeHidden();
  await expect(page.locator('#pause')).toBeDisabled();
  await expect(page.locator('#replay')).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 800 }); await example(page);
  await expect(page.locator('#playback-controls')).toBeVisible();
  const initial = await state(page);
  const controlsTop = () => page.locator('.playback-controls').evaluate(e => e.getBoundingClientRect().top + scrollY);
  const desktopTop = await controlsTop();
  await page.locator('#range-select').selectOption('first'); await ready(page);
  await page.locator('#primary').click(); await ready(page);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
  await page.locator('#pause').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('demo-compact-playback.png') });
  await expect(page.locator('#primary')).toHaveText('Play a time range');
  await expect(page.locator('#replay')).toBeDisabled();
  await page.locator('#primary').click(); await ready(page);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
  await page.locator('[data-piece="1"]').click(); await ready(page);
  await expect(page.locator('#primary')).toHaveText('Play a time range');
  await expect(page.locator('#replay')).toBeDisabled();
  await page.locator('#primary').click(); await ready(page);
  await page.locator('#range-select').selectOption('whole'); await ready(page);
  await expect(page.locator('#primary')).toHaveText('Play a time range');
  await expect(page.locator('#replay')).toBeDisabled();
  await page.locator('#range-select').selectOption('first'); await ready(page);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 5. Find the available video flows');
  await expect(page.locator('[data-step="5"]')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#primary')).toHaveText('Find the available video flows');
  await expect(page.locator('#api-result')).toBeHidden();
  await expect(page.locator('#replay')).toBeEnabled();
  // Natural end-of-video playback must complete the guide as well as bounded ranges.
  await page.locator('[data-step="4"]').click();
  await page.locator('#range-select').selectOption('whole'); await ready(page);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 5. Find the available video flows');
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.locator('#range-select').selectOption('first'); await ready(page);
  for (const interrupt of ['pause', 'seek']) {
    await page.locator('[data-step="4"]').click();
    await page.locator('#primary').click(); await ready(page);
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
    await page.locator(interrupt === 'pause' ? '#pause' : '[data-piece="1"]').click(); await ready(page);
    await expect(page.locator('#step-title')).toHaveText('Step 4. Play a time range');
    await expect(page.locator('#primary')).toHaveText('Play a time range');
    await page.locator('#primary').click(); await ready(page);
    await expect(page.locator('#step-title')).toHaveText('Step 5. Find the available video flows');
    await expect(page.locator('#primary')).toHaveText('Find the available video flows');
  }
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 5. Find the available video flows');
  await expect(page.locator('#api-result')).toContainText('HTTP 200');
  await expect(page.locator('#primary')).toHaveText('Next: Inspect the flow’s segments');
  const result = await page.locator('#api-result').textContent();
  await page.locator('#replay').click(); await ready(page);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(page.locator('#primary')).toHaveText('Next: Inspect the flow’s segments');
  await expect(page.locator('#api-result')).toHaveText(result!);
  expect(await controlsTop()).toBeCloseTo(desktopTop, 0);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 6. Inspect the flow’s segments');
  await expect(page.locator('#api-result')).toContainText(initial.flows[0].segments[0].object_id);
  await expect(page.locator('#primary')).toHaveText('Next: Create a four-second excerpt');
  // Mobile explanations grow naturally; playback stays below the video without overlap.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileControls = async () => {
    const video = (await page.locator('.preview').boundingBox())!;
    const controls = (await page.locator('.playback-controls').boundingBox())!;
    expect(controls.y).toBeGreaterThanOrEqual(video.y + video.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await mobileControls();
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 7. Create a four-second excerpt');
  await expect(page.locator('.flow-row:visible')).toHaveCount(2);
  await expect(page.locator('#storage-objects tr')).toHaveCount(4);
  await expect(page.locator('#primary')).toHaveText('Next: Delete the original flow');
  await mobileControls();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('demo-compact-mobile.png'), fullPage: true });
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 8. Delete the original flow');
  await expect(page.locator('#explanation')).toContainText('Two unused media objects were removed');
  await expect(page.locator('#primary')).toHaveText('Restart walkthrough');
  await expect(page.locator('#storage-objects tr')).toHaveCount(2);
  await mobileControls();
  const retained = await state(page);
  expect(retained.flows[0].segments.map((s: any) => s.object_id)).toEqual(initial.flows[0].segments.slice(0, 2).map((s: any) => s.object_id));
  // Revisiting completed writes reuses their results; selection alone makes no requests.
  const deletes = () => page.locator('#requests pre').allTextContents().then(records => records.filter(r => JSON.parse(r).method === 'DELETE').length);
  const deleteCount = await deletes();
  await page.locator('#create-excerpt').click();
  await expect(page.locator('#primary')).toHaveText('Create a four-second excerpt');
  expect(await state(page)).toEqual(retained);
  await page.locator('#primary').click(); await ready(page);
  expect(await state(page)).toEqual(retained);
  await page.locator('#delete-previous').click();
  await expect(page.locator('#primary')).toHaveText('Restart walkthrough');
  expect(await deletes()).toBe(deleteCount);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await expect(page.locator('#replay')).toBeDisabled();
  expect(await state(page)).toEqual(retained);
  // A transient check of surviving storage cannot undo confirmed deletion after reload.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes('/media/') && init?.method === 'HEAD') {
        window.fetch = real; return new Response(null, { status: 503 });
      }
      return real(input, init);
    };
  });
  await page.reload(); await ready(page);
  await expect(page.locator('#storage-objects tr[data-state="unknown"]')).toHaveCount(1);
  await page.locator('#delete-previous').click();
  await expect(page.locator('#primary')).toHaveText('Restart walkthrough');
  await expect(page.locator('#explanation')).toContainText('Two unused media objects were removed');
  expect(await deletes()).toBe(0);
  expect(await state(page)).toEqual(retained);
});

test('demo reset preserves Playpen and stops active preparation', async ({ page, context, browserName, playpenURL }) => {
  test.setTimeout(browserName === 'webkit' ? 600000 : 240000);
  const playpen = await context.newPage(); await playpen.goto(playpenURL);
  await expect(playpen.locator('#new-source')).toBeEnabled({ timeout: 90000 });
  await playpen.locator('#new-source').click(); await playpen.locator('#entity-name').fill('Keep Playpen');
  await playpen.locator('#dialog-submit').click(); await expect(playpen.locator('#source-title')).toHaveText('Keep Playpen');
  const buffer = await readFile(`${process.env.TASM_DIST ?? 'dist'}/playpen/samples/orbit.ts`);
  await playpen.locator('#media-file').setInputFiles({ name: 'Keep.ts', mimeType: 'video/mp2t', buffer });
  await expect(playpen.locator('#sample-count')).toHaveText('41');

  await page.bringToFront();
  await page.goto('/'); await ready(page); await example(page);
  const saved = await state(page), demoId = saved.roots[0].id;
  await page.evaluate(id => {
    localStorage.setItem(`tasm-preview:${id}`, '{}');
    localStorage.setItem('unrelated-preference', 'keep');
  }, demoId);
  await page.locator('#restart').click(); await ready(page);
  expect(await state(page)).toEqual(saved);
  await page.locator('#reset-demo').click(); await expect(page.locator('#reset-cancel')).toBeFocused();
  await expect(page.locator('#reset-warning')).toContainText('all Demo data');
  await page.keyboard.press('Escape'); await expect(page.locator('#reset-demo')).toBeFocused();
  expect(await state(page)).toEqual(saved);

  const second = await context.newPage(); await second.goto('/'); await ready(second);
  await page.bringToFront();
  await page.locator('#reset-demo').click(); await page.locator('#reset-confirm').click();
  await expect(page.locator('#reset-status')).toContainText('Close other tabs using this site');
  await expect(page.locator('#reset-cancel')).toBeDisabled();
  expect(await state(second)).toEqual(saved);
  await second.close();
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.locator('#reset-confirm').click()]);
  await ready(page);
  await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await expect(page.locator('#source-empty')).toHaveText('No source yet.');
  await expect(page.locator('#storage-summary')).toHaveText('No objects stored yet.');
  await expect(page.locator('#requests')).toHaveText('No actions yet.');
  expect((await state(page)).roots).toEqual([]);
  expect(await page.evaluate(async id => {
    const files = await (await navigator.storage.getDirectory()).getDirectoryHandle('tasm-%2F');
    const names = []; for await (const name of files.keys()) names.push(name);
    return { files: names, preference: localStorage.getItem(`tasm-preview:${id}`), unrelated: localStorage.getItem('unrelated-preference') };
  }, demoId)).toEqual({ files: [], preference: null, unrelated: 'keep' });

  // Reset can also cancel the demo's own in-progress preparation worker.
  await structure(page);
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (data, transfer) {
      if (data.bytes) return;
      Reflect.apply(post, this, [data, transfer]);
    };
  });
  await page.locator('#primary').click(); await expect(page.locator('#status')).toHaveText('Preparing segments...');
  await page.locator('#reset-demo').click();
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.locator('#reset-confirm').click()]);
  await ready(page); expect((await state(page)).roots).toEqual([]);
  await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await expect(page.locator('#error')).toBeHidden();
  const fresh = await context.newPage(); await fresh.goto(playpenURL);
  await expect(fresh.locator('#new-source')).toBeEnabled({ timeout: 90000 });
  await expect(fresh.locator('#source-title')).toHaveText('Keep Playpen');
  await expect(fresh.locator('#sample-count')).toHaveText('41');
});

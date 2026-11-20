import { test, expect as browserExpect } from './fixtures';
test.use({ app: 'demo' });
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const expect = browserExpect.configure({ timeout: 60000 });

async function ready(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  await expect(page.locator('.walkthrough')).toHaveAttribute('aria-busy', 'false', { timeout: test.info().project.name === 'webkit' ? 240000 : 60000 });
  if (await page.locator('#demo-about').isVisible()) await page.locator('#demo-about').getByRole('button', { name: 'Close', exact: true }).click();
}
async function branding(page: Page) {
  await page.mouse.move(0, 0);
  await expect(page.getByRole('navigation', { name: 'Demo partners' })).toBeVisible();
  for (const name of ['LiveWyer', 'Techex']) {
    const logo = page.getByRole('img', { name, exact: true });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  const style = await page.evaluate(async () => {
    await Promise.all(['400 16px "HK Grotesk"', '700 16px "HK Grotesk"', '400 12px "Fira Code"'].map(font => document.fonts.load(font)));
    await document.fonts.ready;
    return { body: getComputedStyle(document.body).fontFamily,
      paper: getComputedStyle(document.documentElement).backgroundColor,
      ink: getComputedStyle(document.body).color,
      button: getComputedStyle(document.getElementById('primary')!).backgroundColor,
      cached: (await Promise.all((await caches.keys()).filter(name => name.startsWith('tasm-assets:') && name.includes('/')).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat() };
  });
  expect(style.body).toContain('HK Grotesk');
  expect(style.paper).toBe('rgb(247, 248, 246)');
  expect(style.ink).toBe('rgb(0, 35, 55)');
  expect(style.button).toBe('rgb(19, 214, 163)');
  for (const file of ['livewyer.svg', 'techex.svg', 'HKGrotesk-Regular.otf', 'HKGrotesk-Bold.otf', 'HKGrotesk-Black.otf', 'FiraCode-Regular.ttf']) {
    expect(style.cached).toContain('/branding/' + file);
  }
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const roots = await (await fetch('/api/flows?tag.tasm.playpen.kind=source')).json();
    const flows = await Promise.all((roots[0]?.flow_collection ?? []).map(async ({ id }: { id: string }) => ({
      id, segments: await (await fetch(`/api/flows/${id}/segments`)).json(),
    })));
    return { roots, flows };
  });
}
async function advance(page: Page, title: string) {
  await page.locator('#primary').click();
  // WebKit's persistent IndexedDB commits are slower than Chromium/Firefox.
  await expect(page.locator('#step-title')).toHaveText(title, { timeout: test.info().project.name === 'webkit' ? 240000 : 60000 });
  await ready(page);
}
async function structure(page: Page) {
  await advance(page, 'Step 2. Add a video flow');
  await advance(page, 'Step 3. Store the sample media');
}
async function example(page: Page) {
  await structure(page);
  await advance(page, 'Step 4. Play a time range');
  await expect(page.locator('[data-piece]')).toHaveCount(4);
}

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
      post.call(this, data, transfer as Transferable[]);
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
  expect(Math.abs(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime) - 2)).toBeLessThanOrEqual(.041);
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

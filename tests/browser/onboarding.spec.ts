import { expect as browserExpect } from './fixtures';
import { test, output } from './media-output';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const expect = browserExpect.configure({ timeout: 90000 });
test.use({ showOnboarding: true });
test.setTimeout(180000);

test('distinct welcomes persist separately and the Playpen tour can be dismissed and restarted', async ({ page, demoURL, playpenURL }) => {
  await page.goto(demoURL);
  await expect(page.locator('#demo-about')).toBeVisible();
  await expect(page.locator('#demo-about')).toContainText('store and retrieve media by time via an API');
  await expect(page.locator('#demo-about a')).toHaveAttribute('href', 'https://github.com/bbc/tams');
  await page.locator('#demo-about').getByRole('button', { name: 'Start demo' }).click();
  await page.reload(); await expect(page.locator('#primary')).toBeEnabled(); await expect(page.locator('#demo-about')).not.toBeVisible();
  await page.goto(playpenURL);
  await expect(page.locator('#playpen-about')).toBeVisible();
  await expect(page.locator('#playpen-about')).toContainText('experiment with arranging video and audio by time');
  await page.locator('#playpen-about [data-start-tour]').click();
  await expect(page.locator('.tour-popover')).toBeVisible();
  await expect(page.locator('.tour-popover h2')).toHaveText('Build a separate example');
  await page.keyboard.press('Escape'); await expect(page.locator('.tour-popover')).not.toBeVisible();
  await page.reload(); await expect(page.locator('#tour-playpen')).toBeVisible(); await expect(page.locator('#playpen-about')).not.toBeVisible();
  await page.locator('#tour-playpen').click(); await page.locator('.tour-close').click();
  await expect(page.locator('#tour-playpen')).toBeFocused();
});

async function clearWorkspace(page: Page, selectors: string[]) {
  const overlap = await page.locator('.tour-popover').evaluate((card, selectors) => {
    const a = card.getBoundingClientRect();
    return selectors.some(selector => {
      const b = document.querySelector(selector)?.getBoundingClientRect();
      return b && b.width && b.height && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
  }, selectors);
  expect(overlap).toBeFalsy();
}
async function expectTourAtTop(page: Page) {
  const bounds = await page.locator('.tour-popover').evaluate(card => {
    const main = card.closest('main')!;
    const top = main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop);
    const rect = card.getBoundingClientRect();
    const preview = document.querySelector('.preview-panel')!.getBoundingClientRect();
    return { y: rect.top - top, left: rect.left, previewLeft: preview.left, bottom: rect.bottom, previewTop: preview.top };
  });
  expect(bounds.y).toBeCloseTo(0, 0);
  expect(bounds.left).toBeCloseTo(bounds.previewLeft, 0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.previewTop);
}
async function advance(page: Page, label: string, position: string) {
  const next = page.locator('.tour-next');
  await expect(next).toContainText(label); await expect(next).toBeEnabled();
  await next.click();
  await expect(page.locator('.tour-position')).toHaveText(position, { timeout: test.info().project.name === 'webkit' ? 240000 : 90000 });
  await expect(page.locator('.tour-result')).toBeVisible();
  await expectTourAtTop(page);
}

test('mobile tour preserves an existing draft and can end while creating its example', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#playpen-about').getByText('Explore on my own', { exact: true }).click();
  for (const [button, name] of [['#new-source', 'My draft'], ['#add-audio', 'My voice']]) {
    await page.locator(button).click(); await page.locator('#entity-name').fill(name); await page.locator('#dialog-submit').click();
  }
  await page.locator('[data-sample="speech-01-i"]').click(); await page.locator('#add-sample').click();
  await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally');
  const original = await page.locator('#sources').inputValue();
  await page.locator('#tour-playpen').click();
  await clearWorkspace(page, ['#timeline-scroll', '.preview-stage']);
  const box = await page.locator('.tour-popover').boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  // Hold a real PUT in flight; dismissing must not start the next action.
  await page.evaluate(() => {
    const fetch = window.fetch;
    const resume = new Promise<void>(resolve => {
      window.addEventListener('resume-tour-write', () => resolve(), { once: true });
    });
    window.fetch = async (input, init) => {
      if (init?.method === 'PUT' && String(input).includes('/flows/')) {
        document.body.dataset.tourWrite = 'waiting';
        await resume;
      }
      return fetch(input, init);
    };
  });
  const createExample = page.getByRole('button', { name: 'Create example' });
  await expect(createExample).toBeEnabled();
  await createExample.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-tour-write', 'waiting');
  await expect(page.locator('.tour-popover')).toHaveAttribute('aria-busy', 'true');
  await page.locator('.tour-close').click(); await expect(page.locator('.tour-popover')).not.toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('resume-tour-write')));
  await expect(page.locator('#source-title')).toHaveText('Guided offset example');
  await expect(page.locator('#sources')).toBeEnabled();
  await expect(page.locator('.clip')).toHaveCount(0);
  await page.locator('#sources').selectOption(original);
  await expect(page.locator('.clip')).toHaveCount(1); await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally');
  await page.reload(); await expect(page.locator('.clip')).toHaveCount(1);
});

test('Playpen actions and result explanations perform the complete offset example, retries safely and decodes the result', async ({ page, browserName, audioOutput }) => {
  test.setTimeout(browserName === 'webkit' ? 720000 : 360000);
  await page.addInitScript(() => {
    const fetch = window.fetch; (window as any).__tourWrites = 0;
    window.fetch = (input, init) => {
      if (['POST', 'PUT', 'DELETE'].includes(init?.method ?? (input instanceof Request ? input.method : 'GET'))) (window as any).__tourWrites++;
      return fetch(input, init);
    };
  });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto('/');
  await page.locator('#playpen-about [data-start-tour]').click();
  await clearWorkspace(page, ['#timeline-scroll', '.preview-stage']);
  await page.evaluate(() => {
    const fetch = window.fetch; let fail = true;
    window.fetch = (input, init) => {
      if (fail && init?.method === 'PUT' && String(input).includes('/flows/')) { fail = false; return Promise.reject(new Error('Test source creation failure')); }
      return fetch(input, init);
    };
  });
  await page.locator('.tour-next').click(); await expect(page.locator('.tour-state')).toContainText('Test source creation failure');
  await expect(page.locator('.tour-position')).toHaveText('1 of 15');
  await page.locator('.tour-next').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.locator('.tour-position')).toHaveText('2 of 15');
  await expect(page.locator('.tour-result')).toContainText('Your example has its own source');
  await expect(page.locator('#sources')).toHaveClass(/tour-target/);
  await expect(page.locator('#sources option')).toHaveCount(1);
  await advance(page, 'Add flows', '3 of 15'); await expect(page.locator('.lane')).toHaveCount(2);
  await advance(page, 'Add samples', '4 of 15'); await expect(page.locator('.clip')).toHaveCount(2);
  await expect(page.locator('#preview-empty')).toContainText('Save your arrangement to preview these clips.');
  await expect(page.locator('#preview-caption')).toHaveText('Save your arrangement to preview these clips.');
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const selector of ['#save-draft', '.lane']) {
    const box = await page.locator(selector).last().boundingBox(); expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  }
  await expect(page.locator('.preview-panel')).not.toHaveAttribute('open', '');
  await expect(page.locator('#library-section')).toHaveJSProperty('open', true);
  await expect(page.locator('#storage')).toHaveJSProperty('open', false);
  await clearWorkspace(page, ['#timeline-scroll', '.preview-stage']);
  await page.evaluate(() => {
    const fetch = window.fetch; let fail = true;
    window.fetch = (input, init) => {
      if (fail && init?.method === 'POST' && String(input).endsWith('/storage')) { fail = false; return Promise.reject(new Error('Test allocation failure')); }
      return fetch(input, init);
    };
  });
  await page.locator('.tour-next').click(); await expect(page.locator('.tour-state')).toContainText('Test allocation failure');
  await expect(page.locator('.tour-position')).toHaveText('4 of 15');
  await expect(page.locator('#storage')).toHaveJSProperty('open', true);
  await advance(page, 'Save original', '5 of 15');
  const read = () => page.evaluate(async () => {
    const root = await (await fetch(`/api/flows/${(document.getElementById('sources') as HTMLSelectElement).value}`)).json();
    return Promise.all(root.flow_collection.map(async ({ id }: { id: string }) => ({
      flow: await (await fetch(`/api/flows/${id}`)).json(), segments: await (await fetch(`/api/flows/${id}/segments?include_object_timerange=true`)).json(),
    })));
  });
  const original = await read();
  await page.locator('.tour-next').click();
  await expect(page.locator('video')).toHaveJSProperty('paused', false);
  await expect(page.locator('.tour-popover')).toHaveAttribute('data-phase', 'running');
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  await expect(page.locator('.tour-state')).toContainText('Playback stopped before the range finished');
  await expect(page.locator('.tour-position')).toHaveText('5 of 15');
  await advance(page, 'Play original', '6 of 15'); await expect(page.locator('video')).toHaveJSProperty('paused', true);
  await advance(page, 'Insert Voice B', '7 of 15'); await expect(page.locator('.clip')).toHaveCount(4);
  await advance(page, 'Save voice edit', '8 of 15');
  const voice = await read();
  expect(voice[0]).toEqual(original[0]);
  const audioIds = original[1].segments.map((s: any) => s.object_id);
  expect(voice[1].segments.filter((s: any) => audioIds.includes(s.object_id)).map((s: any) => s.object_id)).toEqual(audioIds);
  await advance(page, 'Play voice edit', '9 of 15');
  await advance(page, 'Insert newsreader', '10 of 15'); await expect(page.locator('.clip')).toHaveCount(6);
  await advance(page, 'Save video edit', '11 of 15');
  const edited = await read(); expect(edited[1]).toEqual(voice[1]);
  expect(new Set(edited[0].segments.map((s: any) => s.object_id))).toEqual(new Set(original[0].segments.map((s: any) => s.object_id)));
  expect(edited[0].segments.at(-1).timerange).toBe('[18:0_20:0)');
  expect(edited[0].segments.at(-1).ts_offset).toBe('10:0');
  await advance(page, 'Play video edit', '12 of 15');
  await advance(page, 'Inspect offset', '13 of 15'); await expect(page.locator('#time-details')).toHaveAttribute('open', '');
  await expect(page.locator('#time-equation')).toContainText('ts_offset 6.293333333');
  await expect(page.locator('#storage-count')).toHaveText('17 objects');
  await advance(page, 'Query time range', '14 of 15'); await expect(page.locator('#range-result')).toContainText('unique objects');
  await expect(page.locator('.timeline-panel')).toHaveJSProperty('open', false);
  for (const panel of ['#library-section', '.preview-panel', '#storage', '.api-panel']) {
    await expect(page.locator(panel)).toHaveJSProperty('open', true);
  }
  await advance(page, 'Show API request', '15 of 15');
  await page.locator('#source-id button').click();
  await expect(page.locator('#terminal')).toHaveAttribute('open', '');
  await page.locator('#terminal-command').press('Enter');
  await expect(page.locator('.tour-position')).toHaveText('Example complete');
  await expect(page.locator('.tour-result')).toContainText('HTTP 200'); await expect(page.locator('#request-detail')).toContainText('GET');
  await clearWorkspace(page, ['#timeline-scroll', '.preview-stage']);
  await page.screenshot({ path: test.info().outputPath('playpen-complete.png'), fullPage: true });
  await page.locator('.tour-next').click(); await page.reload();
  await expect(page.locator('#preview-status')).toContainText('Source ready'); expect(await read()).toEqual(edited);
  for (const time of [1, 5.7, 14.5]) {
    const decoded = await output(page, time, audioOutput);
    expect(decoded.brightness).toBeGreaterThan(10); expect(decoded.rms).toBeGreaterThan(0.001);
  }
  await page.locator('#tour-playpen').click(); await advance(page, 'Create example', '2 of 15');
  await expect(page.locator('#source-title')).toHaveText('Guided offset example 2'); await expect(page.locator('#sources option')).toHaveCount(2);
  await page.locator('#sources').selectOption(edited[0].flow.tags['tasm.playpen.root'][0]);
  await expect(page.locator('.tour-popover')).not.toBeVisible();
});

test('tour keeps its place above Preview at every width and ends when editing manually', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto('/');
  await page.locator('#playpen-about [data-start-tour]').click();
  await advance(page, 'Create example', '2 of 15');
  await advance(page, 'Add flows', '3 of 15');
  await page.locator('.tour-next').click();
  await expect(page.locator('.tour-position')).toHaveText('4 of 15');
  await expect(page.locator('.clip.tour-target')).toHaveCount(2);
  for (const width of [1280, 900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectTourAtTop(page);
    await expect(page.locator('#library-section')).toHaveJSProperty('open', true);
  }
  const boxes = await page.evaluate(() => ({
    timeline: document.getElementById('timeline-scroll')!.getBoundingClientRect().toJSON(),
    card: document.querySelector('.tour-popover')!.getBoundingClientRect().toJSON(),
  }));
  expect(boxes.card.bottom <= boxes.timeline.top || boxes.card.top >= boxes.timeline.bottom).toBe(true);
  expect(boxes.card.left).toBeGreaterThanOrEqual(0); expect(boxes.card.right).toBeLessThanOrEqual(390);
  await clearWorkspace(page, ['#timeline-scroll', '.preview-stage']);
  await page.locator('#remove-block').click();
  await expect(page.locator('.tour-popover')).not.toBeVisible();
  await expect(page.locator('.tour-target')).toHaveCount(0);
  await expect(page.locator('.clip')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#draft-status')).toHaveText('Unsaved changes · stored locally');
  await expect(page.locator('.tour-popover')).not.toBeVisible();
});

test('Demo welcome opens the main walkthrough with step explanations disabled', async ({ page, browserName, demoURL }) => {
  test.setTimeout(browserName === 'webkit' ? 360000 : 180000);
  const timeout = browserName === 'webkit' ? 240000 : 60000;
  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(demoURL);
  await expect(page).toHaveTitle('TAMS in Practice');
  await expect(page.locator('.brand')).toHaveText('TAMS in Practice');
  await expect(page.getByRole('link', { name: /Playpen/ })).toHaveCount(0);
  await expect(page.locator('#demo-about-title')).toHaveText('Welcome to TAMS in Practice');
  await expect(page.locator('#demo-about')).toContainText('create an excerpt without making another copy of the media');
  await expect(page.locator('#demo-about')).toContainText('developed at LiveWyer and compiled to WebAssembly');
  await expect(page.locator('#demo-about')).toBeVisible();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const dialog = (await page.locator('#demo-about').boundingBox())!;
    expect(dialog.x).toBeGreaterThanOrEqual(0); expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.width);
    expect(dialog.y).toBeGreaterThanOrEqual(0); expect(dialog.y + dialog.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.locator('#demo-about').getByRole('button', { name: 'Start demo' })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`demo-welcome-${viewport.width}.png`) });
  }
  await page.locator('#demo-about').getByRole('button', { name: 'Start demo' }).click();
  await expect(page.locator('#primary')).toBeEnabled({ timeout: 90000 });
  await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await expect(page.locator('#tour-demo, #tour-mobile, #tour-desktop, .tour-popover, .tour-target')).toHaveCount(0);
  await expect(page.locator('.demo-layout > #technical')).toBeVisible();
  for (const width of [390, 1024, 1600]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const walkthrough = (await page.locator('.walkthrough').boundingBox())!;
    const technical = (await page.locator('#technical').boundingBox())!;
    if (width < 1100) expect(technical.y).toBeGreaterThanOrEqual(walkthrough.y + walkthrough.height);
    else { expect(technical.x).toBeGreaterThanOrEqual(walkthrough.x + walkthrough.width); expect(technical.y).toBeCloseTo(walkthrough.y, 0); }
  }
  await page.locator('#about-demo').click(); await expect(page.locator('#demo-about')).toBeVisible();
  await page.locator('#demo-about').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#demo-about')).not.toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch; let fail = true;
    window.fetch = (input, init) => {
      if (fail && init?.method === 'PUT' && String(input).includes('/flows/')) { fail = false; return Promise.reject(new Error('Test interrupted source creation')); }
      return original(input, init);
    };
  });
  await page.locator('#primary').click(); await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await page.locator('#retry').click(); await expect(page.locator('#step-title')).toHaveText('Step 2. Add a video flow', { timeout });
  await page.locator('#restart').click(); await expect(page.locator('#step-title')).toHaveText('Step 1. Create a source');
  await expect(page.locator('.tour-popover, .tour-target')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('demo-without-tips.png'), fullPage: true });
});


test('both sites load the TAMS favicon from their own offline cache', async ({ page }) => {
  for (const site of ['demo', 'playpen']) {
    // Stop a disposable origin: WebKit's offline flag also blocks cached responses.
    // https://github.com/microsoft/playwright/issues/42775
    const server = spawn(process.execPath, ['scripts/serve.mjs', `--app=${site}`], { env: { ...process.env, PORT: '0', TASM_BIND_ADDRESS: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Favicon test server did not start')), 10000);
        server.once('error', error => { clearTimeout(timer); reject(error); });
        server.once('exit', () => { clearTimeout(timer); reject(new Error('Favicon test server exited')); });
        server.stdout.on('data', bytes => { const url = String(bytes).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } });
      });
      await page.goto(`${origin}/`);
      await expect(page.locator('.welcome-dialog')).toBeVisible();
      await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', './branding/tams-favicon.svg');
      expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('/service-worker.js');
      const stopped = once(server, 'exit'); server.kill(); await stopped;
      expect(await page.evaluate(() => fetch('/uncached-probe').then(() => false, () => true))).toBeTruthy();
      const icons = await page.evaluate(async () => Promise.all([...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map(async link => {
        const response = await fetch(link.href);
        return { status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };
      })));
      expect(icons.map(icon => icon.status)).toEqual([200, 200, 200]);
      expect(icons.map(icon => icon.type)).toEqual(['image/svg+xml', 'image/png', 'image/png']);
      for (const icon of icons) expect(icon.bytes).toBeGreaterThan(100);
    } finally { if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, 'exit'); server.kill(); await stopped; } }
  }
});

import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';

test('request details scroll without moving the media store', async ({ page }) => {
  // Layout only: use the real markup and current CSS without starting WASM.
  const html = (await readFile('apps/playpen/index.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  await page.route('**/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/playpen.css', route => route.fulfill({ contentType: 'text/css', path: 'apps/playpen/style.css' }));
  await page.goto('/');
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#requests').evaluate(list => { list.textContent = 'GET /sources'; });
    const detail = page.locator('#request-detail');
    await detail.evaluate(el => { el.textContent = 'Select a request.'; });
    const before = await detail.boundingBox(), storage = await page.locator('#storage').boundingBox();
    const timeline = await page.locator('.timeline-panel').boundingBox();
    const api = (await page.locator('.api-panel').boundingBox())!;
    const terminal = (await page.locator('#terminal').boundingBox())!;
    expect(api.y - timeline!.y - timeline!.height).toBeCloseTo(12, 0);
    expect(terminal.y - api.y - api.height).toBeCloseTo(12, 0);
    if (width > 700) expect(api.width).toBeGreaterThan(storage!.width);
    const list = (await page.locator('#requests').boundingBox())!;
    if (api.width > 582) expect(list.x + list.width).toBeCloseTo(before!.x, 0);
    else expect(list.y + list.height).toBeCloseTo(before!.y, 0);
    await detail.evaluate(el => {
      el.innerHTML = '<p class="request-explanation"></p><details><summary>Response</summary><pre></pre></details>';
      el.querySelector('p')!.textContent = 'Store media bytes and register the segment. '.repeat(20);
      el.querySelector('pre')!.textContent = JSON.stringify({ segments: Array.from({ length: 100 }, (_, i) => ({ object_id: `segment-${i}`, timerange: '[0:0_2:0)' })) }, null, 2);
    });
    await detail.locator('details').evaluate((el: HTMLDetailsElement) => { el.open = true; });
    expect((await detail.boundingBox())!.height).toBeCloseTo(before!.height, 0);
    expect((await page.locator('#storage').boundingBox())!.y).toBeCloseTo(storage!.y, 0);
    expect(await detail.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; })).toBeGreaterThan(0);
    expect(await detail.evaluate(el => el.getBoundingClientRect().bottom <= document.getElementById('api-content')!.getBoundingClientRect().bottom + 1)).toBe(true);
  }
});

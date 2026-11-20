import { test, expect as browserExpect } from './fixtures';
const expect = browserExpect.configure({ timeout: 60000 });
import type { Page } from '@playwright/test';

export async function ready(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  await expect(page.locator('.walkthrough')).toHaveAttribute('aria-busy', 'false', { timeout: test.info().project.name === 'webkit' ? 240000 : 60000 });
  if (await page.locator('#demo-about').isVisible()) await page.locator('#demo-about').getByRole('button', { name: 'Close', exact: true }).click();
}
export async function branding(page: Page) {
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
export async function state(page: Page) {
  return page.evaluate(async () => {
    const roots = await (await fetch('/api/flows?tag.tasm.playpen.kind=source')).json();
    const flows = await Promise.all((roots[0]?.flow_collection ?? []).map(async ({ id }: { id: string }) => ({
      id, segments: await (await fetch(`/api/flows/${id}/segments`)).json(),
    })));
    return { roots, flows };
  });
}
export async function advance(page: Page, title: string) {
  await page.locator('#primary').click();
  // WebKit's persistent IndexedDB commits are slower than Chromium/Firefox.
  await expect(page.locator('#step-title')).toHaveText(title, { timeout: test.info().project.name === 'webkit' ? 240000 : 60000 });
  await ready(page);
}
export async function structure(page: Page) {
  await advance(page, 'Step 2. Add a video flow');
  await advance(page, 'Step 3. Store the sample media');
}
export async function example(page: Page) {
  await structure(page);
  await advance(page, 'Step 4. Play a time range');
  await expect(page.locator('[data-piece]')).toHaveCount(4);
}

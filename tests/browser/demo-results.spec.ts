import { test, expect as baseExpect } from './fixtures';
import type { Page } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 90000 });
test.use({ app: 'demo', showResultTips: true });
test.setTimeout(360000);

async function ready(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.walkthrough')).toHaveAttribute('aria-busy', 'false');
}
async function result(page: Page, step: number) {
  await expect(page.locator('#result-tip')).toBeVisible();
  await expect(page.locator('#result-tip')).toHaveAttribute('data-result-step', String(step));
  await ready(page);
  await expect(page.locator('#step-title')).toContainText(`Step ${step}.`);
  await expect(page.locator('#primary')).toBeEnabled();
  await expect(page.locator('#result-tip-title')).not.toBeFocused();
  expect(await page.locator('.result-target').count()).toBeGreaterThan(0);
}
async function dismiss(page: Page, step: number, method = 'close') {
  const mutations = () => page.locator('#requests pre').allTextContents().then(records => records.filter(record => ['PUT', 'POST', 'DELETE'].includes(JSON.parse(record).method)).length);
  const before = await mutations(), next = await page.locator('#primary').textContent();
  if (method === 'escape') await page.keyboard.press('Escape');
  else await page.locator('#result-tip-close').click();
  await expect(page.locator('#result-tip')).toBeHidden();
  await expect(page.locator('#step-title')).toContainText(`Step ${step}.`);
  await expect(page.locator('#primary')).toHaveText(next!);
  if (method === 'close') await expect(page.locator('#primary')).toBeFocused();
  expect(await mutations()).toBe(before);
  await expect(page.locator('.result-target, .result-object')).toHaveCount(0);
}
async function layout(page: Page, width: number, step: number) {
  await page.setViewportSize({ width, height: 844 });
  const popup = page.locator('#result-tip');
  await popup.scrollIntoViewIfNeeded();
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  for (const selector of ['.preview', '#structure', '#api-result:not([hidden])']) {
    if (!await page.locator(selector).count()) continue;
    const target = (await page.locator(selector).boundingBox())!;
    expect(box.x + box.width <= target.x || box.x >= target.x + target.width || box.y + box.height <= target.y || box.y >= target.y + target.height).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`result-${step}-${width}.png`), fullPage: true });
}

test('all eight actions work without dismissing explanations and retain their completed results', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 }); await page.goto('/'); await ready(page);
  await expect(page.locator('#playback-controls')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Got it', exact: true })).toHaveCount(0);
  for (const step of [1, 2, 3]) {
    await page.locator('#primary').click(); await result(page, step);
    if (step < 3) await expect(page.locator('#playback-controls')).toBeHidden();
    else await expect(page.locator('#playback-controls')).toBeVisible();
    await expect(page.locator('#primary')).toHaveText(['Next: Add a video flow', 'Next: Store the sample media', 'Next: Play a time range'][step - 1]);
    await layout(page, 1280, step);
  }
  await expect(page.getByRole('combobox', { name: 'Playback range' })).toBeVisible();
  await expect(page.locator('[data-piece]')).toHaveCount(4);
  await page.locator('#primary').click(); await ready(page);
  await page.locator('#pause').click();
  await expect(page.locator('#result-tip')).toBeHidden();
  await page.locator('#primary').click(); await result(page, 4);
  await expect(page.locator('video')).toHaveJSProperty('paused', true);
  for (const step of [5, 6, 7, 8]) {
    if (step === 8) await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = async (input, init) => {
        if (String(input).includes('/flow-delete-requests/')) {
          await new Promise<void>(resolve => { (window as any).finishDeletion = resolve; }); window.fetch = real;
        }
        return real(input, init);
      };
    });
    await page.locator('#primary').click();
    if (step === 8) {
      await expect.poll(() => page.evaluate(() => typeof (window as any).finishDeletion)).toBe('function');
      await expect(page.locator('#result-tip')).toBeHidden();
      await expect(page.locator('#primary')).toBeDisabled();
      await page.evaluate(() => (window as any).finishDeletion());
    }
    await result(page, step);
    if (step === 5 || step === 6) await expect(page.locator('#api-result')).toContainText('HTTP 200');
    if (step === 7) {
      await expect(page.locator('.flow-row:visible')).toHaveCount(2);
      await expect(page.locator('.pieces .result-object')).toHaveCount(4);
      await expect(page.locator('#storage-objects .result-object')).toHaveCount(2);
      await expect(page.locator('#result-tip-text')).toContainText('2 flows');
    }
    if (step === 8) {
      await expect(page.locator('.flow-row:visible')).toHaveCount(1);
      await expect(page.locator('.flow-row:visible .playhead-time')).toHaveText('Playback 0 s');
      await expect(page.locator('#storage-objects tr')).toHaveCount(2);
    }
    for (const width of [1280, 1024, 390]) await layout(page, width, step);
    await page.setViewportSize({ width: 1280, height: 844 });
  }
  await expect(page.locator('#primary')).toHaveText('Restart walkthrough');
  await page.locator('#replay').click(); await ready(page);
  await expect(page.locator('#result-tip')).toBeHidden();
  await page.locator('#restart').click(); await ready(page);
  await page.locator('#primary').click(); await result(page, 1);
  await expect(page.locator('#result-tip-title')).toHaveText('Using your saved source');
  await page.locator('[data-step="6"]').click();
  await expect(page.locator('#result-tip')).toBeHidden();
  await expect(page.locator('#step-title')).toContainText('Step 6.');
  await page.locator('#primary').click(); await result(page, 6);
  await expect(page.locator('#result-tip-text')).toContainText('2 segments');
  await dismiss(page, 6, 'escape');
  await expect(page.locator('#api-result')).toContainText('HTTP 200');
  await page.locator('[data-step="6"]').click(); await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#result-tip')).toBeHidden();
  await page.reload(); await ready(page);
  await expect(page.locator('#playback-controls')).toBeVisible();
  await page.locator('#restart').click(); await ready(page);
  await expect(page.locator('#playback-controls')).toBeVisible();
  await page.locator('#reset-demo').click();
  await Promise.all([page.waitForEvent('load'), page.locator('#reset-confirm').click()]); await ready(page);
  await expect(page.locator('#playback-controls')).toBeHidden();
});

for (const width of [1280, 390]) test(`result tips preserve focus and scroll at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 }); await page.goto('/'); await ready(page);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => {
      if (init?.method === 'PUT' && String(input).includes('/flows/')) {
        window.fetch = real;
        await new Promise<void>(resolve => { (window as any).finishSource = resolve; });
      }
      return real(input, init);
    };
  });
  await page.locator('#primary').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishSource)).toBe('function');
  await expect(page.locator('#primary')).toBeDisabled();
  await page.locator('#about-demo').focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  const scroll = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => (window as any).finishSource());
  await result(page, 1);
  await expect(page.getByRole('status')).toHaveText('Source created. Next, add its video flow.');
  await expect(page.locator('#about-demo')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await dismiss(page, 1, 'escape');
  await expect(page.locator('#about-demo')).toBeFocused();
  await page.locator('#primary').click(); await result(page, 2);
  await dismiss(page, 2);
});

test('tips handle retries, saved state, dismissal preferences and reset', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await page.evaluate(() => {
    const real = window.fetch; let fail = true;
    window.fetch = (input, init) => {
      if (fail && init?.method === 'PUT' && String(input).includes('/flows/')) { fail = false; return Promise.reject(new Error('Interrupted source creation')); }
      return real(input, init);
    };
  });
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#error')).toBeVisible(); await expect(page.locator('#result-tip')).toBeHidden();
  await page.locator('#retry').click(); await result(page, 1);
  await layout(page, 390, 1);
  await page.locator('#result-tip-hide').click();
  await expect(page.locator('#step-title')).toContainText('Step 1.');
  await expect(page.locator('#primary')).toHaveText('Next: Add a video flow');
  await page.reload(); await ready(page);
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#result-tip')).toBeHidden();
  await page.locator('#about-demo').click();
  await expect(page.locator('#show-result-tips')).not.toBeChecked();
  await page.locator('#show-result-tips').check(); await page.keyboard.press('Escape');
  await page.locator('#primary').click(); await result(page, 2);
  await page.locator('#about-demo').click();
  await expect(page.locator('#result-tip')).toBeHidden(); await page.keyboard.press('Escape');
  await expect(page.locator('#step-title')).toContainText('Step 2.');
  await expect(page.locator('#primary')).toHaveText('Next: Store the sample media');
  await page.locator('#restart').click(); await ready(page);
  await page.locator('#primary').click(); await result(page, 1);
  await expect(page.locator('#result-tip-title')).toHaveText('Using your saved source');
  await page.locator('#result-tip-hide').click();
  await page.locator('#reset-demo').click();
  await Promise.all([page.waitForEvent('load'), page.locator('#reset-confirm').click()]); await ready(page);
  expect(await page.evaluate(() => localStorage.getItem('tasm-demo:result-tips:v1'))).toBeNull();
  await page.locator('#primary').click(); await result(page, 1);
});

test('recovered deletion does not open an unsolicited explanation after reload', async ({ page }) => {
  await page.goto('/'); await ready(page);
  for (const step of [1, 2, 3]) {
    await page.locator('#primary').click(); await result(page, step); await dismiss(page, step);
  }
  await page.locator('#create-excerpt').click(); await page.locator('#primary').click();
  await result(page, 7); await dismiss(page, 7);
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/flow-delete-requests/')) {
        window.fetch = real; return Promise.resolve(Response.json({ summary: 'Lost deletion status' }, { status: 503 }));
      }
      return real(input, init);
    };
  });
  await page.locator('#primary').click(); await ready(page);
  await expect(page.locator('#error')).toBeVisible(); await expect(page.locator('#result-tip')).toBeHidden();
  await page.reload(); await ready(page);
  await expect(page.locator('#storage-objects tr')).toHaveCount(2); await ready(page);
  await expect(page.locator('#primary')).toHaveText('Restart walkthrough');
  await expect(page.locator('#result-tip')).toBeHidden();
  await expect(page.locator('.result-target, .result-object')).toHaveCount(0);
});

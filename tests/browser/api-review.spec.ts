import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { describeRequest, requestDetails, walkthrough } from '../../apps/playpen/api-review';
import type { RequestRecord } from '../../apps/shared/workspace-store';

const record = (path: string, method = 'GET', body?: unknown): RequestRecord => ({ url: `http://localhost/${path}`, method, body, headers: {}, status: 200, ms: 12 });

test('review explains recorded endpoints and does not infer a successful result', () => {
  for (const [request, title] of [
    [record('api/flows/root', 'PUT', { format: 'urn:x-nmos:format:multi' }), 'Create source collection'],
    [record('api/flows/video', 'PUT', { format: 'urn:x-nmos:format:video' }), 'Create media flow'],
    [{ ...record('api/flows/video', 'PUT'), stage: 'segment' }, 'Prepare replacement flow'],
    [record('api/flows/video/storage', 'POST', { object_ids: ['object-1'] }), 'Allocate media storage'],
    [record('media/object-1', 'PUT', { file: 'clip.ts', bytes: 1024 }), 'Upload media bytes'],
    [record('api/flows/video/segments', 'POST', { object_id: 'object-1', timerange: '[2:0_4:0)' }), 'Register a segment'],
    [record('api/flows/root/flow_collection', 'PUT', []), 'Publish flow collection'],
    [{ ...record('api/flows/old', 'DELETE'), stage: 'update' }, 'Retire a flow'],
    [record('api/flows/video/segments?timerange=%5B2%3A0_4%3A0)'), 'Query a time range'],
    [record('api/flows/video/segments'), 'Read flow segments'],
    [record('media/object-1'), 'Read media bytes'],
    [record('media/object-1', 'HEAD'), 'Check stored object'],
    [record('api/flows/video/label', 'PUT', 'New name'), 'Rename source or flow'],
    [record('api/flows/video'), 'Read source or flow metadata'],
    [record('api/sources?limit=100'), 'Read source or flow metadata'],
    [record('api/unknown', 'PATCH'), 'API request'],
  ] as [RequestRecord, string][]) expect(describeRequest(request).title).toBe(title);
  const upload = record('media/object-1', 'PUT', { file: 'clip.ts', bytes: 1024 });
  expect(describeRequest(upload).context).toContainEqual(['Bytes sent', '1024']);
  expect(describeRequest({ ...upload, ms: undefined }).state).toBe('Pending');
  expect(describeRequest({ ...upload, ms: undefined }).outcome).not.toContain('were stored');
  expect(describeRequest({ ...upload, status: 503, error: 'Write failed' }).outcome).toContain('Do not assume');
  expect(describeRequest({ ...upload, status: undefined }).state).toBe('Unknown');
  const query = { ...record('api/flows/video/segments?timerange=%5B2%3A0_4%3A0)'), response: [{ object_id: 'object-1' }] };
  expect(describeRequest(query).context).toContainEqual(['Requested time range', '[2:0_4:0)']);
  expect(describeRequest(query).outcome).toContain('1 segment reference was');
  expect(requestDetails({ ...upload, body: '<img src=x onerror=alert(1)>', response: null, status: 204 })).toContain('&lt;img');
  expect(requestDetails({ ...upload, response: null, status: 204 })).toContain('(empty)');
  const partial = { ...record('api/flows/video/segments', 'POST', [{ object_id: 'object-1' }]), response: { failed_segments: [{ object_id: 'object-1' }] } };
  expect(describeRequest(partial).state).toBe('Failed');
  expect(describeRequest({ ...record('api/flows/old', 'DELETE'), status: 202 }).outcome).toContain('pending');
  const stages = walkthrough({ id: 'move', name: 'Move media', pending: false, requests: [record('api/flows/root'), record('api/flows/video/segments'), partial], events: [{ position: 2, title: 'Reuse stored media', detail: 'Reuse 4 objects.', state: 'Succeeded', ms: 1 }] });
  expect(stages.map(s => s.title)).toEqual(['Read current arrangement', 'Reuse stored media', 'Register segments']);
  expect(stages[0].records).toHaveLength(2); expect(stages[2].state).toBe('Failed');
});

test('review retains its position, focus and data while calls arrive or history expires', async ({ page }) => {
  const html = (await readFile('apps/playpen/index.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  await page.route('**/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/playpen.css', route => route.fulfill({ contentType: 'text/css', path: 'apps/playpen/style.css' }));
  await page.goto('/');
  const bundle = await build({ entryPoints: ['apps/playpen/api-review.ts'], bundle: true, format: 'iife', globalName: 'ReviewTest', write: false });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const w = window as any;
    w.reviewActions = []; w.reviewFetches = 0;
    window.fetch = async () => { w.reviewFetches++; throw new Error('Review must not fetch'); };
    w.reviewUpdate = w.ReviewTest.wireReview(() => w.reviewActions, () => 'chosen');
    w.reviewUpdate();
  });
  await expect(page.locator('#review-requests')).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any;
    w.reviewActions = [{ id: 'other', name: 'Other action', requests: [], pending: false }, {
      id: 'chosen', name: '<Place media>', pending: true,
      requests: [{ method: 'POST', url: 'http://localhost/api/flows/video/storage', headers: {}, body: { object_ids: ['object-1'] } }],
    }];
    w.reviewUpdate();
  });
  await page.locator('#review-requests').click();
  await expect(page.locator('#review-action')).toHaveValue('chosen');
  await expect(page.locator('#review-position')).toHaveText('Call 1 of 1');
  await expect(page.locator('#review-detail')).toContainText('still in progress');
  const payload = page.locator('#review-detail details').first();
  await payload.locator('summary').click();
  await page.evaluate(() => {
    const w = window as any, action = w.reviewActions[1];
    Object.assign(action.requests[0], { status: 200, ms: 20, response: { media_objects: [{ object_id: 'object-1' }] } });
    action.requests.push({ method: 'PUT', url: 'http://localhost/media/object-1', headers: {}, body: { file: 'clip.ts', bytes: 256 } });
    w.reviewUpdate();
  });
  await expect(payload).toHaveAttribute('open', '');
  await expect(payload.locator('summary')).toBeFocused();
  await expect(page.locator('#review-position')).toHaveText('Call 1 of 2');
  await expect(page.locator('#review-detail')).toContainText('Upload locations were returned');
  await page.locator('#review-next').click();
  await expect(page.locator('#review-detail h3')).toHaveText('Upload media bytes');
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.reviewActions[1].requests[1], { status: 503, ms: 50, error: 'Injected write failure: ' + 'x'.repeat(180), response: { details: 'Response details\n'.repeat(1000) } });
    w.reviewActions[1].pending = false; w.reviewActions[1].error = 'Injected write failure';
    w.reviewUpdate();
  });
  await expect(page.locator('#review-detail .review-outcome')).toContainText('Do not assume');
  await page.locator('#review-detail details').nth(2).locator('summary').click();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const dialog = await page.locator('#api-review').boundingBox();
    expect(dialog!.x).toBeGreaterThanOrEqual(0); expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(width);
    expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(900);
    expect(await page.locator('#review-detail').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator('#review-detail').evaluate(el => { el.scrollTop = 200; return el.scrollTop; })).toBeGreaterThan(0);
    await expect(page.locator('#review-close')).toBeInViewport(); await expect(page.locator('#review-next')).toBeInViewport();
    const storageY = await page.locator('#storage').evaluate(el => el.getBoundingClientRect().top + window.scrollY);
    await page.evaluate(() => (window as any).reviewUpdate());
    expect(await page.locator('#review-detail').evaluate(el => el.scrollTop)).toBe(200);
    expect(await page.locator('#storage').evaluate(el => el.getBoundingClientRect().top + window.scrollY)).toBe(storageY);
  }
  // Normal history eviction must not discard the action currently being reviewed.
  await page.evaluate(() => { const w = window as any; w.reviewChosen = w.reviewActions[1]; w.reviewActions = [w.reviewActions[0]]; w.reviewUpdate(); });
  await expect(page.locator('#review-action')).toHaveValue('chosen');
  await expect(page.locator('#review-position')).toHaveText('Call 2 of 2');
  await page.locator('#review-previous').click(); await expect(page.locator('#review-detail h3')).toHaveText('Allocate media storage');
  await page.locator('#review-action').selectOption('other');
  await expect(page.locator('#review-detail')).toContainText('No API calls');
  await expect(page.locator('#review-next')).toBeDisabled(); await expect(page.locator('#review-previous')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#api-review')).not.toBeVisible(); await expect(page.locator('#review-requests')).toBeFocused();
  expect(await page.evaluate(() => (window as any).reviewFetches)).toBe(0);
  await expect(page.locator('#follow-requests')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#activity-summary')).toHaveText('No actions yet.');
  await page.evaluate(() => { const w = window as any; w.reviewActions.push(w.reviewChosen); w.reviewUpdate(); });
  await page.locator('#walkthrough-requests').click();
  await page.locator('#review-action').selectOption('chosen');
  await expect(page.locator('#review-title')).toHaveText('API call explanations');
  await expect(page.locator('#review-position')).toHaveText('Stage 1 of 2');
  await expect(page.locator('#review-detail details')).toHaveCount(0);
  await page.locator('#review-next').click();
  await expect(page.locator('#review-detail')).toContainText('stage failed');
  await page.locator('#review-mode').click();
  await expect(page.locator('#review-position')).toHaveText('Call 2 of 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('#walkthrough-requests')).toBeFocused();
  expect(await page.evaluate(() => (window as any).reviewFetches)).toBe(0);
});

test('review walks real placement and range-read calls without sending more requests', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  const ready = () => expect(page.locator('body')).not.toHaveClass(/busy/, { timeout: 90000 });
  for (const [button, name] of [['#new-source', 'Review laboratory'], ['#add-video', 'Picture']]) {
    await page.locator(button).click(); await page.locator('#entity-name').fill(name); await page.locator('#dialog-submit').click(); await ready();
    if (button !== '#new-source') { await page.locator('#save-draft').click(); await ready(); }
  }
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await page.locator('#save-draft').click(); await ready();
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('#preview-status')).toHaveText('Source ready · press play to preview', { timeout: 60000 });
  await expect(page.locator('#storage')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#action-history').selectOption({ label: 'Save draft' });
  const count = await page.locator('#request-count').textContent(), selectedRequest = await page.locator('#requests .selected').getAttribute('data-request');
  // The player keeps filling its buffer after the controls become ready.
  // Finish those media reads before measuring requests made by the review dialog.
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => {
    const ranges = video.buffered;
    return ranges.length > 0 && ranges.end(ranges.length - 1) >= video.duration - 0.05;
  }), { timeout: 30000 }).toBe(true);
  await page.evaluate(() => {
    const w = window as any, real = window.fetch; w.reviewCalls = [];
    window.fetch = (input, init) => { w.reviewCalls.push(String(input)); return real(input, init); };
  });
  await page.locator('#review-requests').click();
  await expect(page.locator('#review-position')).toHaveText(`Call 1 of ${count}`);
  for (const title of ['Prepare replacement flow', 'Allocate media storage', 'Upload media bytes', 'Register segments', 'Publish flow collection', 'Retire a flow']) {
    await page.locator('#review-requests-list button').filter({ hasText: title }).first().click();
    await expect(page.locator('#review-detail h3')).toHaveText(title);
    await expect(page.locator('#review-detail .review-outcome')).toContainText('HTTP 20');
  }
  await page.locator('#review-close').click();
  expect(await page.evaluate(() => (window as any).reviewCalls)).toEqual([]);
  await expect(page.locator('#action-history option:checked')).toHaveText('Save draft');
  await expect(page.locator('#requests .selected')).toHaveAttribute('data-request', selectedRequest!);
  await expect(page.locator('#follow-requests')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#range-start').fill('0.5'); await page.locator('#range-end').fill('1.5'); await page.locator('#read-range').click(); await ready();
  await page.locator('#review-requests').click();
  await expect(page.locator('#review-action option:checked')).toHaveText('Read time range');
  await expect(page.locator('#review-detail h3')).toHaveText('Query a time range');
  await expect(page.locator('#review-detail')).toContainText('Requested time range');
  await page.locator('#review-next').click(); await expect(page.locator('#review-detail h3')).toHaveText('Read media bytes');
  await expect(page.locator('#review-detail')).toContainText('Bytes received');
  await page.locator('#review-close').click();
  await expect(page.locator('#play-range')).toBeEnabled();
});

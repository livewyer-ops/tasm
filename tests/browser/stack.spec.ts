import { test, expect } from './fixtures';

test('browser fetch uses WASM, PostgreSQL and durable object storage', async ({ page }) => {
  page.on('pageerror', error => console.error(error));
  await page.goto('/');
  await page.evaluate(() => (window as any).tasmReady);
  const result = await page.evaluate(async () => {
    const { apiUrl } = await (window as any).tasmReady;
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(apiUrl + path, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${text}`);
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const service = await call('service');
    const flow = crypto.randomUUID(), source = crypto.randomUUID();
    const created = await call(`flows/${flow}`, 'PUT', { id: flow, source_id: source,
      format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t',
      essence_parameters: { sample_rate: 48000, channels: 2 } });
    const allocated = await call(`flows/${flow}/storage`, 'POST', { object_ids: ['test /%2F/media.bin'] });
    const object = allocated.body.media_objects[0];
    const uploaded = await fetch(object.put_url.url, { method: 'PUT', headers: { 'content-type': object.put_url['content-type'] }, body: 'abcdef' });
    if (!uploaded.ok) throw new Error(`upload: ${uploaded.status} ${await uploaded.text()}`);
    await call(`flows/${flow}/segments`, 'POST', { object_id: object.object_id, timerange: '[0:0_1:0)' });
    const segments = await call(`flows/${flow}/segments`);
    const download = segments.body[0].get_urls[0].url;
    const read = await fetch(download, { headers: { range: 'bytes=1-3' } });
    const metadata = await call(`objects/${encodeURIComponent(object.object_id)}`);
    (window as any).savedFlow = flow;
    return { service: service.body, created: created.status, rangeStatus: read.status,
      bytes: await read.text(), object: metadata.body, download, flow };
  });
  expect(result.service.api_version).toBe('8.2');
  expect(result.created).toBe(201);
  expect(result.rangeStatus).toBe(206);
  expect(result.bytes).toBe('bcd');
  await page.reload(); await page.evaluate(() => (window as any).tasmReady);
  expect(await page.evaluate(async url => (await fetch(url)).text(), result.download)).toBe('abcdef');
  expect(await page.evaluate(async flow => (await fetch(`/api/flows/${flow}`)).status, result.flow)).toBe(200);
});

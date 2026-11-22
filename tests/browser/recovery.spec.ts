import { test, expect, browserEnv, listen, closeServer } from './fixtures';
import { createServer, get } from 'node:http';
import { get as getHTTPS } from 'node:https';

test('failed uploads stay unpublished and webhook retries survive browser restart', { tag: '@pr' }, async ({ page, context, playwright, browserName, profile, baseURL }) => {
  test.setTimeout(browserName === 'webkit' ? 150000 : 90000);
  // Stop the asset server to test real network loss. WebKit's emulated
  // offline mode can abort navigation before the service worker runs.
  const assets = createServer((request, response) => {
    const url = new URL(request.url!, baseURL);
    (url.protocol === 'https:' ? getHTTPS : get)(url, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(response);
    }).on('error', () => response.destroy());
  });
  const assetsURL = await listen(assets);
  const host = assetsURL.href;
  const deliveries: { id: string | string[] | undefined; body: any }[] = [];
  const receiver = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type,x-tasm-delivery-id');
    response.setHeader('access-control-allow-methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', () => {
      deliveries.push({ id: request.headers['x-tasm-delivery-id'], body: JSON.parse(body) });
      response.writeHead(deliveries.length === 1 ? 503 : 204).end();
    });
  });
  const receiverURL = await listen(receiver);
  let reopened;
  try {
    await page.goto(host); await page.evaluate(() => (window as any).tasmReady);
    const result = await page.evaluate(async receiverPort => {
      const call = async (path: string, method = 'GET', body?: unknown) => {
        const r = await fetch(`/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await r.text(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
        return text ? JSON.parse(text) : null;
      };
      const id = crypto.randomUUID();
      const flow = { id, source_id: crypto.randomUUID(), format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'audio/mp4', essence_parameters: { sample_rate: 48000, channels: 2 } };
      await call(`flows/${id}`, 'PUT', flow);
      const { put_url: put, object_id } = (await call(`flows/${id}/storage`, 'POST', {})).media_objects[0];
      const bad = await fetch(put.url, { method: 'PUT', headers: { 'content-type': put['content-type'], 'content-md5': 'invalid' }, body: 'wrong checksum' });
      const unpublished = await fetch(put.url);
      const bytes = new Uint8Array(2 * 1024 * 1024 + 3); bytes.fill(97); bytes[bytes.length - 1] = 122;
      const uploaded = await fetch(put.url, { method: 'PUT', headers: { 'content-type': put['content-type'] }, body: bytes });
      if (!uploaded.ok) throw new Error(`PUT object: ${uploaded.status} ${await uploaded.text()}`);
      await call(`flows/${id}/segments`, 'POST', { object_id, timerange: '[-1:0_0:0)' });
      const overwritten = await fetch(put.url, { method: 'PUT', headers: { 'content-type': put['content-type'] }, body: 'overwrite' });
      const head = await fetch(put.url, { method: 'HEAD' });
      const suffix = await fetch(put.url, { headers: { range: 'bytes=-3' } });
      const multi = await fetch(put.url, { headers: { range: 'bytes=0-1, 4-5' } });
      if (multi.status !== 200 || (await multi.arrayBuffer()).byteLength !== bytes.length) throw new Error('Multi-range response did not return the full object.');
      const badRange = await fetch(put.url, { headers: { range: 'bytes=999999999-' } });
      const conditional = await fetch(put.url, { headers: { 'if-none-match': head.headers.get('etag')! } });
      const etag = head.headers.get('etag')!;
      const conditions: Record<string, string>[] = [
        { 'if-match': '"old"', 'if-none-match': etag },
        { 'if-match': `"other,tag", ${etag}` }, { 'if-match': `W/${etag}` },
        { 'if-none-match': `"old", W/${etag}` }, { 'if-match': '*' }, { 'if-none-match': '*' }
      ];
      const conditionalHeads = await Promise.all(conditions.map(async headers => (await fetch(put.url, { method: 'HEAD', headers })).status));
      const prefix = await call('flows?limit=1');
      // Simulate an unpublished file left by a process crash.
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('tasm-%2F');
      const file = await (await dir.getFileHandle('crash-orphan', { create: true })).createWritable(); await file.write('partial'); await file.close();
      await call('service/webhooks', 'POST', { url: `http://127.0.0.1:${receiverPort}/events`, events: ['flows/created'] });
      const eventFlow = crypto.randomUUID();
      await call(`flows/${eventFlow}`, 'PUT', { ...flow, id: eventFlow, source_id: crypto.randomUUID() });
      return { flow: id, url: put.url, bad: bad.status, unpublished: unpublished.status, overwrite: overwritten.status,
        size: head.headers.get('content-length'), suffix: await suffix.text(), badRange: badRange.status, conditional: conditional.status, conditionalHeads, pageLength: prefix.length };
    }, Number(receiverURL.port));
    expect(result).toMatchObject({ bad: 400, unpublished: 404, overwrite: 409, size: String(2 * 1024 * 1024 + 3), suffix: 'aaz', badRange: 416, conditional: 304, conditionalHeads: [412, 200, 412, 304, 200, 304], pageLength: 1 });
    await expect.poll(() => deliveries.length, { timeout: 15000 }).toBe(1);
    // API work is serialized after the worker's retry-state commit.
    expect(await page.evaluate(async () => (await fetch('/api/service')).status)).toBe(200);
    await context.close();
    reopened = await playwright[browserName].launchPersistentContext(profile, { headless: true, baseURL, env: browserEnv });
    const restored = await reopened.newPage(); await restored.goto(host);
    await restored.evaluate(() => (window as any).tasmReady);
    expect(await restored.evaluate(async id => (await fetch(`/api/flows/${id}`)).status, result.flow)).toBe(200);
    expect(await restored.evaluate(async url => (await fetch(url, { headers: { range: 'bytes=-1' } })).text(), result.url)).toBe('z');
    expect(await restored.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('tasm-%2F');
      try { await dir.getFileHandle('crash-orphan'); return true; } catch (error) { if ((error as DOMException).name === 'NotFoundError') return false; throw error; }
    })).toBe(false);
    await expect.poll(() => deliveries.length, { timeout: 45000, intervals: [500, 1000] }).toBe(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    await closeServer(assets);
    await restored.reload(); await restored.evaluate(() => (window as any).tasmReady);
    expect(await restored.evaluate(async url => (await fetch(url, { headers: { range: 'bytes=-1' } })).text(), result.url)).toBe('z');
  } finally {
    await reopened?.close();
    await closeServer(assets);
    await closeServer(receiver);
  }
});

test('quota failure and object reuse cannot publish stale bytes', { tag: '@pr' }, async ({ page }) => {
  const { readFile } = await import('node:fs/promises');
  const worker = await readFile(`${process.env.TASM_DIST ?? 'dist'}/core/worker.js`, 'utf8');
  expect(worker).toContain('import.meta.url');
  const injected = `
    const nativeTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 1000 ? 60000 : delay, ...args);
    const realWrite = FileSystemWritableFileStream.prototype.write;
    let rejectWrite = true;
    FileSystemWritableFileStream.prototype.write = function(chunk) {
      if (rejectWrite) { rejectWrite = false; return Promise.reject(new DOMException('Injected quota failure', 'QuotaExceededError')); }
      return realWrite.call(this, chunk);
    };
    ${worker}`;
  // Run the same bundle with one failing native write. Blob workers avoid
  // Playwright's differing interception support for shared-worker scripts.
  await page.addInitScript(source => {
    const NativeWorker = SharedWorker;
    window.SharedWorker = class extends NativeWorker {
      constructor(url: string | URL, options?: string | WorkerOptions) {
        const rebased = source.replaceAll('import.meta.url', JSON.stringify(String(url)));
        super(URL.createObjectURL(new Blob([rebased], { type: 'text/javascript' })), options);
      }
    };
  }, injected);
  await page.goto('/'); await page.evaluate(() => (window as any).tasmReady);
  const result = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    const create = await fetch(`/api/flows/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, source_id: crypto.randomUUID(), format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'audio/mp4', essence_parameters: { sample_rate: 48000, channels: 2 } }) });
    if (!create.ok) throw new Error(await create.text());
    const allocated = await fetch(`/api/flows/${id}/storage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const allocation = (await allocated.json()).media_objects[0], put = allocation.put_url;
    const upload = () => fetch(put.url, { method: 'PUT', headers: { 'content-type': put['content-type'] }, body: 'durable' });
    const failed = await upload(), missing = await fetch(put.url), retried = await upload(), read = await fetch(put.url);
    const body = await read.text();
    const segments = `/api/flows/${id}/segments`;
    const register = () => fetch(segments, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_id: allocation.object_id, timerange: '[0:0_1:0)' }) });
    if (!(await register()).ok) throw new Error('Initial registration failed');
    if (!(await fetch(`${segments}?object_id=${encodeURIComponent(allocation.object_id)}`, { method: 'DELETE' })).ok) throw new Error('Deletion failed');
    const reused = await fetch(`/api/flows/${id}/storage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ object_ids: [allocation.object_id] }) });
    if (!reused.ok) throw new Error(await reused.text());
    const staleRead = await fetch(put.url), staleRegistration = await register();
    return { failed: failed.status, missing: missing.status, retried: retried.status, body, staleRead: staleRead.status, staleRegistration: staleRegistration.status };
  });
  expect(result).toEqual({ failed: 507, missing: 404, retried: 200, body: 'durable', staleRead: 404, staleRegistration: 400 });
});

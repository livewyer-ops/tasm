import { type Page } from '@playwright/test';
import { test, expect as browserExpect } from './fixtures';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Queue jobs include real durable writes, which are slower in WebKit.
const expect = browserExpect.configure({ timeout: 30000 });
const spec = JSON.parse(readFileSync(`${process.env.TASM_DIST ?? 'dist'}/core/openapi.json`, 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const backends = [{ id: '81d13d58-5041-4580-91f9-38ce03daef19', label: 'Browser storage' },
  { id: 'ddc7c7c6-d1bb-4c3e-856a-03a5cd5dfae1', label: 'Local copy' }];
const audio = { format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t',
  essence_parameters: { sample_rate: 48000, channels: 2 } };

async function start(page: Page) {
  await page.route('**/', route => route.fulfill({ contentType: 'text/html', body:
    `<script type="module">import {startTasm} from './index.js'; window.tasmReady=startTasm(${JSON.stringify({ basePath: '/', backends })});</script>` }));
  await page.goto('/');
  await page.evaluate(() => (window as any).tasmReady);
}
function client(page: Page) {
  const covered = new Set<string>();
  async function call(path: string, method = 'GET', body?: unknown, expected?: number) {
    if (process.env.TASM_TRACE) console.log(method, path);
    const result = await page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
    }, { path, method, body });
    const template = Object.keys(spec.paths).find(p => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path.split('?')[0]));
    expect(template, `${method} ${path} exists in the TAMS contract`).toBeTruthy();
    const op = spec.paths[template!][method.toLowerCase()];
    expect(op, `${method} ${template}`).toBeTruthy();
    covered.add(`${method} ${template}`);
    expect(result.status, `${method} ${path}: ${result.text}`).toBe(expected ?? 200);
    const response = op.responses[String(result.status)];
    expect(response, `${method} ${template} response ${result.status}`).toBeTruthy();
    let value: any;
    if (result.text) {
      value = JSON.parse(result.text);
      const schema = response.content?.['application/json']?.schema;
      if (!schema && result.status >= 400) {
        expect(value).toEqual(expect.objectContaining({ type: expect.any(String), summary: expect.any(String), time: expect.any(String) }));
        return { ...result, value };
      }
      expect(schema, `${method} ${template} JSON response schema`).toBeTruthy();
      const validate = ajv.getSchema(`${method} ${template} ${result.status}`) ?? ajv.addSchema(schema, `${method} ${template} ${result.status}`).getSchema(`${method} ${template} ${result.status}`)!;
      expect(validate(value), `${method} ${path}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    if (method === 'HEAD') expect(result.text).toBe('');
    return { ...result, value };
  }
  async function get(path: string) { const result = await call(path); await call(path, 'HEAD'); return result; }
  return { call, get, covered };
}

test('all TAMS 8.2 operations, response schemas and durable workers', async ({ page, context, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 240000 : 120000);
  const deliveries: any[] = [];
  const receiver = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type,x-tasm-delivery-id');
    response.setHeader('access-control-allow-methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', () => { deliveries.push(JSON.parse(body)); response.writeHead(204).end(); });
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  try {
    await start(page);
    const { call, get, covered } = client(page);
    await get('/'); await get('/service');
    await call('/service', 'POST', { name: 'Contract test', description: 'Browser-local TAMS' });
    expect((await get('/service')).value.name).toBe('Contract test');
    expect((await get('/service/storage-backends')).value).toHaveLength(2);
    const profile = randomUUID();
    await call(`/service/profiles/${profile}`, 'POST', { id: profile, label: 'AAC', flow_metadata: audio }, 201);
    await get('/service/profiles'); await get(`/service/profiles/${profile}`);
    const hook = await call('/service/webhooks', 'POST', {
      url: `http://127.0.0.1:${(receiver.address() as any).port}/events`, events: ['flows/created'] }, 201);
    const webhookId = hook.value.id;
    await get('/service/webhooks'); await get(`/service/webhooks/${webhookId}`);
    const flow = randomUUID(), source = randomUUID(), other = randomUUID();
    await call(`/flows/${flow}`, 'PUT', { id: flow, source_id: source, ...audio }, 201);
    await call(`/flows/${other}`, 'PUT', { id: other, source_id: randomUUID(), ...audio }, 201);
    await get('/flows'); await get(`/flows/${flow}`); await get('/sources'); await get(`/sources/${source}`);
    // These source and flow mutations exercise transaction commit and reuse.
    for (const entity of [`/flows/${flow}`, `/sources/${source}`]) {
      for (const field of ['description', 'label']) {
        await call(`${entity}/${field}`, 'PUT', `A ${field}`, 204);
        expect((await get(`${entity}/${field}`)).value).toBe(`A ${field}`);
        await call(`${entity}/${field}`, 'DELETE', undefined, 204);
      }
      const tag = `${entity}/tags/${encodeURIComponent('producer / %2F')}`;
      await call(tag, 'PUT', ['Alice', 'Bob'], 204); await get(`${entity}/tags`); await get(tag);
      await call(tag, 'DELETE', undefined, 204);
    }
    for (const field of ['max_bit_rate', 'avg_bit_rate']) {
      await call(`/flows/${flow}/${field}`, 'PUT', 128, 204); await get(`/flows/${flow}/${field}`);
      expect(await page.evaluate(async ({ flow, field }) => (await fetch(`/api/flows/${flow}/${field}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '9007199254740993',
      })).status, { flow, field })).toBe(204);
      expect((await call(`/flows/${flow}/${field}`)).text).toBe('9007199254740993');
      await call(`/flows/${flow}/${field}`, 'DELETE', undefined, 204);
    }
    await call(`/flows/${flow}/flow_collection`, 'PUT', [{ id: other, role: 'alternative' }], 204);
    await get(`/flows/${flow}/flow_collection`);
    await call(`/flows/${flow}/flow_collection`, 'DELETE', undefined, 204);
    await call(`/flows/${flow}/read_only`, 'PUT', true, 204); await get(`/flows/${flow}/read_only`);
    await call(`/flows/${flow}/label`, 'PUT', 'forbidden', 403);
    await call(`/flows/${flow}/read_only`, 'PUT', false, 204);
    // Rejected transaction must leave the connection usable.
    await call(`/flows/${flow}/flow_collection`, 'PUT', [{ id: flow }], 400);
    await call(`/flows/${flow}/label`, 'PUT', 'still writable', 204);
    const objectId = 'contract /%2F/media.bin', objectPath = `/objects/${encodeURIComponent(objectId)}`;
    const allocated = await call(`/flows/${flow}/storage`, 'POST', { object_ids: [objectId] }, 201);
    const put = allocated.value.media_objects[0].put_url;
    expect(await page.evaluate(async put => (await fetch(put.url, { method: 'PUT',
      headers: { 'content-type': put['content-type'] }, body: 'abcdef' })).status, put)).toBe(200);
    await call(`/flows/${flow}/segments`, 'POST', { object_id: objectId,
      timerange: '[281474976710654:0_281474976710655:999999999)' }, 201);
    const segments = await get(`/flows/${flow}/segments`);
    expect(segments.value[0].timerange).toBe('[281474976710654:0_281474976710655:999999999)');
    await get(objectPath);
    await call(`/flows/${other}/segments`, 'POST', { object_id: objectId,
      timerange: '[281474976710654:0_281474976710655:999999999)' }, 201);
    const firstPage = await call(`${objectPath}?limit=1`);
    expect(firstPage.value.referenced_by_flows).toHaveLength(1);
    const next = new URL(firstPage.headers.link.match(/^<([^>]+)>/)![1]);
    expect(next.pathname).toBe(`/api${objectPath}`);
    const nextPage = await call(next.pathname.slice('/api'.length) + next.search);
    expect(nextPage.value.referenced_by_flows).toHaveLength(1);
    expect(nextPage.value.referenced_by_flows).not.toEqual(firstPage.value.referenced_by_flows);
    await call(`${objectPath}/instances`, 'POST', { storage_id: backends[1].id }, 201);
    await expect.poll(async () => (await call(objectPath)).value.get_urls.length).toBe(2);
    const copied = (await call(objectPath)).value.get_urls.find((v: any) => v.label === backends[1].label);
    expect(await page.evaluate(async url => (await fetch(url)).text(), copied.url)).toBe('abcdef');
    await call(`${objectPath}/instances?storage_id=${backends[1].id}`, 'DELETE', undefined, 204);
    await expect.poll(async () => page.evaluate(async url => (await fetch(url)).status, copied.url)).toBe(404);
    await expect.poll(() => deliveries.length).toBeGreaterThan(0);
    expect(deliveries.some(v => v.event_type === 'flows/created' && v.event.flow.id === flow)).toBe(true);
    await call(`/service/webhooks/${webhookId}`, 'PUT', { ...hook.value, status: 'disabled' }, 201);
    await call(`/service/webhooks/${webhookId}`, 'DELETE', undefined, 204);
    const deleted = await call(`/flows/${flow}/segments`, 'DELETE', undefined, 202);
    expect(deleted.headers.location).toContain('/api/flow-delete-requests/');
    await get('/flow-delete-requests'); await get(`/flow-delete-requests/${deleted.value.id}`);
    await expect.poll(async () => (await call(`/flow-delete-requests/${deleted.value.id}`)).value.status).toBe('done');
    expect((await call(`/flows/${flow}/segments`)).value).toEqual([]);
    await call(`/flows/${flow}`, 'DELETE', undefined, 204);
    await call(`/flows/${other}/segments?object_id=${encodeURIComponent(objectId)}`, 'DELETE', undefined, 204);
    await expect.poll(async () => page.evaluate(async url => (await fetch(url)).status, put.url)).toBe(404);
    // Another tab shares the same owner and persisted metadata.
    const second = await context.newPage(); await second.goto('/');
    await second.evaluate(() => (window as any).tasmReady);
    expect(await second.evaluate(async id => (await fetch(`/api/flows/${id}`)).status, other)).toBe(200);
    await second.close();
    const expected = Object.entries(spec.paths).flatMap(([path, methods]: [string, any]) =>
      Object.keys(methods).filter(m => ['get', 'head', 'put', 'post', 'delete'].includes(m)).map(m => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(expected.sort());
  } finally { await new Promise<void>(resolve => receiver.close(() => resolve())); }
});

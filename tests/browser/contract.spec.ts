import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runContract } from '../contract/client';
import { test, expect, ready, listen, closeServer } from './fixtures';

const backends = [{ id: '81d13d58-5041-4580-91f9-38ce03daef19', label: 'Browser storage' },
  { id: 'ddc7c7c6-d1bb-4c3e-856a-03a5cd5dfae1', label: 'Local copy' }];

test('all TAMS 8.2 operations, response schemas and durable workers', { tag: '@pr' }, async ({ page, context, browserName }, info) => {
  test.setTimeout(browserName === 'webkit' ? 240000 : 120000);
  const spec = JSON.parse(readFileSync(`${process.env.TASM_DIST ?? 'dist'}/core/openapi.json`, 'utf8'));
  const created = new Set<string>();
  const receiver = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type,x-tasm-delivery-id');
    response.setHeader('access-control-allow-methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const event = JSON.parse(body);
      if (event.event_type === 'flows/created') created.add(event.event.flow.id);
      response.writeHead(204).end();
    });
  });
  const receiverURL = await listen(receiver);
  try {
    await page.route('**/', route => route.fulfill({ contentType: 'text/html', body:
      `<script type="module">import {startTasm} from './index.js'; window.tasmReady=startTasm(${JSON.stringify({ basePath: '/', backends })});</script>` }));
    await page.goto('/');
    await page.evaluate(() => (window as any).tasmReady);
    const { operations, remainingFlow } = await runContract(spec, {
      apiRoot: new URL('/api/', page.url()).href,
      webhookURL: new URL('/events', receiverURL).href,
      observedFlowCreated: async flow => created.has(flow),
      request: input => page.evaluate(async ({ path, method, body }) => {
        const response = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json' }, body });
        return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
      }, input),
      media: input => page.evaluate(async ({ url, method, headers, bytes }) => {
        const response = await fetch(url, { method, headers, body: bytes && new Uint8Array(bytes) });
        return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
      }, input),
    });
    await info.attach('covered-operations', { body: operations.join('\n'), contentType: 'text/plain' });
    // Another tab shares the same owner and persisted metadata.
    const second = await context.newPage(); await second.goto('/');
    await ready(second);
    const savedFlow = await second.evaluate(async id => (await (await fetch(`/api/flows/${id}`)).json()).id, remainingFlow);
    expect(savedFlow).toBe(remainingFlow);
    await second.close();
  } finally { await closeServer(receiver); }
});

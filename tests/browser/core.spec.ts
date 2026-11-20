import { test, expect } from './fixtures';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

for (const prefix of ['/tasm/', '/']) test(`standalone core works at ${prefix} without either website`, async ({ page }) => {
  let offline = false;
  const types: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  const server = createServer(async (request, response) => {
    if (offline) { request.socket.destroy(); return; }
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (!path.startsWith(prefix)) { response.writeHead(404).end(); return; }
    if (path === prefix) {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<script type="module">
        import { startTasm } from './index.js'; window.tasmReady = startTasm(${prefix === '/' ? "{ basePath: '/' }" : ''});
      </script>`);
      return;
    }
    try {
      const file = path.slice(prefix.length);
      const bytes = await readFile(resolve(process.env.TASM_DIST ?? 'dist', 'core', file));
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await page.goto(origin + prefix);
    expect(await page.evaluate(async () => (await (window as any).tasmReady).apiUrl)).toBe(origin + prefix + 'api/');
    const id = await page.evaluate(async () => {
      const client = await (window as any).tasmReady, id = crypto.randomUUID();
      const response = await fetch(client.apiUrl + 'flows/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, source_id: crypto.randomUUID(), format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t', essence_parameters: { sample_rate: 48000, channels: 2 } }) });
      if (!response.ok) throw new Error(await response.text());
      return id;
    });
    await page.reload(); await page.evaluate(() => (window as any).tasmReady.then(() => undefined));
    // WebKit's emulated offline mode also blocks service-worker responses.
    offline = true;
    expect(await page.evaluate(prefix => fetch(prefix + 'uncached').then(() => false, () => true), prefix)).toBe(true);
    expect(await page.evaluate(async id => {
      const client = await (window as any).tasmReady;
      return (await (await fetch(client.apiUrl + 'flows/' + id)).json()).id;
    }, id)).toBe(id);
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name =>
      (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat());
    expect(cached).toContain(prefix + 'index.js');
    expect(cached.some(path => /demo|playpen|branding|samples/.test(path))).toBe(false);
  } finally {
    await page.goto('about:blank');
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

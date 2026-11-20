declare const __TASM_ASSETS__: string[];
const sw = globalThis as unknown as ServiceWorkerGlobalScope;
const base = new URL('./', sw.location.href).href;
const assetCache = `tasm-assets:${base}:__TASM_BUILD__`;
const assets = __TASM_ASSETS__;
sw.addEventListener('install', event => {
  event.waitUntil(caches.open(assetCache).then(cache => cache.addAll(assets.map(path => new URL(path, base).href))));
});
sw.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(`tasm-assets:${base}:`) && name !== assetCache) await caches.delete(name);
    await sw.clients.claim();
  })());
});
sw.addEventListener('message', event => {
  if (event.data?.type !== 'tasm-activate' || event.data.base !== base || !event.source || !('url' in event.source)) return;
  if (event.source.url.startsWith(base)) event.waitUntil(sw.skipWaiting());
});
sw.addEventListener('fetch', event => {
  if (event.request.url.startsWith(`${base}api/`) || event.request.url.startsWith(`${base}media/`)) {
    event.respondWith(forward(event));
  } else if (event.request.method === 'GET' && event.request.url.startsWith(base)) {
    const path = new URL(event.request.url).pathname.slice(new URL(base).pathname.length);
    if (assets.includes(path)) event.respondWith(caches.open(assetCache).then(async cache =>
      (await cache.match(new URL(path, base).href)) ?? fetch(event.request)));
    // Keep live preview navigations controlled on Firefox reloads, without caching them.
    else event.respondWith(fetch(event.request));
  }
});
async function forward(event: FetchEvent): Promise<Response> {
  const client = await sw.clients.get(event.clientId);
  if (!client) return failure('No active TASM client.');
  const channel = new MessageChannel(), port = channel.port1;
  const request = event.request;
  // Firefox can expose an upload as a Blob without exposing Request.body.
  // Blob.stream keeps chunks bounded without creating a full JS ArrayBuffer.
  const reader = ['GET', 'HEAD'].includes(request.method) ? undefined :
    (request.body ?? (await request.blob()).stream()).getReader();
  let pending: Uint8Array | undefined;
  return new Promise<Response>(resolve => {
    const finish = (response: Response) => { clearTimeout(timer); port.close(); void reader?.cancel().catch(() => {}); resolve(response); };
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => { port.postMessage({ type: 'abort' }); finish(failure('TASM request timed out.')); }, 60000); };
    request.signal.addEventListener('abort', () => { port.postMessage({ type: 'abort' }); finish(failure('Request aborted.')); }, { once: true });
    port.onmessage = async ({ data }) => {
      reset();
      if (data.type === 'pull') {
        try {
          if (!pending?.length) {
            const part = await reader?.read();
            if (!part || part.done) { port.postMessage({ type: 'chunk', done: true }); return; }
            pending = part.value;
          }
          const chunk = pending.slice(0, 65536); pending = pending.subarray(chunk.length);
          port.postMessage({ type: 'chunk', chunk, done: false }, [chunk.buffer]);
        } catch { port.postMessage({ type: 'abort' }); }
      } else if (data.type === 'response') {
        finish(new Response(request.method === 'HEAD' || [204, 304].includes(data.status) ? null : data.body,
          { status: data.status, headers: data.headers }));
      }
    };
    reset();
    client.postMessage({ type: 'tasm-request', base, method: request.method, url: request.url,
      headers: Object.fromEntries(request.headers) }, [channel.port2]);
  });
}
function failure(summary: string): Response {
  return Response.json({ type: 'service_unavailable', summary, time: new Date().toISOString() }, { status: 503 });
}

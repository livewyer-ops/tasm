declare const __TASM_ASSETS__: string[];
const sw = globalThis as unknown as ServiceWorkerGlobalScope;
const base = new URL('./', sw.location.href).href;
const assetCache = `tasm-assets:${base}:__TASM_BUILD__`;
const assets = __TASM_ASSETS__;
sw.addEventListener('install', event => {
  // Bypass the HTTP cache: asset names are not hashed, and a stale file would
  // mix builds under this release's cache.
  event.waitUntil(caches.open(assetCache).then(cache => cache.addAll(assets.map(path => new Request(new URL(path, base).href, { cache: 'reload' })))));
});
sw.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(`tasm-assets:${base}:`) && name !== assetCache) await caches.delete(name);
    await sw.clients.claim();
  })());
});
const windows = new Map<string, AbortController>();
sw.addEventListener('message', event => {
  if (event.data?.base !== base || !event.source || !('type' in event.source) || event.source.type !== 'window' || !event.source.url.startsWith(base)) return;
  const id = event.source.id;
  if (event.data.type === 'tasm-connect') {
    if (!windows.has(id)) windows.set(id, new AbortController());
  } else if (event.data.type === 'tasm-disconnect') {
    windows.get(id)?.abort(); windows.delete(id);
  } else if (event.data.type === 'tasm-activate') event.waitUntil(sw.skipWaiting());
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
async function activeWindow(id: string): Promise<WindowClient | undefined> {
  if (windows.has(id)) {
    const preferred = await sw.clients.get(id);
    if (preferred?.type === 'window' && preferred.url.startsWith(base)) return preferred as WindowClient;
  }
  const clients = (await sw.clients.matchAll({ type: 'window' })).filter(client => client.url.startsWith(base));
  for (const client of clients) if (windows.has(client.id)) return client;
  // A restarted service worker has forgotten which pages opened the SDK.
  return Promise.any(clients.map(client => new Promise<WindowClient>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); reject(); }, 500);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timeout); channel.port1.close();
      if (data !== 'ready') { reject(); return; }
      if (!windows.has(client.id)) windows.set(client.id, new AbortController());
      resolve(client);
    };
    client.postMessage({ type: 'tasm-probe', base }, [channel.port2]);
  }))).catch(() => undefined);
}
async function forward(event: FetchEvent): Promise<Response> {
  const client = await activeWindow(event.clientId);
  const lifetime = client && windows.get(client.id)?.signal;
  if (!client || !lifetime) return failure('No active TASM client.');
  const channel = new MessageChannel(), port = channel.port1;
  const request = event.request;
  // Firefox can expose an upload as a Blob without exposing Request.body.
  // Blob.stream keeps chunks bounded without creating a full JS ArrayBuffer.
  const reader = ['GET', 'HEAD'].includes(request.method) ? undefined :
    (request.body ?? (await request.blob()).stream()).getReader();
  let pending: Uint8Array | undefined;
  return new Promise<Response>(resolve => {
    const signal = AbortSignal.any([request.signal, lifetime]);
    const cancel = () => { port.postMessage({ type: 'abort' }); finish(failure('Request aborted.')); };
    const finish = (response: Response) => { clearTimeout(timer); signal.removeEventListener('abort', cancel); port.close(); void reader?.cancel().catch(() => {}); resolve(response); };
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => { port.postMessage({ type: 'abort' }); finish(failure('TASM request timed out.')); }, 60000); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
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

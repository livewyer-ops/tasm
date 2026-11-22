import type { TasmOptions, TasmClient } from './public.d.ts';
import { abortable, holdStore } from './lifecycle';

function activated(registration: ServiceWorkerRegistration, signal: AbortSignal, target?: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const watched = new Set<ServiceWorker>();
    const finish = (error?: unknown) => {
      navigator.serviceWorker.removeEventListener('controllerchange', check);
      registration.removeEventListener('updatefound', check);
      signal.removeEventListener('abort', aborted);
      for (const worker of watched) worker.removeEventListener('statechange', check);
      error ? reject(error) : resolve();
    };
    const aborted = () => finish(signal.reason);
    const check = () => {
      for (const worker of [registration.installing, registration.waiting, registration.active, target]) {
        if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener('statechange', check); }
      }
      const active = target ?? registration.active;
      if (active?.state === 'activated') finish();
      // Firefox can return a registration before exposing its installing worker.
      else if (target?.state === 'redundant' || (!registration.active && !registration.installing && !registration.waiting && [...watched].some(worker => worker.state === 'redundant'))) {
        finish(new Error('Application worker installation failed. Check the connection, then retry.'));
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', check);
    registration.addEventListener('updatefound', check);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else check();
  });
}

export async function startTasm({ basePath = '/tasm/', backends, signal: suppliedSignal }: TasmOptions = {}): Promise<TasmClient> {
  if (!isSecureContext || !('SharedWorker' in globalThis) || !navigator.serviceWorker || !navigator.locks || !navigator.storage?.getDirectory ||
    !('FileSystemFileHandle' in globalThis) || !FileSystemFileHandle.prototype.createWritable) {
    throw new Error('TASM requires HTTPS or localhost, SharedWorker, service workers and writable OPFS.');
  }
  const base = new URL(basePath, location.origin);
  if (base.origin !== location.origin || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('basePath must be a same-origin path ending in /.');
  if (!location.pathname.startsWith(base.pathname)) throw new Error('The host page must be within the TASM service-worker scope.');
  const timeout = new AbortController(), lifetime = new AbortController();
  const signal = AbortSignal.any([...(suppliedSignal ? [suppliedSignal] : []), timeout.signal, lifetime.signal]);
  let stage = 'Waiting for browser storage';
  const timer = setTimeout(() => timeout.abort(new Error(`${stage} timed out after 60 seconds.`)), 60000);
  const status = (value: string) => { stage = value; window.dispatchEvent(new CustomEvent('tasm-startup', { detail: value })); };
  const update = (value: string) => window.dispatchEvent(new CustomEvent('tasm-update', { detail: value }));
  const lockName = `tasm-client:${base.href}`, reloadKey = `tasm-update:${base.href}`;
  const initialController = navigator.serviceWorker.controller;
  let release: (() => Promise<void>) | undefined, worker: SharedWorker | undefined, registration: ServiceWorkerRegistration | undefined;
  let stopped = false, stopping = false, closed = false, updateBlocked = false;
  let shutdown: Promise<void> | undefined;
  const watched = new Set<ServiceWorker>();
  const announceUpdate = () => {
    if (registration?.installing && !watched.has(registration.installing)) {
      watched.add(registration.installing); registration.installing.addEventListener('statechange', announceUpdate);
    }
    if (registration?.waiting && !updateBlocked) update('Update ready. Refresh to apply.');
    else if (registration?.active && [...watched].some(w => w.state === 'redundant')) update('The update could not download. Your current version is still available. Retry when connected.');
  };
  const forward = (event: MessageEvent) => {
    if (event.data?.type === 'tasm-probe' && event.data.base === base.href && event.ports[0]) {
      event.ports[0].postMessage(worker && !stopping && !closed ? 'ready' : 'unavailable');
      event.ports[0].close();
    }
    if (event.data?.type === 'tasm-request' && event.data.base === base.href && event.ports[0]) {
      if (stopping || stopped || !worker) {
        event.ports[0].postMessage({ type: 'response', status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: 'TASM is shutting down.' }) });
        event.ports[0].close();
      } else worker.port.postMessage(event.data, [event.ports[0]]);
    }
  };
  const client: TasmClient = { apiUrl: new URL('api/', base).href, close() {
    if (closed) return;
    closed = true; lifetime.abort(new DOMException('TASM client closed', 'AbortError'));
    navigator.serviceWorker.controller?.postMessage({ type: 'tasm-disconnect', base: base.href });
    navigator.serviceWorker.removeEventListener('message', forward);
    registration?.removeEventListener('updatefound', announceUpdate);
    for (const sw of watched) sw.removeEventListener('statechange', announceUpdate);
    signal.removeEventListener('abort', cancelled);
    window.removeEventListener('pagehide', leaving);
    window.removeEventListener('tasm-reset', cancelled);
    if (!stopped) worker?.port.postMessage({ type: 'disconnect' });
    worker?.port.close(); void release?.(); release = undefined;
  }, shutdown(prepare) {
    if (closed) return Promise.reject(new Error('TASM client is closed.'));
    if (stopped) return Promise.resolve();
    if (shutdown) return shutdown;
    shutdown = (async () => {
      if (!stopping) {
        await release?.(); release = await holdStore(lockName, 'exclusive', true);
        if (!release) {
          release = await holdStore(lockName, 'shared', false, lifetime.signal);
          const error = new Error('Close other tabs using this store, then try Reset again.');
          error.name = 'StoreInUseError'; throw error;
        }
        stopping = true;
        navigator.serviceWorker.controller?.postMessage({ type: 'tasm-disconnect', base: base.href });
      }
      lifetime.signal.throwIfAborted();
      await prepare?.();
      await new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const finish = (error?: Error) => { clearTimeout(deadline); lifetime.signal.removeEventListener('abort', cancelled); channel.port1.close(); error ? reject(error) : resolve(); };
        const cancelled = () => finish(lifetime.signal.reason);
        const deadline = setTimeout(() => finish(new Error('The browser worker did not finish shutting down. Retry, or use Reset to clear local data.')), 60000);
        if (lifetime.signal.aborted) { cancelled(); return; }
        lifetime.signal.addEventListener('abort', cancelled, { once: true });
        channel.port1.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : undefined);
        worker!.port.postMessage({ type: 'shutdown', base: base.href }, [channel.port2]);
      });
      stopped = true; worker!.port.close();
    })().finally(() => { shutdown = undefined; if (closed) { void release?.(); release = undefined; } });
    return shutdown;
  } };
  const cancelled = () => client.close();
  const leaving = (event: PageTransitionEvent) => { if (!event.persisted) client.close(); };
  signal.addEventListener('abort', cancelled, { once: true });
  window.addEventListener('pagehide', leaving);
  window.addEventListener('tasm-reset', cancelled);
  try {
    signal.throwIfAborted(); status(stage);
    release = await holdStore(lockName, 'shared', false, signal);
    signal.throwIfAborted(); status('Installing application worker');
    registration = await abortable(navigator.serviceWorker.register(new URL('service-worker.js', base), { scope: base.pathname, type: 'module', updateViaCache: 'none' }), signal);
    await activated(registration, signal);
    // A tab may have waited behind another tab's update while holding old HTML.
    if (navigator.serviceWorker.controller !== registration.active || (initialController && navigator.serviceWorker.controller !== initialController)) {
      client.close(); location.reload();
      await abortable(new Promise<never>(() => {}), signal);
    }
    const waiting = registration.waiting;
    registration.addEventListener('updatefound', announceUpdate); announceUpdate();
    status('Opening browser storage');
    worker = new SharedWorker(new URL('worker.js', base), { type: 'module', name: `tasm:${base.pathname}` });
    const ready = new Promise<void>((resolve, reject) => {
      worker!.onerror = () => reject(new Error('TASM worker failed to load.'));
      worker!.port.onmessage = ({ data }) => {
        if (data.type === 'ready') resolve();
        if (data.type === 'error') reject(new Error(data.message));
      };
    });
    navigator.serviceWorker.addEventListener('message', forward);
    worker.port.start(); worker.port.postMessage({ type: 'init', base: base.href, backends });
    await abortable(ready, signal);
    navigator.serviceWorker.controller?.postMessage({ type: 'tasm-connect', base: base.href });
    // Only a ready update at startup may replace this tab. Later updates wait for refresh.
    if (waiting && !sessionStorage.getItem(reloadKey)) {
      try {
        status('Closing storage for the update');
        await abortable(client.shutdown(), signal);
        sessionStorage.setItem(reloadKey, '1');
        const changed = activated(registration, signal, waiting);
        waiting.postMessage({ type: 'tasm-activate', base: base.href });
        await changed;
        location.reload();
        await abortable(new Promise<never>(() => {}), signal);
      } catch (error) {
        if ((error as Error).name !== 'StoreInUseError') throw error;
        updateBlocked = true;
        update(`Update ready. Close other tabs using this store, then refresh.`);
      }
    }
    sessionStorage.removeItem(reloadKey);
    signal.removeEventListener('abort', cancelled);
    return client;
  } catch (error) { client.close(); await release?.(); release = undefined; throw error; }
  finally { clearTimeout(timer); }
}

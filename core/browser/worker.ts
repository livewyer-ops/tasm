import { Runtime, HttpError, type BrowserRequest } from './runtime';

const scope = globalThis as unknown as SharedWorkerGlobalScope;
let runtime: Runtime | undefined;
let opening: Promise<void> | undefined;
let stopping = false;
const requests = new Set<Promise<void>>();
scope.onconnect = ({ ports }) => {
  const connection = ports[0]; connection.start();
  connection.onmessage = async event => {
    const data = event.data;
    if (data.type === 'reset' && data.base === new URL('./', scope.location.href).href) {
      // The caller holds both stores exclusively and will delete them, including incomplete writes.
      stopping = true; runtime?.stopPolling();
      connection.postMessage({ type: 'reset-stopped' }); scope.close(); return;
    }
    if (data.type === 'disconnect') { connection.close(); return; }
    if (data.type === 'shutdown' && event.ports[0]) {
      const reply = event.ports[0];
      try {
        if (!runtime || data.base !== runtime.base) throw new Error('Cannot shut down a different TASM store.');
        stopping = true; await opening; runtime.stopPolling();
        await Promise.allSettled([...requests]); await runtime.close();
        reply.postMessage({ closed: true }); reply.close(); scope.close();
      } catch (error) { reply.postMessage({ error: String(error) }); reply.close(); }
      return;
    }
    if (data.type === 'init') {
      try {
        if (stopping) throw new Error('TASM is shutting down. Reload after reset completes.');
        if (!runtime) {
          const candidate = new Runtime(data.base);
          runtime = candidate;
          opening = candidate.open(data.backends).catch(async error => {
            try { await candidate.close(); }
            catch (closeError) { console.warn('Failed to close the store after startup failed.', closeError); }
            finally {
              if (runtime === candidate) { runtime = undefined; opening = undefined; }
            }
            throw error;
          });
        }
        if (runtime.base !== data.base) throw new Error('Shared worker has a different base path.');
        await opening; connection.postMessage({ type: 'ready' });
      } catch (error) { connection.postMessage({ type: 'error', message: String(error) }); }
    } else if (data.type === 'tasm-request' && event.ports[0]) {
      const port = event.ports[0]; port.start();
      const request = (async () => {
        try {
          await opening;
          if (stopping || !runtime || data.base !== runtime.base) throw new HttpError(503, 'TASM is not ready.');
          const result = await runtime.request(data as BrowserRequest, receive(port));
          port.postMessage({ type: 'response', ...result });
        } catch (error) {
          const status = error instanceof HttpError ? error.status : error instanceof DOMException && error.name === 'QuotaExceededError' ? 507 : 500;
          port.postMessage({ type: 'response', status, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: status === 500 ? 'internal_server_error' : 'request_error',
              summary: status === 500 ? 'Browser storage operation failed.' : String(error), time: new Date().toISOString() }) });
        } finally { port.close(); }
      })();
      requests.add(request);
      try { await request; } finally { requests.delete(request); }
    }
  };
};
async function* receive(port: MessagePort): AsyncGenerator<Uint8Array> {
  while (true) {
    const part = await new Promise<{ done: boolean; chunk: Uint8Array }>((resolve, reject) => {
      const timeout = setTimeout(() => { port.removeEventListener('message', listener); reject(new HttpError(408, 'Upload timed out.')); }, 30000);
      const listener = ({ data }: MessageEvent) => {
        if (!['chunk', 'abort'].includes(data.type)) return;
        clearTimeout(timeout); port.removeEventListener('message', listener);
        if (data.type === 'abort') reject(new HttpError(408, 'Upload aborted.')); else resolve(data);
      };
      port.addEventListener('message', listener); port.postMessage({ type: 'pull' });
    });
    if (part.done) return;
    yield part.chunk;
  }
}

import type { Sample, DraftWorkspace } from './workspace-store';
import { abortable } from '../../core/browser/lifecycle';
import type { ImportedTrack, PreparedObject } from './ingest-worker';

// This database contains library copies only; TAMS owns its own database and objects.
async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | void, signal?: AbortSignal, stores = ['samples', 'media']): Promise<T> {
  signal?.throwIfAborted();
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`tasm-${document.body.dataset.app}-library`, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('samples')) request.result.createObjectStore('samples', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('media')) request.result.createObjectStore('media');
      request.result.createObjectStore('drafts');
    };
    request.onsuccess = () => { if (signal?.aborted) { request.result.close(); reject(signal.reason); } else resolve(request.result); };
    request.onerror = () => reject(request.error);
  });
  const db = await (signal ? abortable(opened, signal) : opened);
  try {
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const cancel = () => tx.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      let result: IDBRequest<T> | void;
      tx.oncomplete = () => { signal?.removeEventListener('abort', cancel); resolve(result?.result as T); };
      tx.onabort = () => { signal?.removeEventListener('abort', cancel); reject(signal?.reason ?? tx.error ?? new Error('Library update could not be saved.')); };
      try { result = work(tx); } catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export const librarySamples = (signal?: AbortSignal) => transaction<Sample[]>('readonly', tx => tx.objectStore('samples').getAll(), signal);
export const libraryDraft = (key: string) => transaction<DraftWorkspace | undefined>('readonly', tx => tx.objectStore('drafts').get(key), undefined, ['drafts']);
export const saveLibraryDraft = (key: string, draft: DraftWorkspace | undefined, signal?: AbortSignal) => transaction('readwrite', tx => {
  if (draft) tx.objectStore('drafts').put(draft, key); else tx.objectStore('drafts').delete(key);
}, signal, ['drafts']);
export async function saveLibrarySamples(tracks: ImportedTrack[], signal: AbortSignal) {
  await transaction('readwrite', tx => {
    for (const { sample, bytes } of tracks) {
      tx.objectStore('samples').put(sample);
      tx.objectStore('media').put(new Blob([bytes], { type: 'video/mp2t' }), sample.id);
    }
  }, signal);
}
export const removeLibrarySample = (id: string) => transaction('readwrite', tx => {
  tx.objectStore('samples').delete(id); tx.objectStore('media').delete(id);
});
export async function libraryBytes(id: string) {
  const blob = await transaction<Blob | undefined>('readonly', tx => tx.objectStore('media').get(id));
  if (!blob) throw new Error('This sample is no longer in the library. Import the original file again.');
  return blob.arrayBuffer();
}

export async function mediaWorker(data: { bytes?: ArrayBuffer; kind?: string; file?: File }, signal: AbortSignal): Promise<{ objects?: PreparedObject[]; tracks?: ImportedTrack[] }> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./ingest-worker.js', import.meta.url), { type: 'module' });
  let cancel: () => void = () => {};
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
      worker.onerror = e => reject(new Error(e.message));
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.postMessage(data, data.bytes ? [data.bytes] : []);
    });
  } finally { signal.removeEventListener('abort', cancel); worker.terminate(); }
}

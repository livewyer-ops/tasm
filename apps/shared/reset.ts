import { holdStore } from '../../core/browser/lifecycle';

// Reset discards these stores, so it must also stop a worker whose startup or writes are stuck.
async function stopWorker(base: URL) {
  const worker = new SharedWorker(new URL('worker.js', base), { type: 'module', name: `tasm:${base.pathname}` });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The browser worker did not stop. Close other tabs using this site, then retry Reset.')), 15000);
      worker.onerror = () => { clearTimeout(timer); resolve(); }; // A worker that cannot load has no open storage.
      worker.port.onmessage = ({ data }) => { if (data.type === 'reset-stopped') { clearTimeout(timer); resolve(); } };
      worker.port.postMessage({ type: 'reset', base: base.href });
    });
  } finally { worker.port.close(); }
}

async function deleteDatabase(name: string, blocked: () => void) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // A blocked deletion cannot be cancelled. Keep the dialog pending until it finishes.
    request.onblocked = blocked;
  });
}

export function wireReset() {
  const site = document.body.dataset.app!;
  const appName = site === 'demo' ? 'Demo' : 'Playpen';
  const bases = [new URL('/', location.origin)];
  const releases = new Map<string, () => Promise<void>>();
  const button = document.querySelector<HTMLButtonElement>('#reset-demo, #reset-playpen')!;
  const dialog = document.getElementById('reset-dialog') as HTMLDialogElement;
  const cancel = document.getElementById('reset-cancel') as HTMLButtonElement;
  const confirm = document.getElementById('reset-confirm') as HTMLButtonElement;
  const status = document.getElementById('reset-status')!;
  let pending = false, stopped = false;
  button.disabled = !isSecureContext || !navigator.locks || !navigator.storage?.getDirectory || !('SharedWorker' in window);
  button.onclick = () => { status.textContent = ''; dialog.showModal(); cancel.focus(); };
  cancel.onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (pending || stopped) event.preventDefault(); });
  dialog.addEventListener('close', () => button.focus());
  confirm.onclick = async () => {
    if (pending) return;
    pending = true; confirm.disabled = true; cancel.disabled = true;
    status.textContent = `Stopping ${appName}...`;
    try {
      if (!stopped) {
        stopped = true;
        window.dispatchEvent(new Event('tasm-reset'));
      }
      for (const base of bases) {
        if (releases.has(base.href)) continue;
        // Closing a client releases its native lease asynchronously.
        const release = await holdStore(`tasm-client:${base.href}`, 'exclusive', false, AbortSignal.timeout(1000)).catch(error => {
          if (error.name === 'TimeoutError') return undefined;
          throw error;
        });
        if (!release) throw new Error('Close other tabs using this site, then retry Reset.');
        releases.set(base.href, release);
      }
      await Promise.all(bases.map(stopWorker));
      status.textContent = `Clearing ${appName} storage...`;
      const blocked = () => { status.textContent = 'Waiting for browser storage to close. Close other tabs using this site if this continues.'; };
      const root = await navigator.storage.getDirectory();
      for (const base of bases) {
        const directory = `tasm-${encodeURIComponent(base.pathname)}`;
        await deleteDatabase(`/pglite/${directory}`, blocked);
        try { await root.removeEntry(directory, { recursive: true }); }
        catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
      }
      await deleteDatabase(`tasm-${site}-library`, blocked);
      for (const storage of [localStorage, sessionStorage]) for (const key of Object.keys(storage)) {
        if (key === `tasm-onboarding:${site}:v1` || key === `tasm-${site}:result-tips:v1` || key.startsWith('tasm-preview:') || key.startsWith('tasm-playpen:selected:') || bases.some(base => key === `tasm-update:${base.href}`)) storage.removeItem(key);
      }
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        if (bases.some(base => registration.scope === base.href)) await registration.unregister();
      }
      for (const key of await caches.keys()) {
        if (bases.some(base => key.startsWith(`tasm-assets:${base.href}:`))) await caches.delete(key);
      }
      status.textContent = `${appName} cleared. Reloading...`;
      location.reload();
    } catch (error) {
      status.textContent = `${(error as Error).message} Reset has not completed; retry to finish clearing it.`;
      confirm.textContent = 'Retry reset'; confirm.disabled = false;
      cancel.disabled = stopped; pending = false;
    }
  };
}

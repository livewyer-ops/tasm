export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reject(signal.reason); };
    work.then(value => { cleanup(); signal.aborted ? reject(signal.reason) : resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  });
}

export async function holdStore(name: string, mode: LockMode, ifAvailable = false, signal?: AbortSignal): Promise<(() => Promise<void>) | undefined> {
  return new Promise((resolve, reject) => {
    const held = navigator.locks.request(name, { mode, ...(ifAvailable ? { ifAvailable } : { signal }) }, lock => {
      if (!lock) { resolve(undefined); return; }
      return new Promise<void>(release => resolve(async () => { release(); await held; }));
    });
    void held.catch(reject);
  });
}

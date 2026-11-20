import { abortable } from '../../core/browser/lifecycle';
import { wireReset } from './reset';

declare global {
  interface Window {
    tasmStartup: {
      signal: AbortSignal;
      wait<T>(work: Promise<T>, stage?: string): Promise<T>;
      done(): void;
      fail(error: unknown): void;
    };
  }
}

const appName = document.body.dataset.app === 'demo' ? 'Demo' : 'Playpen';
const controller = new AbortController();
const notice = document.getElementById('startup-notice')!;
const message = document.getElementById('startup-message')!;
let stage = 'Loading application', complete = false, update = '';
notice.hidden = true;
const slow = setTimeout(() => { message.textContent = `${stage} is taking longer than expected. Retry, or use Reset to clear ${appName}'s local data.`; notice.hidden = false; }, 10000);
const deadline = setTimeout(() => window.tasmStartup.fail(new Error(`${stage} timed out after 60 seconds.`)), 60000);
window.tasmStartup = {
  signal: controller.signal,
  wait(work, next) {
    if (next) stage = next;
    return abortable(work, controller.signal);
  },
  done() {
    if (controller.signal.aborted) return;
    complete = true; clearTimeout(slow); clearTimeout(deadline);
    notice.hidden = !update; message.textContent = update;
  },
  fail(error) {
    if (complete || controller.signal.aborted) return;
    clearTimeout(slow); clearTimeout(deadline);
    const reason = error instanceof Error ? error : new Error(String(error));
    controller.abort(reason);
    message.textContent = `${reason.message} Retry, or use Reset to clear ${appName}'s local data.`;
    notice.hidden = false;
  },
};
document.getElementById('startup-retry')!.onclick = () => location.reload();
wireReset();
window.addEventListener('tasm-reset', () => {
  complete = true; clearTimeout(slow); clearTimeout(deadline);
  controller.abort(new DOMException('Reset requested', 'AbortError'));
});
window.addEventListener('tasm-startup', event => { stage = (event as CustomEvent<string>).detail; });
window.addEventListener('tasm-update', event => {
  update = (event as CustomEvent<string>).detail;
  if (complete) { message.textContent = update; notice.hidden = false; }
});
window.addEventListener('pagehide', () => {
  clearTimeout(slow); clearTimeout(deadline);
  if (!complete) controller.abort(new DOMException('Page closed', 'AbortError'));
});

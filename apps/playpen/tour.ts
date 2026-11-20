interface TourResult { target: string; title: string; text: string }
export interface TourStep extends TourResult {
  actionLabel: string;
  action?: (signal: AbortSignal) => Promise<void>;
  result: () => TourResult;
  ready?: () => boolean;
}
interface TourOptions { start: () => void; waiting: () => boolean }

export function createTour(site: 'playpen', steps: TourStep[], options: TourOptions) {
  const welcome = document.getElementById(`${site}-about`) as HTMLDialogElement;
  const restart = document.getElementById(`tour-${site}`) as HTMLButtonElement;
  restart.disabled = true;
  const key = `tasm-onboarding:${site}:v1`;
  const popup = document.createElement('aside');
  popup.className = 'tour-popover'; popup.hidden = true;
  popup.setAttribute('aria-label', 'Playpen tour');
  popup.innerHTML = '<button class="tour-close" aria-label="End tour">×</button><section class="tour-result" hidden><h3></h3><p></p></section><p class="tour-position"></p><h2 tabindex="-1"></h2><p class="tour-text"></p><p class="tour-state" role="status"></p><div class="tour-buttons"><button class="tour-end">End tour</button><button class="tour-next">Next</button></div>';
  const dock = document.getElementById('tour-desktop')!;
  dock.append(popup);
  const get = <T extends HTMLElement>(selector: string) => popup.querySelector<T>(selector)!;
  const text = (selector: string, value: string) => { const element = get(selector); if (element.textContent !== value) element.textContent = value; };
  const timeline = document.querySelector<HTMLDetailsElement>('.timeline-panel')!;
  const layout = new Map<HTMLDetailsElement, boolean>();
  let active = false, index = 0, pending = false, error = '', generation = 0;
  let result: TourResult | undefined, controller: AbortController | undefined;
  let targets: HTMLElement[] = [], timer: ReturnType<typeof setInterval> | undefined;
  let previousFocus: HTMLElement | null = null, lastPhase = '', lastSuspended = false;
  const seen = () => { try { localStorage.setItem(key, 'seen'); } catch { /* Guidance works without preference storage. */ } };
  const clearTargets = () => { targets.forEach(target => target.classList.remove('tour-target')); targets = []; };
  const stop = (restoreFocus = true) => {
    if (!active) return;
    active = false; generation++; controller?.abort(); seen(); clearInterval(timer); popup.hidden = true; clearTargets();
    for (const [panel, open] of layout) panel.open = open;
    layout.clear();
    if (restoreFocus) {
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
      else restart.focus({ preventScroll: true });
    }
  };
  const update = () => {
    if (!active) return;
    const complete = index >= steps.length, step = steps[Math.min(index, steps.length - 1)];
    const suspended = !!document.querySelector('dialog[open]');
    clearTargets(); popup.hidden = suspended;
    if (suspended) { lastSuspended = true; return; }
    const nextTargets = complete ? [] : [...document.querySelectorAll<HTMLElement>(step.target)];
    targets = [...nextTargets, ...(result ? document.querySelectorAll<HTMLElement>(result.target) : [])];
    targets.forEach(target => target.classList.add('tour-target'));
    const waiting = pending || (!complete && (options.waiting() || !!step.ready && !step.ready()));
    const phase = complete ? 'complete' : pending ? 'running' : 'instruction';
    popup.dataset.phase = phase;
    popup.setAttribute('aria-busy', String(pending));
    get('.tour-result').hidden = !result;
    text('.tour-result h3', result?.title ?? '');
    text('.tour-result p', result?.text ?? '');
    text('.tour-position', complete ? 'Example complete' : `${index + 1} of ${steps.length}`);
    text('h2', complete ? 'You have built and queried a TAMS timeline' : step.title);
    text('.tour-text', complete ? 'Your example is saved. Choose Finish to return to your workspace.' : step.text);
    text('.tour-state', error || (waiting ? 'Waiting for this action to finish...' : ''));
    get<HTMLButtonElement>('.tour-next').disabled = !complete && waiting;
    get('.tour-next').hidden = !complete && !step.action;
    text('.tour-next', complete ? 'Finish' : error ? `Retry: ${step.actionLabel}` : step.actionLabel);
    const focusPhase = `${index}:${phase}`;
    if (lastPhase !== focusPhase || lastSuspended) {
      const inspecting = (complete ? targets : nextTargets).some(target => target.closest('.api-panel, .terminal-panel'));
      if (inspecting) timeline.open = false;
      for (const target of targets) {
        if (inspecting && timeline.contains(target)) continue;
        for (let element: HTMLElement | null = target; element; element = element.parentElement) {
          if (element instanceof HTMLDetailsElement) element.open = true;
        }
      }
      if (!pending) get('h2').focus({ preventScroll: true });
      lastPhase = focusPhase;
    }
    lastSuspended = false;
  };
  const start = () => {
    if (pending) return;
    if (active) stop(false);
    for (const panel of document.querySelectorAll<HTMLDetailsElement>('main details')) layout.set(panel, panel.open);
    for (const panel of document.querySelectorAll<HTMLDetailsElement>('details.panel')) panel.open = false;
    seen(); previousFocus = document.activeElement as HTMLElement;
    if (welcome.open) welcome.close();
    options.start(); generation++; active = true; index = 0; result = undefined; error = ''; lastPhase = ''; update();
    clearInterval(timer); timer = setInterval(update, 250);
  };
  get('.tour-close').onclick = () => stop(); get('.tour-end').onclick = () => stop();
  get('.tour-next').onclick = async () => {
    if (pending || get<HTMLButtonElement>('.tour-next').disabled) return;
    if (index >= steps.length) { stop(); return; }
    const step = steps[index], run = generation;
    if (!step.action) return;
    controller = new AbortController(); pending = true; error = ''; restart.disabled = true; update();
    try {
      await step.action(controller.signal);
      if (active && run === generation) { result = step.result(); index++; }
    } catch (failure) { if (active && run === generation) error = (failure as Error).message; }
    finally { pending = false; controller = undefined; restart.disabled = false; update(); }
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !document.querySelector('dialog[open]')) { event.preventDefault(); stop(); }
  });
  window.addEventListener('pagehide', () => stop(false));
  window.addEventListener('tasm-reset', () => stop(false));
  welcome.addEventListener('close', seen);
  welcome.querySelector<HTMLButtonElement>('[data-start-tour]')!.onclick = start;
  restart.onclick = start;
  let first = true; try { first = !localStorage.getItem(key); } catch { /* Show once for this page load. */ }
  const showWelcome = () => { restart.disabled = false; if (first) { first = false; welcome.showModal(); } };
  function completeInteraction() {
    const step = steps[index];
    if (!active || pending || !step || step.action) return;
    result = step.result(); index++; update();
  }
  return { update, showWelcome, stop, completeInteraction };
}

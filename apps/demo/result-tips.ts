export interface ResultTip {
  step: number;
  title: string;
  text: string;
  targets: string[];
  objects?: string[];
}

export function createResultTips(changed: () => void) {
  const popup = document.getElementById('result-tip')!;
  const title = document.getElementById('result-tip-title')!;
  const text = document.getElementById('result-tip-text')!;
  const preference = document.getElementById('show-result-tips') as HTMLInputElement;
  const key = 'tasm-demo:result-tips:v1';
  const desktop = matchMedia('(min-width:1100px)');
  const seen = new Set<number>();
  let active: ResultTip | undefined;
  try { preference.checked = localStorage.getItem(key) !== 'off'; } catch { /* Keep the default for this visit. */ }
  const unhighlight = () => document.querySelectorAll('.result-target, .result-object').forEach(element => element.classList.remove('result-target', 'result-object'));
  const dock = () => {
    if (!active) return;
    const focused = popup.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    if (desktop.matches) document.getElementById('technical')!.prepend(popup);
    else document.querySelector(active.step === 5 || active.step === 6 ? '.presentation' : '#structure')!.before(popup);
    focused?.focus({ preventScroll: true });
  };
  const refresh = () => {
    if (!active) return;
    unhighlight();
    for (const selector of active.targets) document.querySelectorAll(selector).forEach(element => element.classList.add('result-target'));
    for (const id of active.objects ?? []) document.querySelectorAll(`[data-object="${CSS.escape(id)}"]`).forEach(element => element.classList.add('result-object'));
  };
  const clear = () => {
    active = undefined; popup.hidden = true;
    document.body.classList.remove('result-tip-open'); unhighlight();
  };
  const dismiss = () => {
    if (!active) return;
    const restoreFocus = popup.contains(document.activeElement);
    clear();
    if (restoreFocus) document.getElementById('primary')!.focus({ preventScroll: true });
  };
  document.getElementById('result-tip-close')!.onclick = dismiss;
  const save = () => {
    try { localStorage.setItem(key, preference.checked ? 'on' : 'off'); } catch { /* The choice still applies until reload. */ }
  };
  document.getElementById('result-tip-hide')!.onclick = () => { preference.checked = false; save(); dismiss(); };
  preference.onchange = () => { save(); if (!preference.checked) dismiss(); };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !document.querySelector('dialog[open]')) { event.preventDefault(); dismiss(); }
  });
  desktop.addEventListener('change', dock);
  window.addEventListener('pagehide', clear);
  return {
    clear, dismiss, refresh,
    restart() { clear(); seen.clear(); },
    show(result: ResultTip) {
      if (!preference.checked || seen.has(result.step)) return false;
      clear(); active = result; seen.add(result.step);
      title.textContent = result.title; text.textContent = result.text;
      popup.dataset.resultStep = String(result.step); popup.hidden = false;
      document.body.classList.add('result-tip-open'); dock(); refresh(); changed();
      // The existing status region announces completion without moving focus or scrolling.
      return true;
    },
  };
}

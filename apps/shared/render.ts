export function onFrame(render: () => void) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  };
}
export function setText(element: Element, value: string) {
  if (element.textContent !== value) element.textContent = value;
}

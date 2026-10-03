// A cursor can't be animated, but its image can be swapped: squashed while the mouse is down,
// a little stretched for a moment after it comes up, then back to normal (see html.cursor-* in style.css).
const POP_MS = 90;

export function installCursorPress() {
  const root = document.documentElement;
  let popTimer = 0;
  const release = () => {
    if (!root.classList.contains('cursor-press')) return;
    root.classList.replace('cursor-press', 'cursor-pop');
    clearTimeout(popTimer);
    popTimer = window.setTimeout(() => root.classList.remove('cursor-pop'), POP_MS);
  };
  // capture phase, so handlers that stop propagation (the 3D view, the drawing layer) can't hide the press
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(popTimer);
    root.classList.remove('cursor-pop');
    root.classList.add('cursor-press');
  }, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
}

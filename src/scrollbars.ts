// The browser's scrollbars always show the system cursor, so they're hidden (style.css) and this
// draws one thumb instead, on whichever scrolling box the mouse is over. Touch scrolling is untouched.
const GAP = 3; // from the box's right edge
const WIDTH = 8;
const MIN = 28;

function scroller(el: Element | null): HTMLElement | null {
  for (; el && el !== document.body; el = el.parentElement) {
    const y = getComputedStyle(el).overflowY;
    if ((y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el as HTMLElement;
  }
  return null;
}

export function installScrollbars() {
  const thumb = document.createElement('div');
  thumb.className = 'scroll-thumb';
  thumb.hidden = true;
  document.body.appendChild(thumb);
  let box: HTMLElement | null = null;
  let drag: { y: number; top: number; id: number } | null = null;

  const track = () => {
    if (!box) return 0;
    return box.clientHeight - Math.max(MIN, (box.clientHeight * box.clientHeight) / box.scrollHeight);
  };
  const place = () => {
    if (!box || !box.isConnected || box.scrollHeight <= box.clientHeight + 1) {
      box = null;
      thumb.hidden = true;
      return;
    }
    const r = box.getBoundingClientRect();
    const h = box.clientHeight - track();
    const t = track() * (box.scrollTop / (box.scrollHeight - box.clientHeight));
    thumb.hidden = false;
    thumb.style.height = `${h}px`;
    thumb.style.top = `${r.top + box.clientTop + t}px`;
    thumb.style.left = `${r.left + box.clientLeft + box.clientWidth - WIDTH - GAP}px`;
  };

  document.addEventListener('pointermove', (e) => {
    if (drag || e.pointerType !== 'mouse' || e.target === thumb) return;
    box = scroller(e.target as Element);
    place();
  });
  document.documentElement.addEventListener('pointerleave', () => {
    if (drag) return;
    box = null;
    place();
  });
  document.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  thumb.addEventListener('pointerdown', (e) => {
    if (!box || e.button !== 0) return;
    e.preventDefault();
    drag = { y: e.clientY, top: box.scrollTop, id: e.pointerId };
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add('dragging');
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!drag || !box) return;
    const t = track();
    if (t > 0) box.scrollTop = drag.top + ((e.clientY - drag.y) * (box.scrollHeight - box.clientHeight)) / t;
  });
  const end = () => {
    drag = null;
    thumb.classList.remove('dragging');
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('lostpointercapture', end);
  // the wheel over the thumb scrolls the box under it
  thumb.addEventListener('wheel', (e) => {
    if (box) box.scrollBy({ top: e.deltaY, left: e.deltaX });
  }, { passive: true });
}

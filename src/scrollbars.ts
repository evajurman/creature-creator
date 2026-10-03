// The browser's scrollbars always show the system cursor, so they're hidden (style.css) and this
// draws one thumb instead, on whichever scrolling box the mouse is over. Touch scrolling is untouched.
const GAP = 3; // from the box's right edge
const WIDTH = 6;
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

  let stickies: HTMLElement[] = [];
  let stickyOf: HTMLElement | null = null;
  // the thumb runs between the box's pinned bars (the creature bar, a popover's photo footer), not over them
  const span = () => {
    if (!box) return { top: 0, height: 0 };
    if (stickyOf !== box) {
      stickyOf = box;
      stickies = [...box.children].filter((c) => getComputedStyle(c).position === 'sticky') as HTMLElement[];
    }
    const r = box.getBoundingClientRect();
    let top = r.top + box.clientTop;
    let bottom = top + box.clientHeight;
    const mid = (top + bottom) / 2;
    for (const s of stickies) {
      if (s.hidden) continue;
      const sr = s.getBoundingClientRect();
      if (sr.height === 0) continue;
      if (sr.top < mid) top = Math.max(top, sr.bottom);
      else bottom = Math.min(bottom, sr.top);
    }
    return { top: top + GAP, height: Math.max(0, bottom - top - GAP * 2) };
  };
  const size = (height: number) =>
    box ? Math.min(height, Math.max(MIN, (height * box.clientHeight) / box.scrollHeight)) : 0;
  const track = () => {
    const { height } = span();
    return height - size(height);
  };
  const place = () => {
    if (!box || !box.isConnected || box.scrollHeight <= box.clientHeight + 1) {
      box = null;
      thumb.hidden = true;
      return;
    }
    const r = box.getBoundingClientRect();
    const { top, height } = span();
    const h = size(height);
    const t = (height - h) * (box.scrollTop / (box.scrollHeight - box.clientHeight));
    thumb.hidden = height < MIN;
    thumb.style.height = `${h}px`;
    thumb.style.top = `${top + t}px`;
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

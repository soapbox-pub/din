/**
 * Scrolls a horizontal carousel so that one of its tiles is in view, either
 * centred or just brought inside its edges. Unlike scrollIntoView, it leaves
 * the page around the carousel where it is.
 */
export function revealInCarousel(
  scroller: HTMLElement,
  tile: HTMLElement | null | undefined,
  { center = false, smooth = false }: { center?: boolean; smooth?: boolean } = {},
) {
  if (!tile) return;
  const start = tile.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
  const end = start + tile.offsetWidth;
  let left: number;
  if (center) left = start - (scroller.clientWidth - tile.offsetWidth) / 2;
  else if (start < scroller.scrollLeft) left = start;
  else if (end > scroller.scrollLeft + scroller.clientWidth) left = end - scroller.clientWidth;
  else return;
  scroller.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
}

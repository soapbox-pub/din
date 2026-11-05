/**
 * The lens behind Din's liquid glass (`glass-surface` in index.css): an SVG filter
 * that bends what's behind a panel inward at its rim, as through a drop of
 * water, before the blur frosts it. `backdrop-filter: url()` can only name a
 * filter in its own document, so the desktop and every app install it, and
 * `data-liquid` on the root turns it on once it's there; without it the
 * glass is frosted, not bent.
 */

const SVG = 'http://www.w3.org/2000/svg';
export const LIQUID_FILTER_ID = 'din-liquid';

/**
 * A displacement map along one axis, as a data: URL: mid-gray (no shift) in
 * the middle, ramping to full and none at the two edges, so pixels at the
 * rim are drawn from further in and the edge reads as a lens.
 */
function edgeRamp(channel: 'r' | 'g', rim: [number, number]): string {
  const c = (v: number) => (channel === 'r' ? `rgb(${v},0,0)` : `rgb(0,${v},0)`);
  const end = channel === 'r' ? "x2='1' y2='0'" : "x2='0' y2='1'";
  const [near, far] = rim;
  const stops = [
    [0, 255],
    [near, 196],
    [far, 128],
    [1 - far, 128],
    [1 - near, 60],
    [1, 0],
  ]
    .map(([at, v]) => `<stop offset='${at}' stop-color='${c(v)}'/>`)
    .join('');
  const svg =
    `<svg xmlns='${SVG}' viewBox='0 0 100 100' preserveAspectRatio='none'>` +
    `<linearGradient id='g' x1='0' y1='0' ${end}>${stops}</linearGradient>` +
    `<rect width='100' height='100' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function el(name: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function lens(id: string, rim: [number, number], scale: string): SVGElement {
  const filter = el('filter', {
    id,
    x: '0',
    y: '0',
    width: '1',
    height: '1',
    primitiveUnits: 'objectBoundingBox',
    'color-interpolation-filters': 'sRGB',
  });
  const box = { x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none' };
  filter.append(
    el('feImage', { ...box, href: edgeRamp('r', rim), result: 'x' }),
    el('feImage', { ...box, href: edgeRamp('g', rim), result: 'y' }),
    el('feComposite', { in: 'x', in2: 'y', operator: 'arithmetic', k2: '1', k3: '1', result: 'map' }),
    el('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G' }),
  );
  return filter;
}

/** Puts the lens in this document and turns it on; safe to call twice. */
export function installLiquidGlass(): void {
  if (document.getElementById(LIQUID_FILTER_ID)) return;
  const svg = el('svg', { width: '0', height: '0', 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0;pointer-events:none' });
  svg.append(lens(LIQUID_FILTER_ID, [0.04, 0.14], '0.12'));
  const mount = () => {
    document.body.append(svg);
    document.documentElement.setAttribute('data-liquid', '');
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  followPointer();
}

/**
 * Liquid glass's light: where the pointer is, in each glass surface's own
 * coordinates (--glass-x/--glass-y), once a frame while it moves, and only
 * while Liquid is chosen (the root's --glass-material, which the desktop and
 * the theme it sends its apps set inline). Set on the surfaces themselves
 * rather than the root, so a move restyles them and not the whole document.
 */
function followPointer(): void {
  let frame = 0;
  let x = 0;
  let y = 0;
  const update = () => {
    frame = 0;
    if (document.documentElement.style.getPropertyValue('--glass-material').trim() !== 'liquid') return;
    for (const el of document.querySelectorAll<HTMLElement>('.glass-surface, .window-glass, .glass-control')) {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--glass-x', `${Math.round(x - r.left)}px`);
      el.style.setProperty('--glass-y', `${Math.round(y - r.top)}px`);
    }
  };
  window.addEventListener(
    'pointermove',
    (e) => {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(update);
    },
    { capture: true, passive: true },
  );
  // A menu or popover opens without the pointer moving: light it where it is.
  new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(update);
  }).observe(document.body, { childList: true });
}

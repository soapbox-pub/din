/** Small DOM helpers for widgets, which have no framework. */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/** An HTML element. `class` and other attributes go in `attrs`; text children become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

/** An SVG element. */
export function s(tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

/** Replace an element's children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => !!c));
}

/** Lucide-style line icons (24×24, stroke 2), from their path data. */
export function icon(paths: string[], attrs: Attrs = {}): SVGElement {
  return s(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', ...attrs },
    ...paths.map((d) => s('path', { d })),
  );
}

// Selected text's color. Chromium paints a selection dodger blue in every
// page that doesn't style ::selection, whatever Din looks like. Built-in apps
// take Din's own (`--selection` in src/index.css); web pages (browser tabs,
// installed web apps) get it here as a user stylesheet, which a page's own
// ::selection still beats.
//
// Where Din is the desktop, native apps get the nearest of GNOME's accent
// colors (libadwaita's selections and highlights), the way they get its
// light/dark mode and the rest of its colors (gtk-theme.mts).

import type { WebContents } from 'electron';
import { runCommand } from './system.mts';

const SELECTION_COLOR = /^#[0-9a-f]{8}$/i;

let selectionColor: string | null = null;

/** Each web page, with the key of the stylesheet in its current document. */
const pages = new Map<WebContents, string | undefined>();

async function applyTo(contents: WebContents): Promise<void> {
  const previous = pages.get(contents);
  pages.set(contents, undefined);
  if (previous) contents.removeInsertedCSS(previous).catch(() => {});
  if (!selectionColor) return;
  try {
    const key = await contents.insertCSS(`::selection { background-color: ${selectionColor}; }`, {
      cssOrigin: 'user',
    });
    if (pages.has(contents)) pages.set(contents, key);
  } catch {
    // Gone, or between documents; the next one gets it on dom-ready.
  }
}

/** Give a web page Din's selection color, in every document it loads. */
export function attachSelectionColor(contents: WebContents): void {
  pages.set(contents, undefined);
  contents.on('dom-ready', () => {
    // The old document's stylesheet went with it.
    pages.set(contents, undefined);
    void applyTo(contents);
  });
  contents.once('destroyed', () => pages.delete(contents));
}

/** GNOME's accent colors (org.gnome.desktop.interface accent-color), by hue. */
const GNOME_ACCENTS: [name: string, hue: number][] = [
  ['red', 353],
  ['orange', 23],
  ['yellow', 41],
  ['green', 131],
  ['teal', 190],
  ['blue', 213],
  ['purple', 285],
  ['pink', 331],
];

/** The GNOME accent nearest a `#rrggbb…` color: slate for one with hardly any hue. */
export function gnomeAccent(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.25 || l < 0.1 || l > 0.9) return 'slate';
  const hue =
    max === r ? (((g - b) / d + 6) % 6) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  const distance = (h: number) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
  return GNOME_ACCENTS.reduce((best, next) => (distance(next[1]) < distance(best[1]) ? next : best))[0];
}

let nativeAccent: string | null = null;

async function setNativeAccent(accent: string): Promise<void> {
  if (process.env.DIN_DESKTOP_SESSION !== '1' || accent === nativeAccent) return;
  nativeAccent = accent;
  try {
    await runCommand('gsettings', ['set', 'org.gnome.desktop.interface', 'accent-color', accent], {
      timeout: 3_000,
    });
  } catch (error) {
    nativeAccent = null;
    console.warn('Could not pass the accent color on to native apps:', error);
  }
}

/** Set selected text's background (`#rrggbbaa`) everywhere outside Din's own pages. */
export function setSelectionColor(color: unknown): void {
  if (typeof color !== 'string' || !SELECTION_COLOR.test(color) || color === selectionColor) return;
  selectionColor = color;
  for (const contents of pages.keys()) void applyTo(contents);
  void setNativeAccent(gnomeAccent(color));
}

/**
 * What built-in widgets use of window.napplet (NIP-5D, @napplet/shim), typed.
 * A domain is there only if the desktop granted it, so each may be missing.
 */

export interface NappletTheme {
  colors: { background: string; text: string; primary: string };
  title?: string;
}

export interface NappletProfile {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  website?: string;
}

interface Subscription {
  close(): void;
}

interface NappletStorageArea {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Napplet {
  theme?: {
    get(): Promise<NappletTheme>;
    onChanged(handler: (theme: NappletTheme) => void): Subscription;
  };
  storage?: NappletStorageArea & { instance: NappletStorageArea };
  identity?: {
    getPublicKey(): Promise<string>;
    onChanged(handler: (pubkey: string) => void): Subscription;
    getProfile(): Promise<NappletProfile | null>;
    getFollows(): Promise<string[]>;
  };
  resource?: {
    bytes(url: string): Promise<Blob>;
  };
}

export const napplet: Napplet = (globalThis as { napplet?: Napplet }).napplet ?? {};

/** Whether a #rrggbb color is dark. */
function isDark(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((c) => Number.parseInt(c, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

function apply(theme: NappletTheme): void {
  const root = document.documentElement;
  root.style.setProperty('--background', theme.colors.background);
  root.style.setProperty('--text', theme.colors.text);
  root.style.setProperty('--primary', theme.colors.primary);
  // Not color-scheme: a frame whose scheme differs from its parent's gets an
  // opaque backdrop, and widgets are transparent.
  root.dataset.scheme = isDark(theme.colors.background) ? 'dark' : 'light';
}

/**
 * Keep the page's --background, --text and --primary, and its data-scheme
 * (`light` or `dark`, which .glass follows), in step with the desktop.
 */
export function followTheme(): void {
  if (!napplet.theme) return;
  napplet.theme.get().then(apply, () => {});
  napplet.theme.onChanged(apply);
}

/** Keep a value per copy of the widget (NAP-STORAGE's instance scope), as JSON. */
export const instanceStore = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = await napplet.storage?.instance.getItem(key).catch(() => null);
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    void napplet.storage?.instance.setItem(key, JSON.stringify(value)).catch(() => {});
  },
};

/** The box a widget is in, as Din's sizes come: small, wide (medium) or large. */
export type Shape = 'small' | 'wide' | 'large';

/** Follow the page's box: sets `data-shape` on <body> and calls back on each change. */
export function followShape(onChange?: (shape: Shape) => void): Shape {
  const read = (): Shape => {
    const { innerWidth: w, innerHeight: h } = window;
    return w > h * 1.5 ? 'wide' : Math.min(w, h) >= 280 ? 'large' : 'small';
  };
  let shape = read();
  document.body.dataset.shape = shape;
  window.addEventListener('resize', () => {
    const next = read();
    if (next === shape) return;
    shape = next;
    document.body.dataset.shape = shape;
    onChange?.(shape);
  });
  return shape;
}

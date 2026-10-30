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
  link?: {
    open(url: string): Promise<{ status: 'opened' | 'denied' }>;
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
  const root = document.documentElement.style;
  root.setProperty('--background', theme.colors.background);
  root.setProperty('--text', theme.colors.text);
  root.setProperty('--primary', theme.colors.primary);
  root.setProperty('color-scheme', isDark(theme.colors.background) ? 'dark' : 'light');
}

/** Keep the page's --background, --text and --primary (and its color scheme) in step with the desktop. */
export function followTheme(): void {
  if (!napplet.theme) return;
  napplet.theme.get().then(apply, () => {});
  napplet.theme.onChanged(apply);
}

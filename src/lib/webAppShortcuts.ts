/**
 * The `shortcuts` of an installed website's or nsite's web app manifest: the
 * jump list its Dock tile and launcher tile show on a right-click, as Chrome
 * shows an installed web app's. Each opens the app's window at its URL, which
 * must be on the app's own origin. (Din's own apps and apps from folders read
 * theirs from their manifest directly: manifestActions in src/lib/dinApps.ts.)
 */

export interface WebAppShortcut {
  name: string;
  /** Absolute, on the app's origin. */
  url: string;
}

/** Chrome shows at most 10; Din's own apps are held to 8. */
export const MAX_SHORTCUTS = 8;
const MAX_NAME = 64;
const MAX_URL = 2048;

function label(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || null : null;
}

/** A URL resolved against `base`, on `origin` (or any http(s) one, for null). */
function sameOriginUrl(value: unknown, base: string, origin: string | null): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    if (origin ? url.origin !== origin : !/^https?:$/.test(url.protocol)) return null;
    if (url.href.length > MAX_URL) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * A manifest's shortcuts, their URLs resolved against `base` (the manifest's
 * own URL) and kept only on `origin` (any http(s) URL for null: the caller
 * checks them with normalizeShortcuts once it knows the app's). A shortcut's `short_name` is preferred,
 * as browsers prefer it where room is short.
 */
export function parseManifestShortcuts(manifest: unknown, base: string, origin: string | null): WebAppShortcut[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const { shortcuts } = manifest as { shortcuts?: unknown };
  if (!Array.isArray(shortcuts)) return [];
  const out: WebAppShortcut[] = [];
  for (const entry of shortcuts) {
    if (out.length >= MAX_SHORTCUTS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, short_name, url } = entry as Record<string, unknown>;
    const title = label(short_name) ?? label(name);
    const href = sameOriginUrl(url, base, origin);
    if (title && href) out.push({ name: title, url: href });
  }
  return out;
}

/** Re-check stored shortcuts (they roam, so they're untrusted on the way back in), on `origin` only. */
export function normalizeShortcuts(value: unknown, origin: string | null): WebAppShortcut[] {
  if (!Array.isArray(value) || !origin) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, url } = entry as Record<string, unknown>;
    const title = label(name);
    const href = sameOriginUrl(url, origin, origin);
    return title && href ? [{ name: title, url: href }] : [];
  }).slice(0, MAX_SHORTCUTS);
}

/** Shortcuts as the window manager's jump list: each opens the app's window at its URL. */
export function shortcutActions(shortcuts: WebAppShortcut[]): { label: string; params: Record<string, unknown> }[] | undefined {
  return shortcuts.length > 0 ? shortcuts.map((s) => ({ label: s.name, params: { url: s.url } })) : undefined;
}

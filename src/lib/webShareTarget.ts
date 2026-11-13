/**
 * The `share_target` of an installed website's or nsite's web app manifest
 * (Web Share Target, docs/din/sharing.md): where Din's share sheet sends a
 * share, how (a GET's query, or a POST's form body, which is how files go),
 * and what each part is called. Read when the app is installed, and checked
 * again whenever it's read back, since it roams.
 */

export type ShareEnctype = 'application/x-www-form-urlencoded' | 'multipart/form-data';

export interface WebShareTarget {
  /** The page a share opens: absolute, on the app's own origin, without a fragment. */
  action: string;
  method: 'GET' | 'POST';
  enctype: ShareEnctype;
  params: {
    title?: string;
    text?: string;
    url?: string;
    /** The files it takes, each entry's `accept` MIME types or extensions. Only ever with a multipart POST. */
    files?: { name: string; accept: string[] }[];
  };
}

const MAX_URL = 2048;
const MAX_FILE_ENTRIES = 8;
const MAX_ACCEPTS = 32;

/** A form field's name, as it goes in a multipart header: printable ASCII, no space, quote or backslash. */
function fieldName(value: unknown): string | null {
  return typeof value === 'string' && /^[!#-[\]-~]{1,64}$/.test(value) ? value : null;
}

/** An `accept` entry: a MIME type, a family (`image/*`), or an extension (`.pdf`). */
function acceptEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const a = value.trim().toLowerCase();
  return /^(\.[a-z0-9][a-z0-9.+-]{0,31}|\*\/\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,127}))$/.test(a) ? a : null;
}

/**
 * A manifest's share target, its action resolved against `base` (the
 * manifest's own URL) and kept only on `origin`; null when it has none Din
 * can deliver to. As browsers do, files need a multipart POST: a target
 * naming them without one keeps its other parts.
 */
export function parseWebShareTarget(manifest: unknown, base: string, origin: string): WebShareTarget | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  return checkShareTarget((manifest as { share_target?: unknown }).share_target, base, origin);
}

/** Re-check a stored share target (it roams, so it's untrusted on the way back in), on `origin` only. */
export function normalizeWebShareTarget(value: unknown, origin: string | null): WebShareTarget | null {
  return origin ? checkShareTarget(value, origin, origin) : null;
}

function checkShareTarget(raw: unknown, base: string, origin: string): WebShareTarget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { action, method, enctype, params } = raw as Record<string, unknown>;
  if (typeof action !== 'string' || typeof params !== 'object' || params === null) return null;
  let url: URL;
  try {
    url = new URL(action.trim() || '.', base);
  } catch {
    return null;
  }
  url.hash = '';
  if (url.origin !== origin || url.href.length > MAX_URL) return null;
  const verb = method === undefined ? 'GET' : String(method).toUpperCase();
  if (verb !== 'GET' && verb !== 'POST') return null;
  const encoding =
    verb === 'POST' && String(enctype ?? '').toLowerCase() === 'multipart/form-data'
      ? 'multipart/form-data'
      : 'application/x-www-form-urlencoded';
  const p = params as Record<string, unknown>;
  const out: WebShareTarget['params'] = {};
  for (const key of ['title', 'text', 'url'] as const) {
    const name = fieldName(p[key]);
    if (name) out[key] = name;
  }
  if (encoding === 'multipart/form-data' && p.files !== undefined) {
    const entries = Array.isArray(p.files) ? p.files : [p.files];
    const files = entries.slice(0, MAX_FILE_ENTRIES).flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { name, accept } = entry as Record<string, unknown>;
      const field = fieldName(name);
      const list = (Array.isArray(accept) ? accept : [accept]).map(acceptEntry).filter((a): a is string => a !== null).slice(0, MAX_ACCEPTS);
      return field && list.length > 0 ? [{ name: field, accept: list }] : [];
    });
    if (files.length > 0) out.files = files;
  }
  if (!out.title && !out.text && !out.url && !out.files) return null;
  return { action: url.href, method: verb, enctype: encoding, params: out };
}

/** A share target's action as a path on its site (for an nsite, whose origin is its host). */
export function shareTargetPath(target: WebShareTarget): string {
  const url = new URL(target.action);
  return `${url.pathname}${url.search}`;
}

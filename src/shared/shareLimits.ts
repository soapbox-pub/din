/**
 * What a share may hold, checked by the app's runtime (navigator.share) and
 * again by the desktop, which can't trust an app to have run its runtime's
 * checks (docs/din/sharing.md).
 */

/** The most a share's files may come to, read into memory to cross the port. */
export const MAX_SHARE_BYTES = 256 * 1024 * 1024;

/** The most files one share may hold. */
export const MAX_SHARE_FILES = 100;

/** Schemes a shared URL can't have: what's only the sharer's page's, or runs. */
const UNSHAREABLE = new Set(['javascript:', 'data:', 'blob:', 'file:', 'about:', 'filesystem:']);

/**
 * A shared URL as it's handed on, resolved against `base`; a TypeError for
 * one that isn't a URL or has a scheme that can't be shared.
 */
export function shareableUrl(value: string, base?: string): string {
  let u: URL;
  try {
    u = new URL(value, base);
  } catch {
    throw new TypeError(`Not a URL: ${value}`);
  }
  if (UNSHAREABLE.has(u.protocol)) throw new TypeError(`Can’t share a ${u.protocol} URL`);
  return u.href;
}

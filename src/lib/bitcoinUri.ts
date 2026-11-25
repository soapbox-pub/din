/**
 * `bitcoin:` URIs (BIP-21), and the apps that open them.
 *
 * A `bitcoin:` link asks to be paid: an address, and maybe an amount, a
 * label and a message. Wallet opens them (its manifest's
 * `protocol_handlers`), at Send with the link filled in; so can any
 * installed web app or nsite whose manifest says so with the standard
 * member, and any native app whose desktop entry lists
 * `x-scheme-handler/bitcoin`:
 *
 *     "protocol_handlers": [{ "protocol": "bitcoin", "url": "/open?uri=%s" }]
 *
 * `%s` becomes the whole URI, percent-encoded. With one app, a link opens in
 * it; with more, in the one chosen with "Always", or else the Open With
 * chooser asks (useBitcoinLinks).
 *
 * Only the scheme is checked here, so the desktop doesn't load the wallet's
 * cryptography to route a click; the app that opens it reads the rest.
 */

import { findProtocolHandler } from '@/lib/nostrUri';

/** Longest `bitcoin:` link Din routes. */
const MAX_URI = 8192;

/** Whether a string is a `bitcoin:` link, by its scheme. */
export function isBitcoinUri(url: string): boolean {
  const text = url.trim();
  // eslint-disable-next-line no-control-regex
  return /^bitcoin:/i.test(text) && text.length <= MAX_URI && !/[\s\u0000-\u001f\u007f]/.test(text);
}

/** How an installed web app or nsite opens `bitcoin:` links. */
export interface BitcoinHandler {
  /** The URL to open, with `%s` where the URI goes. */
  url: string;
}

/** The `bitcoin` entry of a web app manifest's `protocol_handlers`, its URL resolved against `base`. */
export function parseBitcoinProtocolHandler(manifest: unknown, base: string): BitcoinHandler | null {
  const found = findProtocolHandler(manifest, base, 'bitcoin');
  return found ? { url: found.url } : null;
}

/** Re-check a stored handler (it roams, so it's untrusted on the way back in). */
export function normalizeBitcoinHandler(value: unknown): BitcoinHandler | null {
  if (typeof value !== 'object' || value === null) return null;
  const { url } = value as Record<string, unknown>;
  if (typeof url !== 'string' || url.length > 2048 || !url.includes('%s')) return null;
  return { url };
}

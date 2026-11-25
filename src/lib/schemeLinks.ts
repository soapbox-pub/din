/**
 * Links with a scheme of their own (`bitcoin:`, `monero:`, `xmpp:`, …), and
 * the apps that open them.
 *
 * Din routes a few schemes itself: http(s) and nsite pages, `nostr:` by
 * event kind (src/lib/nostrUri.ts), `blossom:` files, `mailto:` in Mail and
 * `magnet:` in Torrents. Every other scheme on the list below opens in
 * whichever app says it does: a built-in app, an installed web app or nsite
 * with the standard manifest member,
 *
 *     "protocol_handlers": [{ "protocol": "monero", "url": "/open?uri=%s" }]
 *
 * (`%s` becomes the whole URI, percent-encoded, as `registerProtocolHandler`
 * does it), or a native app whose desktop entry lists
 * `x-scheme-handler/<scheme>`. With one app, a link opens in it; with more,
 * in the one chosen with "Always", or else Open With asks
 * (useSchemeLinks). A link no app opens (or a scheme not on the list) still
 * opens Open With, which says so and offers to copy it.
 *
 * Only the scheme is checked here; the app that opens a link reads the rest.
 */

/**
 * The schemes apps may claim: the HTML spec's safelist for
 * `registerProtocolHandler` (less `mailto` and `magnet`, which Din's own
 * apps take), and payment schemes Nostr apps declare. `web+<name>` too.
 */
export const LINK_SCHEMES: readonly string[] = [
  'bitcoin', 'monero', 'lightning', 'cashu',
  'ftp', 'ftps', 'geo', 'im', 'irc', 'ircs', 'matrix', 'mms', 'news', 'nntp', 'openpgp4fpr',
  'sftp', 'sip', 'sms', 'smsto', 'ssh', 'tel', 'urn', 'webcal', 'wtai', 'xmpp',
];

/** Schemes Din routes itself, or that are never a link to hand to an app. */
const NOT_APP_LINKS = new Set([
  'http', 'https', 'nsite', 'nostr', 'nostrconnect', 'blossom', 'mailto', 'magnet',
  'javascript', 'vbscript', 'data', 'blob', 'file', 'filesystem', 'about', 'view-source',
  'chrome', 'chrome-extension', 'chrome-untrusted', 'devtools', 'ws', 'wss',
  'app', 'din', 'din+file', 'widget',
]);

/** Longest link Din routes. */
const MAX_URI = 8192;
/** Longest handler URL kept. */
const MAX_HANDLER_URL = 2048;
/** Most schemes kept for one app. */
const MAX_SCHEMES = 32;

/** Whether apps may claim a scheme (lowercase). */
export function isClaimableScheme(scheme: string): boolean {
  return LINK_SCHEMES.includes(scheme) || /^web\+[a-z]{1,32}$/.test(scheme);
}

/**
 * The scheme (lowercase) of a link for an app to open: one line, not too
 * long, and not a page or anything Din routes itself. Null for anything
 * else, `localhost:8080` (a host and port, typed without `http://`)
 * included. The scheme needn't be one apps may claim: a link nothing opens
 * still gets Open With, saying so.
 */
export function appLinkScheme(url: string): string | null {
  const text = url.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length > MAX_URI || /[\s\u0000-\u001f\u007f]/.test(text)) return null;
  const match = /^([a-z][a-z0-9+.-]{0,63}):(.*)$/i.exec(text);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (NOT_APP_LINKS.has(scheme)) return null;
  // A host and a port (`tel:5551234` is a phone number, though).
  if (!isClaimableScheme(scheme) && /^\d*(?:[/?#]|$)/.test(match[2])) return null;
  return scheme;
}

/** How an installed web app or nsite opens links of a scheme. */
export interface SchemeHandler {
  /** The URL to open, with `%s` where the URI goes. */
  url: string;
}

/** An app's handlers, by scheme. */
export type SchemeHandlers = Record<string, SchemeHandler>;

/**
 * The entries of a web app manifest's `protocol_handlers` for schemes apps
 * may claim, each URL resolved against `base` (the manifest's own URL); the
 * first entry for a scheme wins. The caller checks they're on the app's own
 * origin.
 */
export function parseSchemeHandlers(manifest: unknown, base: string): SchemeHandlers {
  const found: SchemeHandlers = {};
  if (typeof manifest !== 'object' || manifest === null) return found;
  const { protocol_handlers: handlers } = manifest as { protocol_handlers?: unknown };
  if (!Array.isArray(handlers)) return found;
  for (const entry of handlers) {
    if (Object.keys(found).length >= MAX_SCHEMES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { protocol, url } = entry as Record<string, unknown>;
    if (typeof protocol !== 'string' || typeof url !== 'string' || !url.includes('%s')) continue;
    const scheme = protocol.trim().toLowerCase();
    if (!isClaimableScheme(scheme) || found[scheme]) continue;
    try {
      const resolved = new URL(url.trim(), base).href;
      if (resolved.length > MAX_HANDLER_URL || !resolved.includes('%s')) continue;
      found[scheme] = { url: resolved };
    } catch {
      continue;
    }
  }
  return found;
}

/** Re-check stored handlers (they roam, so they're untrusted on the way back in). */
export function normalizeSchemeHandlers(value: unknown): SchemeHandlers {
  const kept: SchemeHandlers = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return kept;
  for (const [scheme, handler] of Object.entries(value).slice(0, MAX_SCHEMES)) {
    if (!isClaimableScheme(scheme) || typeof handler !== 'object' || handler === null) continue;
    const { url } = handler as Record<string, unknown>;
    if (typeof url !== 'string' || url.length > MAX_HANDLER_URL || !url.includes('%s')) continue;
    kept[scheme] = { url };
  }
  return kept;
}

/** The handlers whose URL passes `keep` (on the app's own origin), or undefined for none. */
export function keepSchemeHandlers(handlers: SchemeHandlers | undefined, keep: (url: string) => boolean): SchemeHandlers | undefined {
  const kept = Object.fromEntries(Object.entries(handlers ?? {}).filter(([, h]) => keep(h.url)));
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** What Open With's header says a link is: a payment's amount and who it's for, when it says. */
export function describeSchemeLink(uri: string): { scheme: string; title: string; detail: string | null; subtitle: string } {
  const scheme = appLinkScheme(uri) ?? '';
  const body = uri.trim().slice(scheme.length + 1);
  const q = body.indexOf('?');
  const target = q === -1 ? body : body.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : body.slice(q + 1));
  const decimal = (value: string | null) => (value && /^\d{1,12}(\.\d{1,12})?$/.test(value) ? value : null);
  if (scheme === 'bitcoin') {
    const amount = decimal(params.get('amount'));
    return { scheme, title: amount ? `Pay ${amount} BTC` : 'Bitcoin payment', detail: params.get('label')?.trim() || null, subtitle: target || uri };
  }
  if (scheme === 'monero') {
    const amount = decimal(params.get('tx_amount'));
    return {
      scheme,
      title: amount ? `Pay ${amount} XMR` : 'Monero payment',
      detail: (params.get('recipient_name') || params.get('tx_description'))?.trim() || null,
      subtitle: target || uri,
    };
  }
  return { scheme, title: `${scheme}: link`, detail: null, subtitle: uri.trim() };
}

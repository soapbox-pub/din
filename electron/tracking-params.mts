// The Web Browser's query stripping: the tracking tokens that link
// decorators (ad networks, newsletters, share buttons) add to a URL, and the
// URL without them. One list, used in three places:
//   - the ad blocker's extension (electron/adblock-extension/background.js,
//     by way of the engine bundle, scripts/adblock-engine-entry.js), which
//     redirects a page or frame request in the persistent session to its
//     clean URL before anything is sent;
//   - the private and Tor sessions' request listener (electron/adblock.mts),
//     the same there;
//   - the address bar (src/lib/trackingParams.ts), so a page's URL never
//     shows them, even ones a page adds itself with history.pushState.
//
// Always on, whatever the ad blocker's settings: what's here identifies a
// click or a recipient and nothing else, so no page needs it to work. A
// parameter is listed only when that's true wherever it appears (or, for the
// sites' own, on that site), the way Firefox's and Brave's query stripping
// lists are drawn; a name another site might use for something real (`ref`,
// `source`, `si` on anything but its own sites) isn't.
//
// Pure, with no imports: it runs in the main process, the extension's page
// and the desktop alike.

/** Parameters that track wherever they appear, lowercase. */
const GLOBAL = new Set([
  // Ad clicks: Google, Microsoft, Meta, X, TikTok, LinkedIn, Yandex, Pinterest, Reddit, others.
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid',
  'msclkid', 'fbclid', 'twclid', 'ttclid', 'li_fat_id', 'yclid', 'ysclid', 'epik',
  'rdt_cid', 'rb_clickid', 's_cid', 'srsltid', 'irclickid', 'wickedid',
  // Instagram's and Meta's share links.
  'igshid', 'igsh', 'mibextid',
  // Email and marketing platforms: Mailchimp, HubSpot, Marketo, Klaviyo,
  // MailerLite, Vero, Olytics, Openstat, Drip.
  'mc_eid', 'mc_cid', '_hsenc', '_hsmi', '__hstc', '__hssc', '__hsfp', 'hsctatracking',
  'mkt_tok', '_kx', 'ml_subscriber', 'ml_subscriber_hash', 'vero_conv', 'vero_id',
  'oly_anon_id', 'oly_enc_id', '_openstat', '__s',
  // Matomo's (Piwik's) campaign tags, by their old names.
  'pk_campaign', 'pk_kwd', 'pk_keyword', 'pk_source', 'pk_medium', 'pk_content', 'pk_cid',
  // Google Analytics' cross-domain linker.
  '_ga', '_gl',
]);

/** Prefixes whose every parameter tracks: Google Analytics' campaign tags, and Matomo's. */
const GLOBAL_PREFIXES = ['utm_', 'mtm_'];

/** A site's own tracking parameters, on it and its subdomains. */
const SITES: { hosts: string[]; params: string[] }[] = [
  // Share links.
  { hosts: ['youtube.com', 'youtu.be'], params: ['si', 'pp', 'feature'] },
  { hosts: ['open.spotify.com'], params: ['si'] },
  { hosts: ['x.com', 'twitter.com'], params: ['s', 't', 'ref_src', 'ref_url'] },
  { hosts: ['tiktok.com'], params: ['_r', '_t', 'is_from_webapp', 'sender_device', 'share_app_id', 'share_link_id'] },
  { hosts: ['reddit.com'], params: ['share_id', 'rdt', 'ref_campaign', 'ref_source'] },
  { hosts: ['facebook.com'], params: ['__tn__', '__cft__', 'sfnsn', 'ref'] },
  { hosts: ['instagram.com'], params: ['ig_rid'] },
  { hosts: ['linkedin.com'], params: ['trk', 'trkcampaign', 'trackingid', 'lipi'] },
  { hosts: ['threads.net', 'threads.com'], params: ['xmt', 'slof'] },
  // Amazon's product links: the page they came from and how.
  {
    hosts: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.co.jp', 'amazon.in', 'amazon.com.au', 'amazon.com.br', 'amazon.com.mx', 'amazon.nl'],
    params: ['_encoding', 'content-id', 'pd_rd_i', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_i', 'pf_rd_m', 'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'ref_', 'qid', 'sr', 'sprefix', 'crid'],
  },
];

function onHost(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

function siteParams(hostname: string): Set<string> | null {
  let found: Set<string> | null = null;
  for (const site of SITES) {
    if (!site.hosts.some((host) => onHost(hostname, host))) continue;
    found ??= new Set();
    for (const param of site.params) found.add(param);
  }
  return found;
}

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Whether a query parameter, by its lowercase name, tracks on a site. */
function isTracking(key: string, site: Set<string> | null): boolean {
  if (GLOBAL.has(key) || site?.has(key)) return true;
  // Facebook's `__cft__[0]` and the like.
  const bracket = key.indexOf('[');
  if (bracket > 0 && site?.has(key.slice(0, bracket))) return true;
  return GLOBAL_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

/**
 * An http(s) URL without its tracking parameters, or the very string given
 * when it has none (or isn't an http(s) URL), so a caller can tell by
 * identity whether anything was taken. Everything else is kept byte for
 * byte, in its order and encoding: only whole `name=value` pairs go.
 */
export function stripTrackingParams(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  // A `?` after the `#` is the fragment's, which never leaves the page.
  const hash = url.indexOf('#');
  const query = url.indexOf('?');
  if (query === -1 || (hash !== -1 && hash < query)) return url;
  const search = url.slice(query + 1, hash === -1 ? undefined : hash);
  if (!search) return url;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  const site = siteParams(hostname);
  const pairs = search.split('&');
  const kept = pairs.filter((pair) => {
    const eq = pair.indexOf('=');
    return !isTracking(decodeKey(eq === -1 ? pair : pair.slice(0, eq)), site);
  });
  if (kept.length === pairs.length) return url;

  const rest = kept.filter((pair) => pair !== '').join('&');
  return url.slice(0, query) + (rest ? `?${rest}` : '') + (hash === -1 ? '' : url.slice(hash));
}

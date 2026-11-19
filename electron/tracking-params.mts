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

/**
 * A site's own tracking parameters, on it and its subdomains: `params` on
 * every page, `pageParams` only on the pages `pages` matches (where the name
 * means something else elsewhere on the site), and `pathTail`, a last path
 * segment that only says where the link came from.
 */
interface Site {
  hosts: string[];
  params: string[];
  pages?: RegExp;
  pageParams?: string[];
  pathTail?: RegExp;
}

const AMAZON_HOSTS = ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.co.jp', 'amazon.in', 'amazon.com.au', 'amazon.com.br', 'amazon.com.mx', 'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.sg', 'amazon.ae', 'amazon.sa', 'amazon.com.tr', 'amazon.com.be'];

const SITES: Site[] = [
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
  // Amazon's links: the page they came from and how (a search's signed
  // session in `dib`, its rank in `sr` and the path's `/ref=sr_1_1`), and on
  // a product's page the search that found it (`keywords`, and `s`, its
  // department, which on a search page is the sort order and stays). `th`
  // and `psc`, which pick the variant shown, stay too.
  {
    hosts: AMAZON_HOSTS,
    params: ['_encoding', 'content-id', 'pd_rd_i', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_i', 'pf_rd_m', 'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'ref', 'ref_', 'qid', 'sr', 'sprefix', 'crid', 'dib', 'dib_tag', 'ufe', 'dchild', 'social_share', 'starsleft', 'skiptwisterog', 'linkid', 'ascsubtag'],
    pages: /\/(?:dp|gp\/product|gp\/aw\/d)\//i,
    pageParams: ['keywords', 's'],
    pathTail: /\/ref=[^/]*$/i,
  },
];

function onHost(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

function sitesOf(hostname: string): Site[] {
  return SITES.filter((site) => site.hosts.some((host) => onHost(hostname, host)));
}

function siteParams(sites: Site[], pathname: string): Set<string> | null {
  if (!sites.length) return null;
  const found = new Set<string>();
  for (const site of sites) {
    for (const param of site.params) found.add(param);
    if (site.pages?.test(pathname)) for (const param of site.pageParams ?? []) found.add(param);
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
 * An http(s) URL without its tracking parameters (and a site's tracking path
 * segment, as Amazon's `/ref=…`), or the very string given when it has none
 * (or isn't an http(s) URL), so a caller can tell by identity whether
 * anything was taken. Everything else is kept byte for byte, in its order and
 * encoding: only whole `name=value` pairs go.
 */
export function stripTrackingParams(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const sites = sitesOf(parsed.hostname.toLowerCase());

  // A `?` or `/` after the `#` is the fragment's, which never leaves the page.
  const hash = url.indexOf('#');
  const end = hash === -1 ? url.length : hash;
  const queryAt = url.slice(0, end).indexOf('?');
  const query = queryAt === -1 ? end : queryAt;
  const authority = url.indexOf('/', url.indexOf('//') + 2);
  let path = authority === -1 || authority > query ? '' : url.slice(authority, query);
  const tail = path && sites.find((site) => site.pathTail?.test(path))?.pathTail;
  if (tail) path = path.replace(tail, '') || '/';
  const head = authority === -1 || authority > query ? url.slice(0, query) : url.slice(0, authority) + path;

  const search = queryAt === -1 ? '' : url.slice(query + 1, end);
  const pairs = search ? search.split('&') : [];
  const site = siteParams(sites, parsed.pathname);
  const kept = pairs.filter((pair) => {
    const eq = pair.indexOf('=');
    return !isTracking(decodeKey(eq === -1 ? pair : pair.slice(0, eq)), site);
  });
  if (!tail && kept.length === pairs.length) return url;

  const rest = kept.filter((pair) => pair !== '').join('&');
  return head + (rest ? `?${rest}` : queryAt !== -1 && !pairs.length ? '?' : '') + url.slice(end);
}

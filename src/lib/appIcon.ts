import { sanitizeUrl } from './sanitizeUrl';

/** A page-declared icon candidate (a link/meta hint or a manifest icon). */
export interface IconCandidate {
  href: string;
  type?: string;
  sizes?: string;
  rel?: string;
  purpose?: string;
}

/**
 * Guest-side script (run via `<webview>.executeJavaScript`) that harvests a
 * page's icon hints: `<link rel="icon"|"apple-touch-icon"|"mask-icon">` plus
 * the icons declared in its web-app manifest. Returns absolute URLs so the
 * host can score them without knowing the page origin. It runs entirely inside
 * the guest, so the manifest fetch happens on the page's own origin (no host
 * CORS concerns). Every returned URL is still re-sanitized host-side.
 */
export const COLLECT_ICONS_JS = `(async () => {
  const out = [];
  const abs = (h) => { try { return new URL(h, document.baseURI).href; } catch (e) { return null; } };
  const sel = 'link[rel~="icon"],link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"],link[rel="mask-icon"]';
  for (const el of document.querySelectorAll(sel)) {
    const href = abs(el.getAttribute('href'));
    if (href) out.push({ href, type: el.getAttribute('type') || '', sizes: el.getAttribute('sizes') || '', rel: el.getAttribute('rel') || '' });
  }
  const man = document.querySelector('link[rel="manifest"]');
  const mhref = man && abs(man.getAttribute('href'));
  if (mhref) {
    try {
      const res = await fetch(mhref);
      const json = await res.json();
      const base = res.url || mhref;
      for (const ic of (json && json.icons) || []) {
        if (!ic || !ic.src) continue;
        let href;
        try { href = new URL(ic.src, base).href; } catch (e) { continue; }
        out.push({ href, type: ic.type || '', sizes: ic.sizes || '', rel: 'manifest', purpose: ic.purpose || '' });
      }
    } catch (e) { /* manifest missing, non-JSON, or blocked */ }
  }
  return out;
})()`;

/** Sentinel "size" for scalable (SVG) icons so they outrank any raster. */
const SVG_SIZE = 100000;

/** Largest pixel dimension named in an HTML `sizes` string, or 0. */
function largestSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  let max = 0;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    if (token === 'any') return SVG_SIZE; // "any" is scalable, like an SVG
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (match) max = Math.max(max, Number(match[1]), Number(match[2]));
  }
  return max;
}

/** True when a candidate is a scalable SVG (by type, rel, or extension). */
function isSvg(candidate: IconCandidate, url: string): boolean {
  if (candidate.type?.toLowerCase().includes('svg')) return true;
  if (candidate.rel === 'mask-icon') return true; // Safari mask icons are SVG
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

/**
 * Choose the best installable icon for a site, preferring a scalable SVG over
 * any raster, then the largest raster. Considers page-declared candidates
 * (link hints + manifest icons) alongside the browser-reported favicon, and
 * always returns an https URL — falling back to the site's conventional
 * `/favicon.ico`.
 *
 * All candidate URLs pass the https-only sanitizer, so untrusted page data
 * never reaches the icon `<img>` unsanitized.
 */
export function pickBestIcon(
  candidates: IconCandidate[],
  pageUrl: string,
  reportedFavicon?: string | null,
): string {
  let origin: string | null;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    origin = null;
  }
  const fallback = origin ? `${origin}/favicon.ico` : '';

  // The reported favicon is a low-quality baseline (typically a small .ico):
  // score it at 0 so any real sized/scalable candidate wins.
  let bestUrl = (reportedFavicon && sanitizeUrl(reportedFavicon)) || fallback;
  let bestScore = bestUrl && bestUrl !== fallback ? 0 : -1;

  for (const candidate of candidates) {
    const url = sanitizeUrl(candidate.href);
    if (!url) continue;

    let score: number;
    if (isSvg(candidate, url)) {
      score = SVG_SIZE;
    } else {
      const size = largestSize(candidate.sizes);
      // apple-touch-icon without an explicit size is conventionally 180px.
      score = size || (candidate.rel?.includes('apple-touch-icon') ? 180 : 1);
    }

    // A maskable-only icon is designed to be cropped into a platform shape;
    // as a plain desktop icon it looks zoomed-in. Nudge it just below an
    // equally-sized normal icon without discarding it outright.
    if (candidate.purpose?.includes('maskable') && !candidate.purpose.includes('any')) {
      score -= 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }

  return bestUrl;
}

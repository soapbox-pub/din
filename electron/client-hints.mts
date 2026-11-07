// The User-Agent Client Hints that Chrome sends with every page and frame it
// loads, and Electron leaves off.
//
// Chromium sends the low-entropy hints (Sec-CH-UA, Sec-CH-UA-Mobile and
// Sec-CH-UA-Platform) with every request to a secure origin. Electron's
// renderers add them to a page's own requests (scripts, images, fetches),
// but navigations get theirs from the browser process's
// ClientHintsControllerDelegate, which Electron doesn't implement, so a
// document or iframe arrives with none. A browser that says it's Chrome and
// loads pages without them is plainly not Chrome, and Cloudflare's challenge
// ("Verify you are human") turns it away: it looped forever, however often
// its box was ticked, until navigations carried them, and then passed on its
// own. (Saying it's Electron passes too: Cloudflare expects Electron to leave
// them off.)
//
// So they're added to navigations that lack them, valued as the page's own
// requests and navigator.userAgentData give them. The persistent session's
// navigations get them from the ad blocker's extension
// (adblock-extension/background.js), as a session.webRequest listener there
// would switch every extension's chrome.webRequest off; the in-memory
// sessions' (private windows', Tor's) from here.

/** The GREASE brand Chromium lists for a major version, and its version. */
function greaseBrand(seed: number): { brand: string; version: string } {
  // components/embedder_support/user_agent_utils.cc, GetGreasedUserAgentBrandVersion.
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  return {
    brand: `Not${chars[seed % chars.length]}A${chars[(seed + 1) % chars.length]}Brand`,
    version: versions[seed % versions.length],
  };
}

/**
 * Sec-CH-UA as Electron's Chromium gives it: the GREASE brand and Chromium,
 * in the order the major version shuffles them to (ShuffleBrandList, for two
 * brands).
 */
function secChUa(chromeVersion: string): string {
  const major = Number.parseInt(chromeVersion, 10);
  const list = [greaseBrand(major), { brand: 'Chromium', version: String(major) }];
  const order = [major % 2, (major + 1) % 2];
  const shuffled: typeof list = [];
  list.forEach((entry, i) => (shuffled[order[i]] = entry));
  return shuffled.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');
}

/** Sec-CH-UA-Platform for this OS, as Chromium names it. */
function secChUaPlatform(): string {
  const names: Partial<Record<NodeJS.Platform, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
  return `"${names[process.platform] ?? 'Unknown'}"`;
}

let hints: Record<string, string> | null = null;

/** The low-entropy client hints, by header name. */
function lowEntropyHints(): Record<string, string> {
  hints ??= {
    'sec-ch-ua': secChUa(process.versions.chrome),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': secChUaPlatform(),
  };
  return hints;
}

/**
 * Adds the client hints to a request's headers if it's a navigation to a
 * secure origin that has none, as Chrome sends them. Changes `headers` in
 * place; for a session.webRequest.onBeforeSendHeaders listener.
 */
export function addNavigationClientHints(
  details: { url: string; resourceType: string },
  headers: Record<string, string>,
): void {
  if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return;
  if (!details.url.startsWith('https://')) return;
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'sec-ch-ua')) return;
  Object.assign(headers, lowEntropyHints());
}

/**
 * Sends the client hints with a session's navigations. The session's one
 * onBeforeSendHeaders listener; a session that needs another (Tor's) calls
 * addNavigationClientHints from its own instead.
 */
export function sendNavigationClientHints(s: Electron.Session): void {
  s.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    addNavigationClientHints(details, details.requestHeaders);
    callback({ requestHeaders: details.requestHeaders });
  });
}

// Which user agent Din's pages and frames give.
//
// Browser tabs (and installed apps, which share their session) say they're
// Chrome, as Chromium-based browsers do: Electron's default user agent names
// Electron, which sites like YouTube take as a sign of an ad blocker. Din's own
// pages keep the Electron token, which the shell looks for
// (src/lib/isElectron.ts).
//
// A session's user agent isn't enough on its own: a cross-origin iframe in a
// process of its own gives the app's, app.userAgentFallback, in its
// navigator.userAgent and its requests' User-Agent. Cloudflare's challenge
// ("Verify you are human") runs in one such frame, on challenges.cloudflare.com,
// and the clearance it earns there is bound to the user agent that frame gave,
// so a page that said it was Chrome while its challenge said it was Electron
// got a clearance that didn't fit it: ticking the box reloaded the page to
// the same challenge, forever (getalby.com's sign-in). So the app's user agent
// is Chrome's, and every session but the browser's is given Electron's back.

import { app } from 'electron';

const ELECTRON_TOKENS = /\s(Electron|din)\/\S+/gi;

/** Electron's own user agent, as it was before any of this. */
const electronUserAgent = app.userAgentFallback;

/** The same user agent, saying it's Chrome. */
export const chromeUserAgent = electronUserAgent.replace(ELECTRON_TOKENS, '');

/**
 * Makes Chrome's user agent the app's, for frames whose session doesn't give
 * them one, and gives every session created from now on Electron's. Must run
 * before the app is ready, so the default session gets it too; browser
 * sessions then say they're Chrome with sayChrome.
 */
export function setupUserAgents(): void {
  app.userAgentFallback = chromeUserAgent;
  app.on('session-created', (s) => s.setUserAgent(electronUserAgent));
}

/** Has a session's pages say they're Chrome. */
export function sayChrome(s: Electron.Session): void {
  s.setUserAgent(chromeUserAgent);
}

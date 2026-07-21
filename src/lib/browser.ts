/**
 * Typed access to the Web Browser bridge exposed by the Electron preload
 * (`window.browser`, see electron/preload.cjs + electron/main.mts).
 *
 * A browser tab that navigates to a host with an untrusted TLS certificate
 * (self-signed, or issued by a private/internal CA) has its load rejected by
 * Chromium. The main process surfaces the failure here so the Web Browser app
 * can show a "proceed anyway" interstitial. If the user proceeds, the app pins
 * the exact (host, fingerprint) pair in the main process - persisted across
 * restarts - and reloads the tab, which is then trusted.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * must feature-detect via `getBrowserBridge()`.
 */

/** Details of a rejected TLS certificate for a browser tab. */
export interface CertificateErrorInfo {
  /** The tab guest's WebContents id (matches Tab.wcId). */
  wcId: number;
  /** The URL whose load was rejected. */
  url: string;
  /** The host that presented the untrusted certificate. */
  host: string;
  /** Chromium's error string (e.g. `net::ERR_CERT_AUTHORITY_INVALID`). */
  error: string;
  /** The certificate's fingerprint (the pinned identity). */
  fingerprint: string;
}

export interface BrowserBridge {
  /** Subscribe to rejected-certificate reports. Returns an unsubscribe fn. */
  onCertificateError(callback: (info: CertificateErrorInfo) => void): () => void;
  /**
   * Pin a (host, fingerprint) pair as trusted, then reload the offending tab
   * (`wcId`) to `url` from the main process. Resolves once pinned.
   */
  trustCertificate(
    host: string,
    fingerprint: string,
    wcId: number,
    url: string,
  ): Promise<void>;
  /**
   * Clear Chromium-side browsing data for the persistent browser session.
   * `cache` wipes the HTTP cache; `cookies` wipes cookies plus all site
   * storage (localStorage, IndexedDB, service workers, ...). The app's own
   * address-bar history is separate and cleared in-app. Resolves when done.
   */
  clearBrowsingData(options: {
    cache?: boolean;
    cookies?: boolean;
  }): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    browser?: BrowserBridge;
  }
}

/** The browser bridge, or undefined when running outside the Electron shell. */
export function getBrowserBridge(): BrowserBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.browser;
}

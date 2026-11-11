/**
 * Typed access to the Web Browser bridge exposed by the Electron preload
 * (`window.dinos.browser`, see electron/preload.cjs + electron/main.mts).
 *
 * A browser tab that navigates to a host with an untrusted TLS certificate
 * (self-signed, or issued by a private/internal CA) has its load rejected by
 * Chromium. The main process surfaces the failure here so the Web Browser app
 * can show a "proceed anyway" interstitial. If the user proceeds, the app pins
 * the exact (host, fingerprint) pair in the main process - persisted across
 * restarts - and reloads the tab, which is then trusted.
 *
 * Also carries Chromium's find-in-page: the app sends queries for a tab's
 * WebContents id, and match results stream back via onFindResult.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * must feature-detect via `getBrowserBridge()`.
 */

/**
 * A capability a site has to ask the user for. `background-sync` is an
 * installed nsite's periodic sync (electron/napp.mts); `clipboard` is reading
 * the clipboard from script (navigator.clipboard.read and readText).
 */
export type SiteCapability =
  | 'camera'
  | 'microphone'
  | 'geolocation'
  | 'notifications'
  | 'background-sync'
  | 'clipboard';

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

/** A find-in-page match report for a browser tab. */
export interface FindResult {
  /** The searched tab guest's WebContents id (matches Tab.wcId). */
  wcId: number;
  /** Total matches for the current query. */
  matches: number;
  /** 1-based ordinal of the active match. */
  activeMatchOrdinal: number;
  /** Whether this is the last update for the current find request. */
  finalUpdate: boolean;
}

/** The lifecycle state of a browser download. */
export type DownloadState =
  | 'progressing'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

/** A progress report for a file a browser tab is downloading to ~/Downloads. */
export interface DownloadInfo {
  /** Stable id for this download across its updates. */
  id: number;
  /** The initiating tab guest's WebContents id (matches Tab.wcId). */
  wcId: number;
  /** The download's source URL. */
  url: string;
  /** The final (de-duplicated) file name on disk. */
  filename: string;
  /** Absolute path the file is being written to (under ~/Downloads). */
  savePath: string;
  /** Current lifecycle state. */
  state: DownloadState;
  /** Bytes received so far. */
  receivedBytes: number;
  /** Total bytes, or 0 when the server didn't report a length. */
  totalBytes: number;
  /** Whether the download is currently paused. */
  paused?: boolean;
}

/** Options for a find-in-page query. */
export interface FindOptions {
  /** Search direction (default true = forward). */
  forward?: boolean;
  /** Continue the current search (Enter / Shift+Enter repeats). */
  findNext?: boolean;
  /** Case-sensitive search. */
  matchCase?: boolean;
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
  /**
   * Open a connection to `url`'s origin in the persistent browser session,
   * ahead of a likely navigation there. Never for private or Tor windows.
   */
  preconnect(url: string): void;
  /**
   * Let tabs show a `file:` URL the user asked for, and the folder it's in:
   * tabs refuse every other local file. In the persistent session, or
   * (`isPrivate`) the private one. Call it just before loading the URL.
   */
  allowLocalFile(url: string, isPrivate: boolean): void;
  /**
   * Search a tab (`wcId`) for `text`. An empty text clears the highlight.
   * Match counts arrive via onFindResult.
   */
  findInPage(wcId: number, text: string, options?: FindOptions): Promise<void>;
  /** Clear a tab's find-in-page highlight (find bar closed). */
  stopFindInPage(wcId: number): Promise<void>;
  /** Subscribe to find-in-page match results. Returns an unsubscribe fn. */
  onFindResult(callback: (result: FindResult) => void): () => void;
  /**
   * Subscribe to files dropped on a tab (`wcId`) whose page didn't take
   * them, to open in tabs of their own. Returns an unsubscribe fn.
   */
  onFilesDropped(callback: (drop: { wcId: number; paths: string[] }) => void): () => void;
  /**
   * Subscribe to download progress for browser tabs. Every download saves to
   * ~/Downloads; updates arrive keyed by a stable `id`, tagged with the
   * initiating tab's `wcId`. Returns an unsubscribe fn.
   */
  onDownload(callback: (info: DownloadInfo) => void): () => void;
  /** Run a completed download that is a Windows program. */
  openDownload(savePath: string): Promise<void>;
  /** Stop a download in flight; its last update arrives as 'cancelled'. */
  cancelDownload(id: number): Promise<void>;
  /**
   * What a site (`origin`, e.g. `https://meet.example`) has been allowed or
   * blocked. `isPrivate` reads the private window's answers instead.
   */
  getSiteInfo(origin: string, isPrivate: boolean): Promise<SiteInfo>;
  /** Allow or block a capability for a site, or forget the answer (null). */
  setSitePermission(
    origin: string,
    capability: SiteCapability,
    allow: boolean | null,
    isPrivate: boolean,
  ): Promise<void>;
  /**
   * Delete a site's cookies (its subdomains' too) and storage: localStorage,
   * IndexedDB, service workers, cache storage. Its permissions stay.
   */
  clearSiteData(origin: string, isPrivate: boolean): Promise<void>;
  /** Every site with a remembered answer for a capability (not private windows'). */
  /**
   * A website allowed to notify also comes with what it calls itself and its
   * icon (a data URL), as read from its web app manifest, when known.
   */
  listSitePermissions(
    capability: SiteCapability,
  ): Promise<{ origin: string; allow: boolean; name?: string | null; icon?: string | null }[]>;
  /** A remembered answer changed. Returns an unsubscribe fn. */
  onSitePermissionsChanged(callback: () => void): () => void;
}

/** What the address bar's site info shows about a site. */
export interface SiteInfo {
  /** Capabilities the user has answered for: true allowed, false blocked. */
  permissions: Partial<Record<SiteCapability, boolean>>;
  /** Whether the user chose to trust an invalid certificate for its host. */
  certificateException: boolean;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    browser?: BrowserBridge;
  }
}

/** The origin a page's permissions and data are filed under (as electron/main.mts's siteOriginOf). */
export function siteOriginOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && host ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}

/** The browser bridge, or undefined when running outside the Electron shell. */
export function getBrowserBridge(): BrowserBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.browser;
}

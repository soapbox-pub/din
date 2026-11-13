/**
 * Typed access to the OS-level nsite store exposed by the Electron preload
 * (`window.dinos.nsiteStore`, see electron/preload.cjs and electron/nsite-store.mts).
 *
 * Main keeps the signed manifest of every site Din has opened, and for an
 * installed site every file it names, for good. Hosts are always canonical
 * (`npub1…` or `<pubkeyB36><dtag>`).
 *
 * In a plain browser the store is absent, so callers must feature-detect via
 * `getNsiteStore()`.
 */
import type { WebShareTarget } from '@/lib/webShareTarget';

/** How a site presents itself as an app (see src/lib/nsiteAppInfo.ts). */
export interface NsiteAppInfo {
  /** The manifest event id this was derived from. */
  from: string;
  /** Which derivation produced it (NSITE_APP_INFO_VERSION); absent from the first. */
  version?: number;
  name: string | null;
  /** A small raster data URL. */
  icon: string | null;
  /**
   * The site's favicon, a small raster data URL, for places too small for the
   * icon (the title bar). Null when it has none, or it is the icon's own file.
   */
  favicon?: string | null;
  /** `#rrggbb`. */
  themeColor: string | null;
  /**
   * How the site opens `nostr:` links (its manifest's `protocol_handlers`):
   * a path on the site, with `%s` where the URI goes. Null when it doesn't.
   */
  nostr?: { path: string; kinds: number[] | null } | null;
  /**
   * The web app manifest's id, as a path on the site (`/` for most). A
   * website names the app as `nsite://<host><id>` to let it open its links.
   */
  id?: string | null;
  /** The https origins the manifest's `scope_extensions` ask for. */
  scopeExtensions?: string[];
  /**
   * The manifest's `shortcuts`, for the jump list on the app's Dock and
   * launcher tiles: a name and a path on the site each.
   */
  shortcuts?: { name: string; path: string }[];
  /**
   * The manifest's `share_target` (Din's share sheet, src/lib/share.ts):
   * the path a share opens, how it's sent (absent from info stored before
   * POST ones were read: GET), and the field each part goes in. Null when
   * it takes none.
   */
  share?: {
    path: string;
    method?: WebShareTarget['method'];
    enctype?: WebShareTarget['enctype'];
    params: WebShareTarget['params'];
  } | null;
}

/**
 * A website whose links an installed site opens: the site's manifest asks
 * for it (`scope_extensions`) and the website's
 * `/.well-known/web-app-origin-association` names the site back, as main
 * checked it.
 */
export interface NsiteLink {
  /** `https://host[:port]`. */
  origin: string;
  /** The path the website allows, `/` for all of it. */
  scope: string;
}

/** What the shell sees of a stored site. */
export interface NsiteSummary {
  host: string;
  /** The current manifest event's id. */
  eventId: string;
  /** The manifest's `title` tag. */
  title: string | null;
  /** The manifest's `created_at`. */
  updatedAt: number;
  installed: boolean;
  /** Unix ms. */
  installedAt: number | null;
  app: NsiteAppInfo | null;
  /** Path -> sha256 of the current manifest. */
  paths: Record<string, string>;
  /** The websites it opens links for; only ever an installed site's. */
  links: NsiteLink[];
}

export type NsiteInstallResult =
  | { ok: true; total: number; missing: number }
  | { ok: false; error: string };

export interface NsiteStore {
  installed(): Promise<NsiteSummary[]>;
  info(host: string): Promise<NsiteSummary | null>;
  install(host: string): Promise<NsiteInstallResult>;
  uninstall(host: string): Promise<void>;
  read(host: string, path: string): Promise<Uint8Array | null>;
  setAppInfo(host: string, info: NsiteAppInfo): Promise<void>;
  onChanged(callback: (event: { host: string }) => void): () => void;
  onProgress(callback: (event: { host: string; done: number; total: number }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    nsiteStore?: NsiteStore;
  }
}

/** The nsite store, or undefined outside the Electron shell. */
export function getNsiteStore(): NsiteStore | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.nsiteStore;
}

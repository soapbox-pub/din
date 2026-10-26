/**
 * Typed access to the OS-level nsite store exposed by the Electron preload
 * (`window.nsiteStore`, see electron/preload.cjs and electron/nsite-store.mts).
 *
 * Main keeps the signed manifest of every site Din has opened, and for an
 * installed site every file it names, for good. Hosts are always canonical
 * (`npub1…` or `<pubkeyB36><dtag>`).
 *
 * In a plain browser the store is absent, so callers must feature-detect via
 * `getNsiteStore()`.
 */

/** How a site presents itself as an app (see src/lib/nsiteAppInfo.ts). */
export interface NsiteAppInfo {
  /** The manifest event id this was derived from. */
  from: string;
  /** Which derivation produced it (NSITE_APP_INFO_VERSION); absent from the first. */
  version?: number;
  name: string | null;
  /** A small raster data URL. */
  icon: string | null;
  /** `#rrggbb`. */
  themeColor: string | null;
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
  interface Window {
    /** Present only inside the Electron shell. */
    nsiteStore?: NsiteStore;
  }
}

/** The nsite store, or undefined outside the Electron shell. */
export function getNsiteStore(): NsiteStore | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.nsiteStore;
}

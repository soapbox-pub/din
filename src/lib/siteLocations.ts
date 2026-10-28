/**
 * Where else browser tabs' pages say they can be found, through the
 * `window.dinos.siteLocations` bridge (electron/preload.cjs, backed by
 * electron/site-locations.mts): an onion service (Onion-Location) and an
 * nsite (Nsite-Location), each from a response header or a
 * `<meta http-equiv>`.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getSiteLocationsBridge()`.
 */

export interface SiteLocations {
  /** The page's onion service, an http(s) .onion URL. */
  onion: string | null;
  /** The page's nsite, an nsite:// URL. */
  nsite: string | null;
}

export interface SiteLocationsBridge {
  get(wcId: number): Promise<SiteLocations>;
  onChange(callback: (update: SiteLocations & { wcId: number }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    siteLocations?: SiteLocationsBridge;
  }
}

/** The site locations bridge, or undefined outside the Electron shell. */
export function getSiteLocationsBridge(): SiteLocationsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.siteLocations;
}

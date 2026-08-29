/**
 * Typed access to the nsite resolution host exposed by the Electron preload
 * (`window.nsiteHost`, see electron/preload.cjs).
 *
 * The nsite:// protocol handler runs in the main process (electron/nsite.mts),
 * which has no Nostr client. Turning a URL into a site means NIP-19 decoding,
 * a NIP-05 lookup, and a relay query for the NIP-5A manifest — all of which
 * belong in the renderer, where Nostrify, the user's relay list, and the query
 * cache already live. Main relays each lookup here; `NsiteBridgeHost`
 * subscribes with `onRequest` and answers with `respond`.
 *
 * Unlike the Nostr identity bridge this exposes no signing surface: a request
 * carries a URL, and a response carries a manifest or a redirect.
 *
 * In a plain browser the bridge is absent (there is no protocol handler to
 * serve), so callers must feature-detect via `getNsiteHostBridge()`.
 */

/** A URL the main-process protocol handler needs resolved. */
export interface NsiteBridgeRequest {
  /** Correlates the answer back to the waiting request. */
  requestId: number;
  /** The full nsite:// URL being loaded. */
  url: string;
}

/** A resolved NIP-5A site manifest, flattened for the protocol handler. */
export interface NsiteSiteManifest {
  /** Canonical host this manifest serves (`npub1…` or `<pubkeyB36><dtag>`). */
  host: string;
  /** 64-char lowercase hex pubkey of the site's author. */
  pubkey: string;
  /** The `d` tag for a named site, or null for a root site. */
  dtag: string | null;
  /** Absolute path -> sha256 hex, from the manifest's `path` tags. */
  paths: Record<string, string>;
  /** Blossom servers to try, most trusted first. */
  servers: string[];
  /** The manifest's `title` tag, if any. */
  title: string | null;
  /** The manifest event's `created_at`. */
  updatedAt: number;
}

/** Why a lookup failed, in terms the error page can speak. */
export type NsiteErrorCode = 'bad-url' | 'no-nip05' | 'no-manifest' | 'timeout';

/** The renderer's answer to a relayed lookup. */
export type NsiteResolution =
  | { kind: 'site'; site: NsiteSiteManifest }
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; code: NsiteErrorCode; message: string };

export interface NsiteHostBridge {
  /** Subscribe to relayed lookups. Returns an unsubscribe fn. */
  onRequest(callback: (request: NsiteBridgeRequest) => void): () => void;
  /** Answer a relayed lookup. */
  respond(response: { requestId: number; resolution: NsiteResolution }): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    nsiteHost?: NsiteHostBridge;
  }
}

/** The nsite host bridge, or undefined outside the Electron shell. */
export function getNsiteHostBridge(): NsiteHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.nsiteHost;
}

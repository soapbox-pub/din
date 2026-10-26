/**
 * Typed access to the nsite resolution host exposed by the Electron preload
 * (`window.nsiteHost`, see electron/preload.cjs).
 *
 * The nsite:// protocol handler runs in the main process (electron/nsite.mts),
 * which has no Nostr client. Turning a URL into a site means NIP-19 decoding
 * and a relay query for the NIP-5A manifest, both of which
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

import type { NostrEvent } from '@nostrify/nostrify';

/** A URL the main-process protocol handler needs resolved. */
export interface NsiteBridgeRequest {
  /** Correlates the answer back to the waiting request. */
  requestId: number;
  /** The full nsite:// URL being loaded. */
  url: string;
}

/**
 * The signed events a site resolves to. Main verifies the signatures itself
 * and keeps the events in its nsite store, so nothing here is taken on trust.
 */
export interface NsiteSiteEvents {
  /** The newest kind 15128 / 35128 manifest found for the site. */
  manifest: NostrEvent;
  /** The author's BUD-03 server list (kind 10063), if they publish one. */
  serverList: NostrEvent | null;
  /** Din's own Blossom servers, tried after the author's. */
  servers: string[];
}

/** Why a lookup failed, in terms the error page can speak. */
export type NsiteErrorCode = 'bad-url' | 'no-manifest' | 'timeout';

/** The renderer's answer to a relayed lookup. */
export type NsiteResolution =
  | ({ kind: 'site' } & NsiteSiteEvents)
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

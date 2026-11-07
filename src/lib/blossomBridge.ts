/**
 * Typed access to the blossom: server lookup host exposed by the Electron
 * preload (`window.dinos.blossomHost`, see electron/preload.cjs).
 *
 * The blossom: protocol handler runs in the main process
 * (electron/blossom.mts), which has no Nostr client. When a link's own
 * servers don't have its file, main asks here for the servers its authors
 * list (kind 10063) and the user's own; `BlossomBridgeHost` subscribes with
 * `onRequest` and answers with `respond`. The answer is only where to look:
 * main checks every byte against the hash.
 *
 * In a plain browser the bridge is absent, so callers feature-detect via
 * `getBlossomHostBridge()`.
 */

/** A lookup the main-process protocol handler needs answered. */
export interface BlossomBridgeRequest {
  /** Correlates the answer back to the waiting request. */
  requestId: number;
  /** Hex pubkeys of the link's authors (its `as` hints). */
  authors: string[];
}

/** The renderer's answer. */
export interface BlossomBridgeResponse {
  requestId: number;
  /** The authors' servers, from their kind 10063 lists, in order. */
  authorServers: string[];
  /** The user's own servers, then Din's. */
  servers: string[];
}

export interface BlossomHostBridge {
  /** Subscribe to lookups. Returns an unsubscribe fn. */
  onRequest(callback: (request: BlossomBridgeRequest) => void): () => void;
  /** Answer a lookup. */
  respond(response: BlossomBridgeResponse): void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    blossomHost?: BlossomHostBridge;
  }
}

/** The blossom host bridge, or undefined outside the Electron shell. */
export function getBlossomHostBridge(): BlossomHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.blossomHost;
}

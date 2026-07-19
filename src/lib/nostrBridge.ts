/**
 * Typed access to the Nostr identity bridge host exposed by the Electron
 * preload (`window.nostrHost`, see electron/preload.cjs + electron/main.cjs).
 *
 * Installed web apps run in a <webview> that gets a NIP-07 `window.nostr`
 * provider (electron/webview-preload.cjs). That provider holds no keys - it
 * relays every call to the main process, which forwards it here, to the shell
 * renderer, where the signed-in account's signer actually runs. The renderer
 * subscribes with `onRequest` and answers each request with `respond`.
 *
 * In a plain browser (`make dev-browser`) the bridge is absent - there are no
 * <webview> guests to serve - so callers must feature-detect via
 * `getNostrHostBridge()`.
 */

/** A NIP-07 call relayed from an installed web-app guest. */
export interface NostrBridgeRequest {
  /** Correlates the eventual response back to the waiting guest call. */
  requestId: number;
  /**
   * The NIP-07 method: 'getPublicKey' | 'signEvent' | 'getRelays' |
   * 'nip04.encrypt' | 'nip04.decrypt' | 'nip44.encrypt' | 'nip44.decrypt'.
   */
  method: string;
  /** Method arguments (shape depends on `method`). */
  params?: unknown;
  /** The requesting app's origin (informational; e.g. for logging). */
  origin: string;
}

/** The shell renderer's answer to a relayed request. */
export interface NostrBridgeResponse {
  requestId: number;
  ok: boolean;
  /** Present when `ok` - the method's return value. */
  result?: unknown;
  /** Present when not `ok` - a human-readable failure message. */
  error?: string;
}

export interface NostrHostBridge {
  /** Subscribe to relayed signing requests. Returns an unsubscribe fn. */
  onRequest(callback: (request: NostrBridgeRequest) => void): () => void;
  /** Answer a relayed request. */
  respond(response: NostrBridgeResponse): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    nostrHost?: NostrHostBridge;
  }
}

/** The Nostr host bridge, or undefined when running outside the Electron shell. */
export function getNostrHostBridge(): NostrHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.nostrHost;
}

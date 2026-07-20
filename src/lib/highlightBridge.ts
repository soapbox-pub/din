/**
 * Typed access to the highlight bridge host exposed by the Electron preload
 * (`window.highlightHost`, see electron/preload.cjs + electron/main.mts).
 *
 * The ad-hoc Web Browser's tabs get a NIP-84 "Highlight" affordance
 * (electron/browser-highlight-preload.cjs): selecting text on any page shows a
 * floating button whose click is relayed to the main process, forwarded here,
 * to the shell renderer, where the signed-in account's signer publishes a kind
 * 9802 Highlight referencing the page URL. The renderer subscribes with
 * `onRequest` and answers each request with `respond`.
 *
 * Unlike the Nostr identity bridge (`window.nostrHost`), this carries no general
 * signing surface: a request is only ever `{ url, text, context }` for a fixed
 * highlight kind. In a plain browser (`npm run dev:browser`) the bridge is
 * absent - there are no <webview> tabs to serve - so callers feature-detect via
 * `getHighlightHostBridge()`.
 */

/** A highlight-publish request relayed from a browser tab. */
export interface HighlightBridgeRequest {
  /** Correlates the eventual response back to the waiting tab. */
  requestId: number;
  /** The tab's cleaned source URL (authoritative; read in main, not the page). */
  url: string;
  /** The highlighted excerpt (event `content`). */
  text: string;
  /** Surrounding prose containing the highlight verbatim (NIP-84 `context`). */
  context?: string;
}

/** The shell renderer's answer to a relayed highlight request. */
export interface HighlightBridgeResponse {
  requestId: number;
  ok: boolean;
  /** Present when `ok` - the published event id. */
  result?: unknown;
  /** Present when not `ok` - a human-readable failure message. */
  error?: string;
}

export interface HighlightHostBridge {
  /** Subscribe to relayed highlight requests. Returns an unsubscribe fn. */
  onRequest(callback: (request: HighlightBridgeRequest) => void): () => void;
  /** Answer a relayed request. */
  respond(response: HighlightBridgeResponse): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    highlightHost?: HighlightHostBridge;
  }
}

/** The highlight host bridge, or undefined when running outside the Electron shell. */
export function getHighlightHostBridge(): HighlightHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.highlightHost;
}

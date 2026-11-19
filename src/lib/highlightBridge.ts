/**
 * Typed access to the highlight bridge host exposed by the Electron preload
 * (`window.dinos.highlightHost`, see electron/preload.cjs + electron/main.mts).
 *
 * The Web Browser's tabs offer NIP-84 highlights in their right-click menu:
 * "Highlight on Nostr" on selected text is sent from the main process to the
 * shell renderer, which shows the highlight for the user to review and comment
 * on before the signed-in account's signer publishes a kind 9802 Highlight
 * referencing the page URL. The renderer subscribes with `onRequest`.
 *
 * Unlike the Nostr identity bridge (`window.dinos.nostrHost`), this carries no general
 * signing surface: a request is only ever `{ url, title, text, context }` for a fixed
 * highlight kind. In a plain browser (`npm run dev:browser`) the bridge is
 * absent - there are no <webview> tabs to serve - so callers feature-detect via
 * `getHighlightHostBridge()`.
 */

/** A highlight request relayed from a browser tab. */
export interface HighlightBridgeRequest {
  /** Tells requests apart. */
  requestId: number;
  /** The tab's cleaned source URL (authoritative; read in main, not the page). */
  url: string;
  /** The tab's title, for showing where the highlight is from. Page-controlled. */
  title?: string;
  /** The highlighted excerpt (event `content`). */
  text: string;
  /** Surrounding prose containing the highlight verbatim (NIP-84 `context`). */
  context?: string;
}

export interface HighlightHostBridge {
  /** Subscribe to relayed highlight requests. Returns an unsubscribe fn. */
  onRequest(callback: (request: HighlightBridgeRequest) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    highlightHost?: HighlightHostBridge;
  }
}

/** The highlight host bridge, or undefined when running outside the Electron shell. */
export function getHighlightHostBridge(): HighlightHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.highlightHost;
}

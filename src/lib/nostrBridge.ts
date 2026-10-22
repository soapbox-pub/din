/**
 * Typed access to the Nostr identity bridge host exposed by the Electron
 * preload (`window.nostrHost`, see electron/preload.cjs + electron/main.mts).
 *
 * Browser tabs and installed web apps get a NIP-07 `window.nostr`
 * (electron/nostr-preload.cjs), and apps connected to Din as a remote signer
 * (NIP-46, electron/bunker.mts) ask the same things. None of them hold keys:
 * main relays every call here, to the shell renderer, which decides whether
 * to allow it and signs with the account's signer. The renderer subscribes
 * with `onRequest` and answers each request with `respond`.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent - there are
 * no guests to serve - so callers must feature-detect via
 * `getNostrHostBridge()`.
 */

import type { SiteGrant } from '@/lib/signerPermissions';

/** Where a request came from. */
export type NostrRequestSource = 'tab' | 'app' | 'bunker';

/** A bunker client, as main describes it alongside its requests. */
export interface BunkerClientInfo {
  id: string;
  name?: string;
  url?: string;
  image?: string;
  grants: Pick<SiteGrant, 'methods' | 'kinds'>;
}

/** A NIP-07 call relayed from a guest or a bunker client. */
export interface NostrBridgeRequest {
  /** Correlates the eventual response back to the waiting caller. */
  requestId: number;
  /**
   * The NIP-07 method: 'getPublicKey' | 'signEvent' | 'getRelays' |
   * 'nip04.encrypt' | 'nip04.decrypt' | 'nip44.encrypt' | 'nip44.decrypt'.
   */
  method: string;
  /** Method arguments (shape depends on `method`). */
  params?: unknown;
  /**
   * Who is asking, as main established it: the calling frame's origin
   * (`https://…`, `nsite://…`), or `nip46:<connection>` for a bunker client.
   */
  origin: string;
  source: NostrRequestSource;
  /** The guest that asked (tabs and apps). */
  wcId: number | null;
  /** Whether the page had just been clicked or typed in (its own report). */
  userActivated: boolean;
  /** Bunker clients: the account the connection signs for. */
  account?: string;
  /** Bunker clients: who they are and what they're allowed. */
  client?: BunkerClientInfo;
}

/** A decision a bunker client's request should leave behind (kept by main). */
export interface RememberedDecision {
  method: string;
  kind?: number;
  decision: 'allow' | 'deny';
}

/** The shell renderer's answer to a relayed request. */
export interface NostrBridgeResponse {
  requestId: number;
  ok: boolean;
  /** Present when `ok` - the method's return value. */
  result?: unknown;
  /** Present when not `ok` - a human-readable failure message. */
  error?: string;
  /** Bunker clients only. */
  remember?: RememberedDecision;
}

export interface NostrHostBridge {
  /** Subscribe to relayed requests. Returns an unsubscribe fn. */
  onRequest(callback: (request: NostrBridgeRequest) => void): () => void;
  /** Subscribe to requests main gave up on. Returns an unsubscribe fn. */
  onCancel(callback: (requestId: number) => void): () => void;
  /** Subscribe to a guest's page going away. Returns an unsubscribe fn. */
  onPageChanged(callback: (wcId: number) => void): () => void;
  /** Answer a relayed request. */
  respond(response: NostrBridgeResponse): void;
  /** Tell every page with window.nostr that the account changed. */
  accountChanged(): void;
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

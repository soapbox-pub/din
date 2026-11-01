/**
 * Din's own app windows asking for the signer (din.account.nostr). Their
 * requests go to the same host as window.nostr's (NostrBridgeHost), which
 * decides, asks the user, and remembers, keyed by the app's origin.
 */

import type { NostrBridgeRequest } from '@/lib/nostrBridge';

type Handler = (request: NostrBridgeRequest) => Promise<unknown>;

let handler: Handler | null = null;

/** Main's requests count up from 1; these count down, so a cancel from main never names one. */
let nextRequestId = -1;

/** Serve apps' requests (NostrBridgeHost). Returns a function that stops. */
export function serveAppSignerRequests(serve: Handler): () => void {
  handler = serve;
  return () => {
    if (handler === serve) handler = null;
  };
}

/** Ask the signer for an app window: resolves with the answer, or rejects if the user says no. */
export function askSignerForApp(
  request: Pick<NostrBridgeRequest, 'method' | 'params' | 'origin' | 'wcId'>,
): Promise<unknown> {
  if (!handler) return Promise.reject(new Error("Din's signer isn't available"));
  return handler({ ...request, requestId: nextRequestId--, source: 'app', userActivated: false });
}

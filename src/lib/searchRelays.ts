/**
 * Relays that implement NIP-50 `search` filters. The user's general read
 * relays may not support the search capability, so the pool's reqRouter
 * (see NostrProvider) sends any REQ containing a `search` filter to this
 * group instead of the configured read relays.
 */
export const SEARCH_RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.dreamith.to',
];

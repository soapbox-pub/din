import type { RelayMetadata } from '@/contexts/AppContext';

/**
 * The user's relay list (NIP-65, kind 10002) and Blossom server list
 * (BUD-03, kind 10063) as Settings → Nostr & Storage and `din nostr` edit
 * them: their URLs as typed, and the tags their events carry.
 */

type Relay = RelayMetadata['relays'][number];

/** A relay URL as typed, with `wss://` added when it has no scheme. */
export function normalizeRelayUrl(url: string): string {
  url = url.trim();
  try {
    return new URL(url).toString();
  } catch {
    try {
      return new URL(`wss://${url}`).toString();
    } catch {
      return url;
    }
  }
}

/** A Blossom server URL as typed, with `https://` added when it has no scheme; null if it isn't one. */
export function normalizeBlossomUrl(url: string): string | null {
  let trimmed = url.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** A kind 10002 event's `r` tags. */
export function relayListTags(relays: readonly Relay[]): string[][] {
  return relays.flatMap((relay) => {
    if (relay.read && relay.write) return [['r', relay.url]];
    if (relay.read) return [['r', relay.url, 'read']];
    if (relay.write) return [['r', relay.url, 'write']];
    return [];
  });
}

/** A kind 10063 event's `server` tags. */
export function blossomListTags(servers: readonly string[]): string[][] {
  return servers.map((url) => ['server', url]);
}

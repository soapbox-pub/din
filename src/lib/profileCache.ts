import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';

/**
 * A persisted kind 0 profile: the raw event plus its parsed metadata.
 *
 * Cached to `localStorage` so a known profile survives page reloads and
 * relay outages — a logged-in user with a kind 0 should never render as
 * "Anonymous" just because a fresh relay query was slow.
 */
export interface CachedProfile {
  event: NostrEvent;
  metadata?: NostrMetadata;
}

const PREFIX = 'nostr:profile:';

function profileCacheKey(pubkey: string): string {
  return `${PREFIX}${pubkey}`;
}

/** Read a cached kind 0 profile for `pubkey`, or `undefined` if none is stored. */
export function readProfileCache(pubkey: string | undefined): CachedProfile | undefined {
  if (!pubkey) return undefined;
  try {
    const raw = localStorage.getItem(profileCacheKey(pubkey));
    if (raw === null) return undefined;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('event' in parsed)) {
      return undefined;
    }

    const { event } = parsed as { event: NostrEvent };
    // Re-derive metadata from the event content so a corrupt or schema-changed
    // cache never surfaces bad data.
    try {
      const metadata = n.json().pipe(n.metadata()).parse(event.content);
      return { event, metadata };
    } catch {
      return { event };
    }
  } catch (error) {
    console.warn(`Failed to read profile cache for ${pubkey}:`, error);
    return undefined;
  }
}

/**
 * Persist a kind 0 profile for `pubkey`. No-ops without an event, and keeps
 * whichever copy is newer (last-write-wins by `created_at`) so a stale relay
 * can't overwrite a fresher cached profile.
 */
export function writeProfileCache(pubkey: string | undefined, event: NostrEvent | undefined): void {
  if (!pubkey || !event) return;
  try {
    const key = profileCacheKey(pubkey);
    const existingRaw = localStorage.getItem(key);
    if (existingRaw !== null) {
      try {
        const existing = JSON.parse(existingRaw) as { event?: NostrEvent };
        if (existing.event && existing.event.created_at >= event.created_at) {
          return;
        }
      } catch {
        // Corrupt entry — fall through and overwrite it.
      }
    }
    localStorage.setItem(key, JSON.stringify({ event }));
  } catch (error) {
    console.warn(`Failed to write profile cache for ${pubkey}:`, error);
  }
}

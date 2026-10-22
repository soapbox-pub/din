import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { profileMetadataSchema, readProfileCache, writeProfileCache } from '@/lib/profileCache';

type NostrClient = ReturnType<typeof useNostr>['nostr'];

/** How long profile requests wait to share one REQ (and how many fit in it). */
const BATCH_WINDOW_MS = 10;
const BATCH_MAX = 100;

interface ProfileBatch {
  waiting: Map<string, ((event: NostrEvent | undefined) => void)[]>;
  timer: ReturnType<typeof setTimeout>;
}

/** The open batch per client: one pool behind every useAuthor on the page. */
const batches = new WeakMap<NostrClient, ProfileBatch>();

/**
 * The newest kind 0 for `pubkey`. Requests made within a few ms of each
 * other (a list of cards mounting, their retries) go out as one REQ per relay
 * instead of one each, which also means one copy of each event to parse and
 * verify per relay rather than one per card.
 */
function queryProfile(nostr: NostrClient, pubkey: string): Promise<NostrEvent | undefined> {
  return new Promise((resolve) => {
    let batch = batches.get(nostr);
    if (!batch) {
      const created: ProfileBatch = {
        waiting: new Map(),
        timer: setTimeout(() => {
          batches.delete(nostr);
          void flushProfiles(nostr, created.waiting);
        }, BATCH_WINDOW_MS),
      };
      batch = created;
      batches.set(nostr, batch);
    }
    const waiting = batch.waiting.get(pubkey);
    if (waiting) waiting.push(resolve);
    else batch.waiting.set(pubkey, [resolve]);
  });
}

async function flushProfiles(
  nostr: NostrClient,
  waiting: Map<string, ((event: NostrEvent | undefined) => void)[]>,
): Promise<void> {
  const pubkeys = [...waiting.keys()];
  await Promise.all(
    Array.from({ length: Math.ceil(pubkeys.length / BATCH_MAX) }, async (_, i) => {
      const authors = pubkeys.slice(i * BATCH_MAX, (i + 1) * BATCH_MAX);
      let events: NostrEvent[] = [];
      try {
        // Kind 0 is replaceable: the pool keeps the newest per author, and
        // limits the REQ to one per author.
        events = await nostr.query(
          [{ kinds: [0], authors }],
          { signal: AbortSignal.timeout(1500) },
        );
      } catch {
        // Resolved as not found below; useAuthor's retries take it from there.
      }
      const newest = new Map<string, NostrEvent>();
      for (const event of events) {
        const seen = newest.get(event.pubkey);
        if (event.kind === 0 && (!seen || event.created_at > seen.created_at)) {
          newest.set(event.pubkey, event);
        }
      }
      for (const pubkey of authors) {
        for (const resolve of waiting.get(pubkey) ?? []) resolve(newest.get(pubkey));
      }
    }),
  );
}

/** A profile from the relays (for the `['nostr', 'author', pubkey]` query). */
export async function fetchAuthor(
  nostr: NostrClient,
  pubkey: string,
): Promise<{ event?: NostrEvent; metadata?: NostrMetadata }> {
  const event = await queryProfile(nostr, pubkey);

  if (!event) {
    // Fall back to a persisted profile before giving up, so a slow or
    // unreachable relay never demotes a known author to "unknown".
    const cached = readProfileCache(pubkey);
    if (cached) return cached;
    throw new Error('No event found');
  }

  writeProfileCache(pubkey, event);

  try {
    const metadata = profileMetadataSchema.parse(event.content);
    return { metadata, event };
  } catch {
    return { event };
  }
}

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<{ event?: NostrEvent; metadata?: NostrMetadata }>({
    queryKey: ['nostr', 'author', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) {
        return {};
      }
      return fetchAuthor(nostr, pubkey);
    },
    // Seed instantly from the persisted cache so a returning user's profile
    // renders immediately on load; `updatedAt: 0` marks it stale so a fresh
    // copy is still fetched in the background.
    initialData: () => readProfileCache(pubkey),
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60 * 1000, // Keep cached data fresh for 5 minutes
    retry: 3,
  });
}

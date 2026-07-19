import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { readProfileCache, writeProfileCache } from '@/lib/profileCache';

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<{ event?: NostrEvent; metadata?: NostrMetadata }>({
    queryKey: ['nostr', 'author', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) {
        return {};
      }

      const [event] = await nostr.query(
        [{ kinds: [0], authors: [pubkey!], limit: 1 }],
        { signal: AbortSignal.timeout(1500) },
      );

      if (!event) {
        // Fall back to a persisted profile before giving up, so a slow or
        // unreachable relay never demotes a known author to "unknown".
        const cached = readProfileCache(pubkey);
        if (cached) return cached;
        throw new Error('No event found');
      }

      writeProfileCache(pubkey, event);

      try {
        const metadata = n.json().pipe(n.metadata()).parse(event.content);
        return { metadata, event };
      } catch {
        return { event };
      }
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

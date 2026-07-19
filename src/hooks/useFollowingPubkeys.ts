import { useMemo } from 'react';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useCurrentUser } from '@/hooks/useCurrentUser';

/**
 * The set of pubkeys the logged-in user follows, read from their latest kind 3
 * contact list. Used to gate notifications to "people I follow" (see the
 * `onlyFollowing` preference). Returns an empty array while logged out or
 * before the contact list loads.
 *
 * Filtered by `authors: [user.pubkey]` so a malicious relay can't inject a
 * forged follow list for someone else.
 */
export function useFollowingPubkeys(enabled = true): string[] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  const { data } = useQuery<string[]>({
    queryKey: ['following', user?.pubkey ?? ''],
    enabled: enabled && !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      if (!user) return [];
      const [event] = await nostr.query(
        [{ kinds: [3], authors: [user.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );
      if (!event) return [];
      return event.tags
        .filter(([name, value]) => name === 'p' && typeof value === 'string')
        .map(([, value]) => value);
    },
  });

  return useMemo(() => data ?? [], [data]);
}

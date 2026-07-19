import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery } from '@tanstack/react-query';
import { NSchema as n, NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { readProfileCache, writeProfileCache } from '@/lib/profileCache';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { logins, setLogin, removeLogin } = useNostrLogin();

  const { data: authors = [], isLoading } = useQuery({
    queryKey: ['nostr', 'logins', logins.map((l) => l.id).join(';')],
    queryFn: async () => {
      const events = await nostr.query(
        [{ kinds: [0], authors: logins.map((l) => l.pubkey) }],
        { signal: AbortSignal.timeout(1500) },
      );

      return logins.map(({ id, pubkey }): Account => {
        const event = events.find((e) => e.pubkey === pubkey);
        if (event) writeProfileCache(pubkey, event);
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event?.content);
          return { id, pubkey, metadata, event };
        } catch {
          // No fresh event this round — fall back to the persisted profile so
          // a logged-in account with a known kind 0 never shows as "Anonymous".
          const cached = readProfileCache(pubkey);
          if (cached) return { id, pubkey, metadata: cached.metadata ?? {}, event: cached.event };
          return { id, pubkey, metadata: {}, event };
        }
      });
    },
    // Seed from the persisted cache so account names render instantly on load.
    initialData: () => {
      const seeded = logins.map(({ id, pubkey }): Account => {
        const cached = readProfileCache(pubkey);
        return { id, pubkey, metadata: cached?.metadata ?? {}, event: cached?.event };
      });
      return seeded.some((a) => a.event) ? seeded : undefined;
    },
    initialDataUpdatedAt: 0,
    retry: 3,
  });

  // Current user is the first login
  const currentUser: Account | undefined = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  // Other users are all logins except the current one
  const otherUsers = (authors || []).slice(1) as Account[];

  return {
    authors,
    currentUser,
    otherUsers,
    isLoading,
    setLogin,
    removeLogin,
  };
}
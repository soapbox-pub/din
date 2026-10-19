import { useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NSchema as n, NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { NOSTRD_STATUS_KEY, useNostrd } from '@/hooks/useNostrd';
import { NOSTRD_LOGIN, nostrdCall } from '@/lib/nostrd';
import { readProfileCache, writeProfileCache } from '@/lib/profileCache';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { logins, setLogin: setCurrentLogin, removeLogin } = useNostrLogin();
  const { use: useNostrdAccounts } = useNostrd();
  const queryClient = useQueryClient();

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

  /** Whether an account is kept in nostrd, where removing it deletes its key. */
  const isNostrdAccount = useCallback(
    (id: string) => logins.some((login) => login.id === id && login.type === NOSTRD_LOGIN),
    [logins],
  );

  const refreshNostrd = useCallback(
    () => queryClient.invalidateQueries({ queryKey: NOSTRD_STATUS_KEY }),
    [queryClient],
  );

  /**
   * Switch to an account. An nostrd account becomes nostrd's active one (and
   * NostrdSync follows); switching to any other signs out of nostrd's.
   */
  const setLogin = useCallback(async (id: string) => {
    const login = logins.find((l) => l.id === id);
    if (!login) return;
    if (login.type === NOSTRD_LOGIN) {
      await nostrdCall('set_active', [login.pubkey]);
    } else {
      setCurrentLogin(id);
      if (useNostrdAccounts) await nostrdCall('set_active', [null]).catch(() => {});
    }
    await refreshNostrd();
  }, [logins, setCurrentLogin, useNostrdAccounts, refreshNostrd]);

  /** Sign in as an account nostrd holds. */
  const signInWithNostrd = useCallback(async (pubkey: string) => {
    await nostrdCall('set_active', [pubkey]);
    await refreshNostrd();
  }, [refreshNostrd]);

  /** Sign out of an account. An nostrd account's key stays on the computer. */
  const signOut = useCallback(async (id: string) => {
    if (isNostrdAccount(id)) {
      await nostrdCall('set_active', [null]);
      await refreshNostrd();
    } else {
      removeLogin(id);
    }
  }, [isNostrdAccount, removeLogin, refreshNostrd]);

  /** Delete an nostrd account's key from the computer. Needs nostrd's password, if it has one. */
  const removeNostrdAccount = useCallback(async (pubkey: string, password: string) => {
    await nostrdCall('remove_account', [pubkey, password]);
    await refreshNostrd();
  }, [refreshNostrd]);

  return {
    authors,
    currentUser,
    otherUsers,
    isLoading,
    setLogin,
    signOut,
    signInWithNostrd,
    removeLogin,
    removeNostrdAccount,
    isNostrdAccount,
  };
}
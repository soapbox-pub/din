import { createContext, useContext, useMemo } from 'react';
import type { NRelay } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import type { DinStore, StoreState } from '@/sdk/din';
import { NSITE_CATALOG_RELAY } from '@/lib/nsiteCatalog';

/**
 * The App Store's view of the desktop (`din.store`, pushed whenever it
 * changes), and its own connections to relays: the catalog is strangers'
 * events, read and rendered here, in the store's own process, never the
 * desktop's. The relays are the ones the desktop names (the user's read
 * relays and the one nsites are published to); the store signs nothing and
 * publishes nothing itself.
 */

export const StoreStateContext = createContext<StoreState | null>(null);

/** `din.store`: the app runs only in Din, which defines it before the app's first script. */
export function dinStore(): DinStore {
  const din = window.din;
  if (!din) throw new Error('The App Store runs only in Din');
  return din.store;
}

/** Where to look before the desktop has said. */
export const FALLBACK_RELAYS = [NSITE_CATALOG_RELAY];

/** What the desktop last said, or null until it has. */
export function useStoreState(): StoreState | null {
  return useContext(StoreStateContext);
}

/** The signed-in user's pubkey, or null. */
export function usePubkey(): string | null {
  return useStoreState()?.pubkey ?? null;
}

/**
 * Where the store reads manifests and themes: the relays the desktop names.
 * A new object when they change, so queries keyed on it start over.
 */
export function useManifestRelays(): NRelay {
  const { nostr } = useNostr();
  const urls = useStoreState()?.relays.join(' ') ?? '';
  return useMemo(() => nostr.group(urls ? urls.split(' ') : FALLBACK_RELAYS), [nostr, urls]);
}

/** The relays read from, as a query key: queries keyed on it start over when they change. */
export function useRelaysKey(): string {
  return useStoreState()?.relays.join(' ') ?? '';
}

/**
 * The pubkeys the signed-in user follows, from their newest kind 3, asked
 * only of their own events so a relay can't hand over someone else's list.
 */
export function useFollowingPubkeys(): string[] {
  const relays = useManifestRelays();
  const pubkey = usePubkey();
  const { data } = useQuery<string[]>({
    queryKey: ['following', pubkey ?? ''],
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const events = await relays.query(
        [{ kinds: [3], authors: [pubkey as string], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );
      const newest = events.filter((e) => e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0];
      return (newest?.tags ?? []).filter(([name, value]) => name === 'p' && typeof value === 'string').map(([, value]) => value);
    },
  });
  return useMemo(() => data ?? [], [data]);
}

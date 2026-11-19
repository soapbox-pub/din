import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { Nip07 } from '@/sdk/din';
import { useDocumentVisible } from '@/sdk/react';
import { bitcoinAddress } from '@/shared/bitcoin';
import { fetchActivity, fetchBalance, fetchBtcPrice, fetchFeeRates, type Activity } from '@/shared/esplora';

/** Din's signer, as the app's `window.nostr` (the `nostr` permission). */
export function signer(): Nip07 {
  const nostr = (window as Window & { nostr?: Nip07 }).nostr;
  if (!nostr) throw new Error('Wallet can’t use your account here');
  return nostr;
}

/**
 * The signed-in account's pubkey, or null, asked again when the window comes
 * back to the front: another account may be signed in by then.
 */
export function usePubkey(): { pubkey: string | null; loading: boolean } {
  const { data, isPending } = useQuery({
    queryKey: ['pubkey'],
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    queryFn: () => signer().getPublicKey().catch(() => null),
  });
  return { pubkey: data ?? null, loading: isPending };
}

export function useAddress(pubkey: string | null): string | null {
  return useMemo(() => {
    if (!pubkey) return null;
    try {
      return bitcoinAddress(pubkey);
    } catch {
      return null;
    }
  }, [pubkey]);
}

/** Looked at again this often while the window shows, and when it comes back to the front. */
const REFRESH_MS = 30_000;

export function useBalance(address: string | null) {
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: ['balance', address],
    enabled: Boolean(address),
    queryFn: ({ signal }) => fetchBalance(address!, signal),
    refetchInterval: visible ? REFRESH_MS : false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

/** The address's history, newest first, a page of confirmed ones at a time. */
export function useActivity(address: string | null) {
  const visible = useDocumentVisible();
  const query = useInfiniteQuery({
    queryKey: ['activity', address],
    enabled: Boolean(address),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchActivity(address!, pageParam, signal),
    // Esplora's first page is the mempool's and up to 25 confirmed; later ones, 25 confirmed.
    getNextPageParam: (last: Activity[]) => {
      const confirmed = last.filter((a) => a.confirmed);
      return confirmed.length >= 25 ? confirmed[confirmed.length - 1].txid : undefined;
    },
    refetchInterval: visible ? REFRESH_MS : false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flat().filter((a) => !seen.has(a.txid) && seen.add(a.txid));
  }, [query.data]);
  return { ...query, items };
}

export function usePrice() {
  return useQuery({
    queryKey: ['price'],
    queryFn: ({ signal }) => fetchBtcPrice(signal),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
}

export function useFeeRates() {
  return useQuery({
    queryKey: ['fees'],
    queryFn: ({ signal }) => fetchFeeRates(signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** Look at the address again now: after sending, or the Refresh button. */
export function useRefresh(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['balance'] }),
      client.invalidateQueries({ queryKey: ['activity'] }),
      client.invalidateQueries({ queryKey: ['price'] }),
    ]);
  }, [client]);
}

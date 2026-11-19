/**
 * Torrents' view of din.system.torrents: the transfers, kept current by
 * main's `torrents:changed`, the status and settings, and one transfer's
 * details for the inspector, read again every second or so while shown.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import type { Torrent, TorrentsBridge, TorrentsChange, TorrentsStatus } from '@/lib/torrents';

export const KEY = ['torrents'] as const;

export function useBridge(): TorrentsBridge | undefined {
  return useDin().system.torrents;
}

export function useTorrentsStatus() {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'status'],
    queryFn: () => bridge!.status(),
    enabled: !!bridge,
    staleTime: Infinity,
    // Until it can run: Transmission may be being installed.
    refetchInterval: (query) => (query.state.data && !query.state.data.available ? 3000 : false),
  });
}

/** The transfers, replaced whenever main says they moved, with the speeds and settings it says with them. */
export function useTorrents(enabled: boolean) {
  const bridge = useBridge();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!bridge || !enabled) return;
    return bridge.onChanged((change: TorrentsChange) => {
      queryClient.setQueryData<Torrent[]>([...KEY, 'list'], change.torrents);
      queryClient.setQueryData<TorrentsStatus>([...KEY, 'status'], (old) =>
        old ? { ...old, settings: change.settings, rateDown: change.rateDown, rateUp: change.rateUp } : old,
      );
      void queryClient.invalidateQueries({ queryKey: [...KEY, 'detail'] });
    });
  }, [bridge, enabled, queryClient]);
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => bridge!.list(),
    enabled: !!bridge && enabled,
    staleTime: Infinity,
  });
}

export function useTorrentDetail(id: number | null) {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'detail', id],
    queryFn: () => bridge!.detail(id!),
    enabled: !!bridge && id !== null,
    staleTime: 1000,
    // Peers and trackers move without the list's numbers moving.
    refetchInterval: 2000,
    placeholderData: (previous) => (previous && previous.torrent.id === id ? previous : undefined),
  });
}

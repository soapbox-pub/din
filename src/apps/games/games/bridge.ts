/**
 * The Games app's view of din.system.games: the library and what's being
 * played, kept current by main's `games:changed`.
 */
import { useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import { toast } from '@/shared/toast';
import type { Game, GamesBridge, PlayOptions } from '@/lib/games';

const KEY = ['games'] as const;

export function useBridge(): GamesBridge | undefined {
  return useDin().system.games;
}

/** Main's error, without Electron's wrapping. */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Listen for main's changes: the library refetched, what's running replaced. */
export function useGamesChanges(): void {
  const bridge = useBridge();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      bridge?.onChanged((change) => {
        if (change.kind === 'library') void queryClient.invalidateQueries({ queryKey: [...KEY, 'library'] });
        else {
          queryClient.setQueryData([...KEY, 'status'], (old: Awaited<ReturnType<GamesBridge['status']>> | undefined) =>
            old ? { ...old, running: change.running } : old,
          );
        }
      }),
    [bridge, queryClient],
  );
}

export function useStatus() {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'status'],
    queryFn: () => bridge!.status(),
    enabled: !!bridge,
    staleTime: Infinity,
    // Until they're there: Games may be being installed in Settings.
    refetchInterval: (query) => (query.state.data && !query.state.data.installed ? 3000 : false),
  });
}

export function useLibrary() {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'library'],
    queryFn: () => bridge!.library(),
    enabled: !!bridge,
    staleTime: 30_000,
    // Coming back to the window finds games added since.
    refetchOnWindowFocus: true,
  });
}

/** The moment a game was left at, or null. */
export function useResumeImage(game: Game | null) {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'resume', game?.id, game?.lastPlayed],
    queryFn: () => bridge!.resumeImage(game!.id),
    enabled: !!bridge && !!game?.resumable,
    staleTime: Infinity,
  });
}

/** The things a game can have done to it, each saying so when it fails. */
export function useGameActions() {
  const bridge = useBridge();
  const queryClient = useQueryClient();
  const fail = useCallback((title: string) => (error: unknown) => toast(title, { body: cleanError(error), destructive: true }), []);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...KEY, 'library'] });

  const play = useMutation({
    mutationFn: ({ game, options }: { game: Game; options?: PlayOptions }) => bridge!.play(game.id, options),
    onError: fail('The game couldn’t start'),
  });
  const favorite = useMutation({
    mutationFn: (game: Game) => bridge!.setFavorite(game.id, !game.favorite),
    onMutate: (game) => {
      queryClient.setQueryData([...KEY, 'library'], (old: Awaited<ReturnType<GamesBridge['library']>> | undefined) =>
        old ? { ...old, games: old.games.map((g) => (g.id === game.id ? { ...g, favorite: !game.favorite } : g)) } : old,
      );
    },
    onError: fail('Couldn’t change favorites'),
    onSettled: refresh,
  });
  const setVersion = useMutation({
    mutationFn: ({ game, path }: { game: Game; path: string }) => bridge!.setVersion(game.id, path),
    onError: fail('Couldn’t choose that version'),
    onSettled: refresh,
  });
  const startOver = useMutation({
    mutationFn: (game: Game) => bridge!.forgetResume(game.id),
    onError: fail('Couldn’t start it over'),
    onSettled: refresh,
  });
  const stop = useMutation({
    mutationFn: () => bridge!.stop(),
    onError: fail('The game couldn’t quit'),
  });
  return { play, favorite, setVersion, startOver, stop };
}

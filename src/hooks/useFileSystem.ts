import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFsBridge } from '@/lib/fs';
import type { FsListing, FsReadResult } from '@/lib/fs';

/**
 * TanStack Query hooks over the OS filesystem bridge (window.fs).
 *
 * Listings are cached per path so revisiting a directory is instant, while a
 * short staleTime keeps contents reasonably fresh; the Files app also exposes
 * an explicit refresh (via `refetch`). Write operations invalidate cached
 * listings so every open Files window converges on the new state.
 */

function requireBridge() {
  const fs = getFsBridge();
  if (!fs) throw new Error('Filesystem bridge unavailable');
  return fs;
}

/** The shell user's home directory (undefined while loading / no bridge). */
export function useHomeDir() {
  const fs = getFsBridge();
  return useQuery({
    queryKey: ['fs', 'homedir'],
    queryFn: () => requireBridge().homedir(),
    enabled: fs !== undefined,
    staleTime: Infinity,
  });
}

/** Directory listing for an absolute path. */
export function useDirectory(path: string | null) {
  const fs = getFsBridge();
  return useQuery<FsListing>({
    queryKey: ['fs', 'readdir', path],
    queryFn: () => {
      if (!path) throw new Error('No path');
      return requireBridge().readdir(path);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 5_000,
    retry: false,
  });
}

/** Read (a capped prefix of) a regular file, e.g. for previews. */
export function useFileContent(path: string | null, maxBytes?: number) {
  const fs = getFsBridge();
  return useQuery<FsReadResult>({
    queryKey: ['fs', 'readFile', path, maxBytes ?? null],
    queryFn: () => {
      if (!path) throw new Error('No path');
      return requireBridge().readFile(path, maxBytes);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Write operations on the filesystem. Each mutation invalidates all cached
 * directory listings on success (open windows refetch what they display).
 */
export function useFsMutations() {
  const queryClient = useQueryClient();

  const invalidateListings = () =>
    queryClient.invalidateQueries({ queryKey: ['fs', 'readdir'] });

  const mkdir = useMutation({
    mutationFn: (path: string) => requireBridge().mkdir(path),
    onSuccess: invalidateListings,
  });

  const rename = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      requireBridge().rename(from, to),
    onSuccess: invalidateListings,
  });

  const rm = useMutation({
    mutationFn: ({ path, recursive }: { path: string; recursive?: boolean }) =>
      requireBridge().rm(path, { recursive }),
    onSuccess: invalidateListings,
  });

  return { mkdir, rename, rm };
}

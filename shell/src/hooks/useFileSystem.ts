import { useQuery } from '@tanstack/react-query';
import { getFsBridge } from '@/lib/fs';
import type { FsListing, FsReadResult } from '@/lib/fs';

/**
 * TanStack Query hooks over the read-only OS filesystem bridge.
 *
 * Listings are cached per path so revisiting a directory is instant, while a
 * short staleTime keeps contents reasonably fresh; the Files app also exposes
 * an explicit refresh (via `refetch`).
 */

/** The shell user's home directory (undefined while loading / no bridge). */
export function useHomeDir() {
  const fs = getFsBridge();
  return useQuery({
    queryKey: ['fs', 'home'],
    queryFn: () => {
      if (!fs) throw new Error('Filesystem bridge unavailable');
      return fs.home();
    },
    enabled: fs !== undefined,
    staleTime: Infinity,
  });
}

/** Directory listing for an absolute path. */
export function useDirectory(path: string | null) {
  const fs = getFsBridge();
  return useQuery<FsListing>({
    queryKey: ['fs', 'list', path],
    queryFn: () => {
      if (!fs || !path) throw new Error('Filesystem bridge unavailable');
      return fs.list(path);
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
    queryKey: ['fs', 'read', path, maxBytes ?? null],
    queryFn: () => {
      if (!fs || !path) throw new Error('Filesystem bridge unavailable');
      return fs.readFile(path, maxBytes);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 5_000,
    retry: false,
  });
}

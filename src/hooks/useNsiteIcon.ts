import { useQuery } from '@tanstack/react-query';
import { getNsiteStore } from '@/lib/nsiteStore';
import { ensureNsiteAppInfo } from '@/lib/nsiteAppInfo';

/** How a stored nsite names and draws itself, from its own files. */
export interface NsiteIdentity {
  name: string | null;
  /** A small raster data URL. */
  icon: string | null;
}

/**
 * The name and app icon of an nsite Din has stored (opened or installed),
 * read from the site's own files and kept in the nsite store. Null while
 * unknown, for a site the store doesn't have, and outside the Electron shell.
 */
export function useNsiteIdentity(host: string | null | undefined): NsiteIdentity | null {
  const store = getNsiteStore();
  const { data } = useQuery({
    queryKey: ['nsite-store', 'identity', host],
    enabled: Boolean(store && host),
    staleTime: Infinity,
    queryFn: async (): Promise<NsiteIdentity | null> => {
      if (!store || !host) return null;
      const summary = await store.info(host);
      if (!summary) return null;
      const info = await ensureNsiteAppInfo(store, summary);
      return { name: info?.name ?? summary.title, icon: info?.icon ?? null };
    },
  });
  return data ?? null;
}

/** The app icon of a stored nsite (see useNsiteIdentity). */
export function useNsiteIcon(host: string | null | undefined): string | null {
  return useNsiteIdentity(host)?.icon ?? null;
}

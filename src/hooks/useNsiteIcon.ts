import { useQuery } from '@tanstack/react-query';
import { getNsiteStore } from '@/lib/nsiteStore';
import { ensureNsiteAppInfo } from '@/lib/nsiteAppInfo';

/**
 * The app icon of an nsite Din has stored (opened or installed), read from the
 * site's own files and kept in the nsite store. Null while unknown, for a site
 * the store doesn't have, and outside the Electron shell.
 */
export function useNsiteIcon(host: string | null | undefined): string | null {
  const store = getNsiteStore();
  const { data } = useQuery({
    queryKey: ['nsite-store', 'icon', host],
    enabled: Boolean(store && host),
    staleTime: Infinity,
    queryFn: async () => {
      if (!store || !host) return null;
      const summary = await store.info(host);
      if (!summary) return null;
      const info = await ensureNsiteAppInfo(store, summary);
      return info?.icon ?? null;
    },
  });
  return data ?? null;
}

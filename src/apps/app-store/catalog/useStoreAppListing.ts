import { useQuery } from '@tanstack/react-query';
import { deriveNsiteListing, type NsiteListing } from '@/lib/nsiteAppInfo';
import { blossomFileSource } from '@/lib/nsiteBlossom';
import type { StoreApp } from '@/lib/nsiteCatalog';

/**
 * The screenshots and categories a catalog site's web app manifest declares,
 * read from its files on Blossom for its detail page.
 */
export function useStoreAppListing(app: StoreApp) {
  return useQuery<NsiteListing>({
    queryKey: ['nsite-app-listing', app.event.id],
    queryFn: () => deriveNsiteListing(blossomFileSource(app.event)),
    staleTime: Infinity,
    retry: 1,
  });
}

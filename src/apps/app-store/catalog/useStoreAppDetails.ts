import { useQuery } from '@tanstack/react-query';
import { deriveNsiteAppDetails, type NsiteAppDetails } from '@/lib/nsiteAppInfo';
import { blossomFileSource } from '@/lib/nsiteBlossom';
import type { StoreApp } from '@/lib/nsiteCatalog';
import { cachedDetails } from '@/lib/nsiteCatalogCache';

/**
 * How a catalog site presents itself as an app (name, icon, color, blurb),
 * read from its files on Blossom - the same derivation the launcher uses once
 * it is installed, so the store shows the icon the user will get. A site the
 * catalog has already checked starts from what it found, without a fetch.
 * `enabled` lets a card wait until it is on screen.
 */
export function useStoreAppDetails(app: StoreApp, enabled = true) {
  return useQuery<NsiteAppDetails>({
    queryKey: ['nsite-app-details', app.event.id],
    enabled,
    queryFn: () => deriveNsiteAppDetails(blossomFileSource(app.event), app.event.id),
    initialData: () => cachedDetails(app.event.id),
    staleTime: Infinity,
    retry: 1,
  });
}

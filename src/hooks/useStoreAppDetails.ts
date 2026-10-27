import { useQuery } from '@tanstack/react-query';
import { deriveNsiteAppDetails, type NsiteAppDetails } from '@/lib/nsiteAppInfo';
import { blossomFileSource } from '@/lib/nsiteBlossom';
import type { StoreApp } from '@/lib/nsiteCatalog';

/** The query behind useStoreAppDetails, for reading several apps at once. */
export function storeAppDetailsQuery(app: StoreApp, enabled = true) {
  return {
    queryKey: ['nsite-app-details', app.event.id],
    enabled,
    queryFn: () => deriveNsiteAppDetails(blossomFileSource(app.event), app.event.id),
    staleTime: Infinity,
    retry: 1,
  };
}

/**
 * How a catalog site presents itself as an app (name, icon, color, blurb),
 * read from its files on Blossom - the same derivation the launcher uses once
 * it is installed, so the store shows the icon the user will get. `enabled`
 * lets a card wait until it is on screen.
 */
export function useStoreAppDetails(app: StoreApp, enabled = true) {
  return useQuery<NsiteAppDetails>(storeAppDetailsQuery(app, enabled));
}

/**
 * Whether the store lists a site: it has to be an installable web app by the
 * browsers' standard, with an icon Din could draw. A site whose files can't
 * be read can't be checked, so it isn't listed either.
 */
export function isListedApp(details: NsiteAppDetails | undefined): boolean {
  return Boolean(details?.installable && details.icon);
}

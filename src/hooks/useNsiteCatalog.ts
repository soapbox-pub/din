import { useMemo } from 'react';
import { useNostr } from '@nostrify/react';
import type { NRelay } from '@nostrify/nostrify';
import { useAppContext } from '@/hooks/useAppContext';
import { NSITE_CATALOG_RELAY } from '@/lib/nsiteCatalog';

/**
 * Where the store looks for manifests: the user's read relays, which is where
 * Din resolves a site when it opens, plus the relay nsites are published to.
 */
export function useManifestRelays(): NRelay {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relays = config.relayMetadata.relays;
  return useMemo(() => {
    const urls = new Set(relays.filter((relay) => relay.read).map((relay) => relay.url));
    urls.add(NSITE_CATALOG_RELAY);
    return nostr.group([...urls]);
  }, [nostr, relays]);
}

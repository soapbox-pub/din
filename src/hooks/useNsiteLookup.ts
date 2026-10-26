import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryManifests, useManifestRelays } from '@/hooks/useNsiteCatalog';
import {
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  normalizeNsiteInput,
  parseCanonicalNsiteHost,
  parseNsiteNaddrUrl,
} from '@/lib/nsite';
import type { StoreApp } from '@/lib/nsiteCatalog';

/** The site an address names: an nsite URL, a bare `npub1…`, or an `naddr1…`. */
function parseAddress(input: string): { pubkey: string; dtag: string | null } | null {
  const url = normalizeNsiteInput(input);
  if (!url) return null;
  const canonical = parseCanonicalNsiteHost(new URL(url).hostname.toLowerCase());
  if (canonical) return canonical;
  const naddr = parseNsiteNaddrUrl(url);
  return naddr ? { pubkey: naddr.pubkey, dtag: naddr.dtag } : null;
}

/**
 * Look up the site a pasted address names, so a site that is in nobody's
 * catalog can still be installed from the store's search box. `isAddress` is
 * false for anything that isn't an address, which the search then treats as
 * a name to filter by.
 */
export function useNsiteLookup(input: string) {
  const relays = useManifestRelays();
  const address = useMemo(() => parseAddress(input), [input]);

  const query = useQuery<StoreApp | null>({
    queryKey: ['nostr', 'app-store', 'lookup', address?.pubkey, address?.dtag],
    enabled: address !== null,
    queryFn: async (c) => {
      if (!address) return null;
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const filter = address.dtag
        ? { kinds: [NSITE_NAMED_KIND], authors: [address.pubkey], '#d': [address.dtag], limit: 1 }
        : { kinds: [NSITE_ROOT_KIND], authors: [address.pubkey], limit: 1 };
      const [app] = await queryManifests(relays, [filter], signal);
      return app ?? null;
    },
    staleTime: 60 * 1000,
    retry: 1,
  });

  return { isAddress: address !== null, ...query };
}

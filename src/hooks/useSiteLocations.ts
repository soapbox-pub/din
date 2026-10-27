import { useEffect, useState } from 'react';
import { getSiteLocationsBridge, type SiteLocations } from '@/lib/siteLocations';

const NONE: SiteLocations = { onion: null, nsite: null };

/** The onion service and nsite a browser tab's page names, if any. */
export function useSiteLocations(wcId: number | null): SiteLocations {
  const [state, setState] = useState<{ wcId: number | null; locations: SiteLocations }>({ wcId, locations: NONE });

  useEffect(() => {
    const bridge = getSiteLocationsBridge();
    if (!bridge || wcId === null) return;
    let live = true;
    const unsubscribe = bridge.onChange(({ wcId: id, onion, nsite }) => {
      if (id === wcId) setState({ wcId, locations: { onion, nsite } });
    });
    bridge.get(wcId).then((locations) => {
      if (live) setState({ wcId, locations });
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [wcId]);

  return state.wcId === wcId ? state.locations : NONE;
}

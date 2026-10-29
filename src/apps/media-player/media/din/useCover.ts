import { useEffect, useState } from 'react';
import { coverFor } from '../metadata';

/** A song's cover art (embedded or from its folder), once read. */
export function useCover(location: string | null | undefined): string | null {
  const [cover, setCover] = useState<{ location: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!location) return;
    let live = true;
    void coverFor(location).then((url) => live && setCover({ location, url }));
    return () => {
      live = false;
    };
  }, [location]);
  return cover && cover.location === location ? cover.url : null;
}

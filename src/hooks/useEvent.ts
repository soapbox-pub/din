import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { HEX64 } from '@/lib/draftEvent';

/**
 * One event, by id, for the card that shows an event about to be signed (the
 * note a reaction or reply is about). Deliberately impatient: the prompt reads
 * fine without it, so a relay that hasn't answered in two seconds is skipped.
 */
export function useEvent(id: string | undefined, options?: { enabled?: boolean }) {
  const { nostr } = useNostr();

  const valid = Boolean(id && HEX64.test(id));
  const enabled = (options?.enabled ?? true) && valid;

  return useQuery<NostrEvent | null>({
    enabled,
    queryKey: ['nostr', 'event', id ?? ''],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(2000)]);
      const [event] = await nostr.query([{ ids: [id!], limit: 1 }], { signal });
      return event ?? null;
    },
    staleTime: Infinity,
    retry: false,
  });
}

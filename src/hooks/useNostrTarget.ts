import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import type { NostrUriTarget } from '@/lib/nostrUri';

type NostrClient = ReturnType<typeof useNostr>['nostr'];

/** How long a nostr: link waits for relays before showing what it has. */
const TIMEOUT_MS = 5000;

function filterFor(target: NostrUriTarget): NostrFilter {
  switch (target.type) {
    case 'profile':
      return { kinds: [0], authors: [target.pubkey], limit: 1 };
    case 'event':
      return { ids: [target.id], limit: 1 };
    case 'address':
      return { kinds: [target.kind], authors: [target.pubkey], '#d': [target.identifier], limit: 1 };
  }
}

/** Whether an event is the one a target names (relays don't always filter honestly). */
function matches(event: NostrEvent, target: NostrUriTarget): boolean {
  switch (target.type) {
    case 'profile':
      return event.kind === 0 && event.pubkey === target.pubkey;
    case 'event':
      return event.id === target.id;
    case 'address':
      return (
        event.kind === target.kind &&
        event.pubkey === target.pubkey &&
        (event.tags.find(([name]) => name === 'd')?.[1] ?? '') === target.identifier
      );
  }
}

/**
 * The event a nostr: link names, from the user's relays and the link's own
 * relay hints at once; the newest copy for a replaceable or addressable one.
 */
export async function fetchNostrTarget(
  nostr: NostrClient,
  target: NostrUriTarget,
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  const filter = filterFor(target);
  const sources = [nostr, ...(target.relays.length > 0 ? [nostr.group(target.relays)] : [])];
  const results = await Promise.allSettled(sources.map((source) => source.query([filter], { signal })));
  let newest: NostrEvent | null = null;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value) {
      if (matches(event, target) && (!newest || event.created_at > newest.created_at)) newest = event;
    }
  }
  return newest;
}

/** The event a nostr: link names, or null when no relay has it. */
export function useNostrTarget(target: NostrUriTarget | null) {
  const { nostr } = useNostr();

  return useQuery<NostrEvent | null>({
    enabled: target !== null,
    queryKey: ['nostr', 'uri-target', target],
    queryFn: (c) =>
      fetchNostrTarget(nostr, target!, AbortSignal.any([c.signal, AbortSignal.timeout(TIMEOUT_MS)])),
    staleTime: 60_000,
    retry: false,
  });
}

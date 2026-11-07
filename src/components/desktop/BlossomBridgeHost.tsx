import { useEffect } from 'react';
import { useNostr } from '@nostrify/react';
import { useAppContext } from '@/hooks/useAppContext';
import { getEffectiveBlossomServers, parseBlossomServerList } from '@/lib/appBlossom';
import { getBlossomHostBridge } from '@/lib/blossomBridge';

/** Budget for the relay query. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** BUD-03's user server list. */
const SERVER_LIST_KIND = 10063;

/**
 * Desktop-lifetime fulfiller for blossom: server lookups relayed from the
 * Electron main process (see electron/blossom.mts). When a link's own servers
 * don't have its file, main asks here for its authors' servers (their kind
 * 10063 lists, newest of each, from the user's relays) and the user's own
 * Blossom servers. None of it is trusted for content: main checks every byte
 * it fetches against the link's hash. Renders nothing; does nothing outside
 * the Electron shell.
 */
export function BlossomBridgeHost() {
  const { nostr } = useNostr();
  const { config } = useAppContext();

  const blossomMetadata = config.blossomServerMetadata;
  const useAppBlossomServers = config.useAppBlossomServers;

  useEffect(() => {
    const bridge = getBlossomHostBridge();
    if (!bridge) return;

    async function authorServers(authors: string[], signal: AbortSignal): Promise<string[]> {
      if (authors.length === 0) return [];
      const events = await nostr.query(
        [{ kinds: [SERVER_LIST_KIND], authors, limit: authors.length }],
        { signal },
      );
      // In the link's order of authors, each one's newest list; an event from
      // anyone else is ignored, whatever a relay sends.
      return authors.flatMap((author) => {
        const newest = events
          .filter((event) => event.kind === SERVER_LIST_KIND && event.pubkey === author)
          .sort((a, b) => b.created_at - a.created_at)[0];
        return newest ? parseBlossomServerList(newest) : [];
      });
    }

    return bridge.onRequest((request) => {
      const authors = Array.isArray(request.authors)
        ? request.authors.filter((author) => /^[0-9a-f]{64}$/.test(author)).slice(0, 8)
        : [];
      const servers = getEffectiveBlossomServers(blossomMetadata, useAppBlossomServers);
      void authorServers(authors, AbortSignal.timeout(LOOKUP_TIMEOUT_MS))
        .catch(() => [])
        .then((found) => bridge.respond({ requestId: request.requestId, authorServers: found, servers }));
    });
  }, [nostr, blossomMetadata, useAppBlossomServers]);

  return null;
}

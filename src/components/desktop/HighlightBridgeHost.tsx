import { useEffect } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import {
  getHighlightHostBridge,
  type HighlightBridgeRequest,
} from '@/lib/highlightBridge';

/**
 * Desktop-lifetime fulfiller for NIP-84 highlight requests relayed from the
 * ad-hoc Web Browser's tabs (see electron/browser-highlight-preload.cjs). When
 * the user selects text on a web page and clicks the floating "Highlight"
 * button, the click is proxied through the main process to here; this host
 * publishes a kind 9802 Highlight event with the signed-in account's signer,
 * referencing the page URL (an `r`-tag source, per NIP-84's website form).
 *
 * The source URL, selected text, and surrounding context are supplied by the
 * bridge (the URL read authoritatively from the tab in main, not the page).
 * Renders nothing; does nothing outside the Electron shell.
 */
export function HighlightBridgeHost() {
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const signer = user?.signer;

  useEffect(() => {
    const bridge = getHighlightHostBridge();
    if (!bridge) return;

    async function fulfill(request: HighlightBridgeRequest): Promise<string> {
      if (!signer) throw new Error('No Nostr account is signed in to Din');

      const text = request.text.trim();
      if (!text) throw new Error('Nothing selected to highlight');

      const tags: string[][] = [['r', request.url]];
      if (request.context && request.context.includes(text) && request.context !== text) {
        tags.push(['context', request.context]);
      }
      // NIP-31 alt for clients that don't understand kind 9802.
      tags.push(['alt', 'Highlight']);

      const event = await publishEvent({ kind: 9802, content: text, tags });
      return event.id;
    }

    return bridge.onRequest(async (request) => {
      try {
        const result = await fulfill(request);
        bridge.respond({ requestId: request.requestId, ok: true, result });
      } catch (error) {
        bridge.respond({
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }, [signer, publishEvent]);

  return null;
}

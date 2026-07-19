import { useEffect } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import {
  getNostrHostBridge,
  type NostrBridgeRequest,
} from '@/lib/nostrBridge';

/** A NIP-07 event template as sent by a guest's window.nostr.signEvent. */
interface UnsignedEventInput {
  kind: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}

/**
 * Desktop-lifetime fulfiller for NIP-07 requests relayed from installed web
 * apps (window.nostr - see electron/webview-preload.cjs). Each app <webview>
 * proxies its calls to the main process, which forwards them here; this host
 * answers them with the signed-in account's signer so the app inherits Din's
 * identity.
 *
 * Installing an app is the trust boundary - requests only reach this host from
 * app guests (main verifies the sender), so they are fulfilled without a
 * per-request prompt. Renders nothing; does nothing outside the Electron shell.
 */
export function NostrBridgeHost() {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const signer = user?.signer;
  const relays = config.relayMetadata.relays;

  useEffect(() => {
    const bridge = getNostrHostBridge();
    if (!bridge) return;

    async function fulfill(request: NostrBridgeRequest): Promise<unknown> {
      if (!signer) throw new Error('No Nostr account is signed in to Din');
      const params = (request.params ?? {}) as Record<string, unknown>;

      switch (request.method) {
        case 'getPublicKey':
          return signer.getPublicKey();

        case 'signEvent': {
          const input = params.event as UnsignedEventInput | undefined;
          if (!input || typeof input.kind !== 'number') {
            throw new Error('Invalid event');
          }
          return signer.signEvent({
            kind: input.kind,
            content: input.content ?? '',
            tags: input.tags ?? [],
            created_at: input.created_at ?? Math.floor(Date.now() / 1000),
          });
        }

        case 'getRelays': {
          const map: Record<string, { read: boolean; write: boolean }> = {};
          for (const relay of relays) {
            map[relay.url] = { read: relay.read, write: relay.write };
          }
          return map;
        }

        case 'nip04.encrypt': {
          if (!signer.nip04) throw new Error('This account cannot use NIP-04');
          return signer.nip04.encrypt(params.pubkey as string, params.plaintext as string);
        }
        case 'nip04.decrypt': {
          if (!signer.nip04) throw new Error('This account cannot use NIP-04');
          return signer.nip04.decrypt(params.pubkey as string, params.ciphertext as string);
        }
        case 'nip44.encrypt': {
          if (!signer.nip44) throw new Error('This account cannot use NIP-44');
          return signer.nip44.encrypt(params.pubkey as string, params.plaintext as string);
        }
        case 'nip44.decrypt': {
          if (!signer.nip44) throw new Error('This account cannot use NIP-44');
          return signer.nip44.decrypt(params.pubkey as string, params.ciphertext as string);
        }

        default:
          throw new Error(`Unsupported method: ${request.method}`);
      }
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
  }, [signer, relays]);

  return null;
}

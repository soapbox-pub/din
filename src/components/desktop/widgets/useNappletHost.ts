import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import { fetchAuthor } from '@/hooks/useAuthor';
import { onThemeChange } from '@/components/desktop/dinHost/theme';
import { getWidgetsBridge, grantedDomains, onWidgetPort, portIsFrom, widgetIdentity, type PlacedWidget } from '@/lib/widgets';
import { storageArea, storageGet, storageKeys, storageRemove, storageSet } from '@/lib/widgetStorage';

/** A NIP-5D envelope: `{ type: 'domain.action', … }`. */
type Envelope = { type: string; id?: unknown } & Record<string, unknown>;

/** A CSS color as #rrggbb, by painting it (tokens may be hsl(), oklch(), …). */
function hex(color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#000000';
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The desktop's theme as NAP-THEME has it. */
function nappletTheme() {
  const computed = getComputedStyle(document.documentElement);
  const token = (name: string) => computed.getPropertyValue(`--${name}`).trim();
  return {
    colors: { background: hex(token('background')), text: hex(token('foreground')), primary: hex(token('primary')) },
    title: document.documentElement.classList.contains('dark') ? 'Din Dark' : 'Din Light',
  };
}

/**
 * Answer one widget's guest: the NAP domains it was granted (NAP-SHELL,
 * THEME, IDENTITY, STORAGE and RESOURCE), over the port main hands over each time it
 * loads. Messages for any other domain are dropped, as NIP-5D asks.
 */
export function useNappletHost(webContentsId: number | null, widget: PlacedWidget, onFailed: (reason: string) => void): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const live = useRef({ nostr, queryClient, pubkey: user?.pubkey ?? '', relays: config.relayMetadata.relays, widget, onFailed });
  useEffect(() => {
    live.current = { nostr, queryClient, pubkey: user?.pubkey ?? '', relays: config.relayMetadata.relays, widget, onFailed };
  });

  // Pushes go to whichever port is current.
  const portRef = useRef<MessagePort | null>(null);

  const pubkey = user?.pubkey ?? '';
  const domains = grantedDomains(widget.source, widget.denied);
  const hasIdentity = domains.includes('identity');
  const hasTheme = domains.includes('theme');
  useEffect(() => {
    if (hasIdentity) portRef.current?.postMessage({ message: { type: 'identity.changed', pubkey } });
  }, [hasIdentity, pubkey]);
  useEffect(() => {
    if (!hasTheme) return;
    return onThemeChange(() => portRef.current?.postMessage({ message: { type: 'theme.changed', theme: nappletTheme() } }));
  }, [hasTheme]);

  const sourceKey = JSON.stringify([widget.source, widget.denied ?? []]);
  useEffect(() => {
    if (webContentsId === null) return;
    const source = live.current.widget.source;
    const granted = grantedDomains(source, live.current.widget.denied);
    return onWidgetPort(webContentsId, (entry) => {
      if (!portIsFrom(entry, source)) return;
      portRef.current?.close();
      const port = entry.port;
      portRef.current = port;
      let initialized = false;
      const reply = (message: Envelope) => port.postMessage({ message });

      const handle = async (msg: Envelope) => {
        const domain = msg.type.split('.')[0];
        if (!(granted as string[]).includes(domain)) return;
        const id = typeof msg.id === 'string' ? msg.id : null;
        const { widget: current } = live.current;
        const area = (scope: unknown) =>
          storageArea(widgetIdentity(current.source), scope === 'instance' ? current.id : undefined);
        switch (msg.type) {
          case 'shell.ready':
            if (initialized) return;
            initialized = true;
            reply({ type: 'shell.init', capabilities: { domains: [...granted] }, services: [] });
            return;
          case 'theme.get':
            if (id) reply({ type: 'theme.get.result', id, theme: nappletTheme() });
            return;
          case 'storage.get':
          case 'storage.set':
          case 'storage.remove':
          case 'storage.keys': {
            if (!id) return;
            const result = `${msg.type}.result`;
            const key = typeof msg.key === 'string' ? msg.key : null;
            try {
              if (msg.type === 'storage.keys') {
                reply({ type: result, id, keys: storageKeys(area(msg.scope)) });
              } else if (key === null) {
                reply({ type: result, id, value: null, error: 'key must be a string' });
              } else if (msg.type === 'storage.get') {
                reply({ type: result, id, value: storageGet(area(msg.scope), key) });
              } else if (msg.type === 'storage.set') {
                if (typeof msg.value !== 'string') throw new Error('value must be a string');
                storageSet(area(msg.scope), key, msg.value);
                reply({ type: result, id });
              } else {
                storageRemove(area(msg.scope), key);
                reply({ type: result, id });
              }
            } catch (error) {
              reply({ type: result, id, error: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
          case 'resource.bytes': {
            if (!id) return;
            const bridge = getWidgetsBridge();
            if (typeof msg.url !== 'string' || !bridge) {
              reply({ type: 'resource.bytes.error', id, error: 'unavailable' });
              return;
            }
            try {
              const { bytes, type } = await bridge.resource(msg.url);
              reply({ type: 'resource.bytes.result', id, blob: new Blob([bytes as BlobPart], { type }) });
            } catch (error) {
              const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
              reply({ type: 'resource.bytes.error', id, error: 'failed', message });
            }
            return;
          }
          case 'resource.info':
          case 'resource.bytesMany':
            if (id) reply({ type: `${msg.type}.error`, id, error: 'unsupported' });
            return;
          default:
            if (domain === 'identity' && id) reply(await identity(msg.type, id));
        }
      };

      const identity = async (type: string, id: string): Promise<Envelope> => {
        const { pubkey: me, relays, nostr: pool, queryClient: client } = live.current;
        const result = `${type}.result`;
        if (type === 'identity.getPublicKey') return { type: result, id, pubkey: me };
        if (!me) return { type: result, id, error: 'not signed in' };
        try {
          switch (type) {
            case 'identity.getRelays':
              return { type: result, id, relays: Object.fromEntries(relays.map((r) => [r.url, { read: r.read, write: r.write }])) };
            case 'identity.getProfile': {
              const { metadata } = await client.fetchQuery({
                queryKey: ['nostr', 'author', me],
                queryFn: () => fetchAuthor(pool, me),
                staleTime: 5 * 60 * 1000,
              });
              const profile = metadata
                ? {
                  name: metadata.name,
                  displayName: metadata.display_name,
                  about: metadata.about,
                  picture: metadata.picture,
                  banner: metadata.banner,
                  nip05: metadata.nip05,
                  lud16: metadata.lud16,
                  website: metadata.website,
                }
                : null;
              return { type: result, id, profile };
            }
            case 'identity.getFollows': {
              const pubkeys = await client.fetchQuery({
                queryKey: ['following', me],
                staleTime: 5 * 60 * 1000,
                queryFn: async () => {
                  const [event] = await pool.query([{ kinds: [3], authors: [me], limit: 1 }], { signal: AbortSignal.timeout(5000) });
                  return (event?.tags ?? []).filter(([name, value]) => name === 'p' && typeof value === 'string').map(([, value]) => value);
                },
              });
              return { type: result, id, pubkeys };
            }
            default:
              return { type: result, id, error: 'not supported' };
          }
        } catch {
          return { type: result, id, error: 'not found' };
        }
      };

      port.onmessage = (e: MessageEvent) => {
        const data = e.data as { message?: unknown; failed?: unknown } | null;
        if (typeof data?.failed === 'string') {
          live.current.onFailed(data.failed);
          return;
        }
        const msg = data?.message;
        if (typeof msg !== 'object' || msg === null || typeof (msg as Envelope).type !== 'string') return;
        void handle(msg as Envelope);
      };
      port.postMessage({ init: { domains: granted } });
    });
    // The source is fixed for a frame (read from `live`): a different one is a different guest.
  }, [webContentsId, sourceKey]);

  useEffect(() => () => portRef.current?.close(), []);
}

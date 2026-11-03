import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NSecSigner } from '@nostrify/nostrify';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { TestApp } from '@/test/TestApp';
import { WindowActionsContext } from '@/contexts/WindowManagerContext';
import { WorkAreasContext } from '@/contexts/MonitorsContext';
import { appUrl } from '@/lib/dinApps';
import type { WindowActions } from '@/hooks/useWindows';
import type { DinManifest } from '@/sdk/din';
import { DinAppFrame } from './DinAppFrame';
import { NostrBridgeHost } from './NostrBridgeHost';

/**
 * The `nostr` permission is offered as "Sign, encrypt and decrypt as you (Din
 * asks each time)" (src/lib/launchedApps.ts). An app holding it, from a
 * folder or the `din` command, must not get anything signed or decrypted
 * before the user says so on screen: Din's signer prompt (NostrBridgeHost),
 * as web pages get.
 */

const state = vi.hoisted(() => ({ current: { user: undefined as unknown, users: [] as unknown[] } }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.current }));
vi.mock('@/hooks/useSiteIdentity', () => ({ useSiteIdentity: () => ({ name: 'Cool App', nsite: false }) }));
vi.mock('@/components/NostrProvider', async () => {
  const { NostrContext } = await import('@nostrify/react');
  const nostr = { query: async () => [], event: async () => {} };
  return {
    default: ({ children }: { children: React.ReactNode }) => (
      <NostrContext.Provider value={{ nostr } as never}>{children}</NostrContext.Provider>
    ),
  };
});
vi.mock('@/hooks/useOpenUrl', () => {
  const openUrl = () => {};
  return { useOpenUrl: () => openUrl };
});

const APP_ID = 'cool-app';
const manifest = {
  name: 'Cool App',
  start_url: '/',
  icons: [],
  din: { permissions: ['nostr'] },
} as unknown as DinManifest;

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const signer = new NSecSigner(sk);

const friendSk = generateSecretKey();
const friend = new NSecSigner(friendSk);

let port: MessagePort | null = null;

beforeEach(() => {
  vi.spyOn(signer, 'signEvent');
  state.current = { user: { method: 'nsec', pubkey, signer }, users: [] };
  state.current.users = [state.current.user];
});

afterEach(() => {
  port?.close();
  port = null;
  vi.restoreAllMocks();
});

/** Open the app's window and connect to it the way a framed app does (src/sdk/frame.ts). */
async function openApp(): Promise<{ request: (method: string, params: unknown) => void; replies: Map<number, { result?: unknown; error?: unknown }> }> {
  const { container } = render(
    <TestApp>
      <WindowActionsContext.Provider value={{ open: vi.fn() } as unknown as WindowActions}>
        <WorkAreasContext.Provider value={[]}>
          <NostrBridgeHost />
          <DinAppFrame appId={APP_ID} manifest={manifest} windowId="w1" />
        </WorkAreasContext.Provider>
      </WindowActionsContext.Provider>
    </TestApp>,
  );
  // Say hello until the desktop answers: its listener and the frame it
  // checks against may not be there on the first try.
  const spied = new WeakSet<Window>();
  let handed: MessagePort | null = null;
  port = await vi.waitFor(() => {
    const frameWindow = container.querySelector('iframe')?.contentWindow;
    if (!frameWindow) throw new Error('no frame yet');
    if (!spied.has(frameWindow)) {
      spied.add(frameWindow);
      vi.spyOn(frameWindow, 'postMessage').mockImplementation(((_message: unknown, _origin: string, transfer?: Transferable[]) => {
        handed = transfer![0] as MessagePort;
      }) as typeof frameWindow.postMessage);
    }
    if (!handed) {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'din:hello' },
        origin: new URL(appUrl(APP_ID, manifest)).origin,
        source: frameWindow,
      }));
    }
    if (!handed) throw new Error('no port yet');
    return handed;
  }, { timeout: 10_000 });

  const replies = new Map<number, { result?: unknown; error?: unknown }>();
  port.onmessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; id?: number; result?: unknown; error?: unknown };
    if (data?.type === 'reply' && typeof data.id === 'number') replies.set(data.id, data);
  };
  let nextId = 1;
  return {
    request: (method, params) => port!.postMessage({ type: 'request', id: nextId++, method, params }),
    replies,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

// The first render loads DinAppFrame's whole graph, slow beside the rest of the suite.
describe('an app with the nostr permission', { timeout: 20_000 }, () => {
  it('gets an event signed only once the user allows it', async () => {
    const app = await openApp();
    app.request('nostr.signEvent', {
      event: { kind: 0, content: '{"name":"pwned"}', tags: [], created_at: Math.floor(Date.now() / 1000) },
    });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await settle();
    expect(app.replies.get(1)).toBeUndefined();
    expect(signer.signEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(app.replies.get(1)).toBeDefined());
    expect((app.replies.get(1)!.result as { pubkey: string }).pubkey).toBe(pubkey);
  });

  it("doesn't get a message decrypted when the user says no", async () => {
    const dm = await friend.nip44!.encrypt(pubkey, 'meet me at the usual place');
    const app = await openApp();
    app.request('nostr.decrypt', { version: 'nip44', pubkey: getPublicKey(friendSk), text: dm });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await settle();
    expect(app.replies.get(1)).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Don’t allow' }));
    await waitFor(() => expect(app.replies.get(1)).toBeDefined());
    expect(app.replies.get(1)!.result).toBeUndefined();
    expect(app.replies.get(1)!.error).toBeDefined();
  });
});

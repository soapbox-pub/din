import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { render, waitFor } from '@testing-library/react';
import { NSecSigner, type NostrEvent } from '@nostrify/nostrify';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { TestApp } from '@/test/TestApp';
import { WindowActionsContext } from '@/contexts/WindowManagerContext';
import type { WindowActions } from '@/hooks/useWindows';
import { useSignerGrants } from '@/hooks/useSignerGrants';
import { APP_DATA_KIND, appDataCacheKey, appDataDTag, serializeAppData } from '@/lib/appData';
import { decide, SIGNER_GRANTS_KEY, type SignerGrants } from '@/lib/signerPermissions';
import type { NostrBridgeRequest, NostrBridgeResponse, NostrHostBridge } from '@/lib/nostrBridge';
import { NostrBridgeHost } from './NostrBridgeHost';

/**
 * Which sites may use the signer is itself a kind 30078 record
 * (computer.din.signer-permissions), signed by the user and encrypted to
 * them. A site the user lets sign kind 30078 and encrypt (its own settings,
 * say) must not be able to write that record, and a record dated in the
 * future must not outlive the user taking a site's access away.
 */

const state = vi.hoisted(() => ({
  current: { user: undefined as unknown, users: [] as unknown[] },
  /** The relays: the newest copy of each addressable event, as relays keep. */
  events: [] as NostrEvent[],
  nostr: null as unknown as { query: (...args: never[]) => Promise<NostrEvent[]>; event: (event: NostrEvent) => Promise<void> },
}));

vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.current }));

vi.mock('@/components/NostrProvider', async () => {
  const { NostrContext } = await import('@nostrify/react');
  const { matchFilters } = await import('nostr-tools');
  const dOf = (e: NostrEvent) => e.tags.find(([n]) => n === 'd')?.[1] ?? '';
  const nostr = state.nostr = {
    query: async (filters: Parameters<typeof matchFilters>[0]) =>
      state.events.filter((e) => matchFilters(filters, e)).sort((a, b) => b.created_at - a.created_at),
    event: async (event: NostrEvent) => {
      const same = (e: NostrEvent) => e.kind === event.kind && e.pubkey === event.pubkey && dOf(e) === dOf(event);
      const held = state.events.find(same);
      if (held && held.created_at >= event.created_at) return;
      state.events = [...state.events.filter((e) => !same(e)), event];
    },
  };
  return {
    default: ({ children }: { children: React.ReactNode }) => (
      <NostrContext.Provider value={{ nostr } as never}>{children}</NostrContext.Provider>
    ),
  };
});

const EVIL = 'https://notes.example';
const YEAR_2100 = 4102444800;
const GRANTS_D = appDataDTag(SIGNER_GRANTS_KEY);

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const signer = new NSecSigner(sk);

/** What the site says it may do: everything that matters, unasked. */
const FORGED: SignerGrants = {
  [EVIL]: {
    status: 'connected',
    name: 'Notes',
    methods: { 'nip04.decrypt': 'allow', 'nip44.decrypt': 'allow', 'nip44.encrypt': 'allow' },
    kinds: { '0': 'allow', '3': 'allow', '5': 'allow', '30078': 'allow' },
    createdAt: 0,
    lastUsed: Date.now(),
  },
};

/** A grants record signed by the user, dated 2100. */
async function forgedRecord(): Promise<NostrEvent> {
  return signer.signEvent({
    kind: APP_DATA_KIND,
    content: await signer.nip44.encrypt(pubkey, serializeAppData(FORGED)),
    tags: [['d', GRANTS_D]],
    created_at: YEAR_2100,
  });
}

let requests: ((request: NostrBridgeRequest) => void) | null = null;
const responses = new Map<number, NostrBridgeResponse>();
const bridge: NostrHostBridge = {
  onRequest: (cb) => {
    requests = cb;
    return () => {};
  },
  onCancel: () => () => {},
  onPageChanged: () => () => {},
  respond: (response) => responses.set(response.requestId, response),
  accountChanged: () => {},
};

let probe: ReturnType<typeof useSignerGrants> | null = null;
function GrantsProbe() {
  const grants = useSignerGrants();
  useEffect(() => {
    probe = grants;
  });
  return null;
}

/** Din starting up: the desktop's signer host, and the grants as Settings reads them. */
function startDin() {
  return render(
    <TestApp>
      <WindowActionsContext.Provider value={{ open: vi.fn() } as unknown as WindowActions}>
        <NostrBridgeHost />
        <GrantsProbe />
      </WindowActionsContext.Provider>
    </TestApp>,
  );
}

let nextRequestId = 1;
/** window.nostr in the site's tab, as main relays it. */
async function fromSite(method: string, params: unknown): Promise<NostrBridgeResponse> {
  const requestId = nextRequestId++;
  await waitFor(() => expect(requests).not.toBeNull());
  requests!({ requestId, method, params, origin: EVIL, source: 'tab', wcId: 3, userActivated: true });
  return waitFor(() => {
    const response = responses.get(requestId);
    if (!response) throw new Error('no answer yet');
    return response;
  });
}

beforeEach(() => {
  localStorage.clear();
  state.events = [];
  requests = null;
  probe = null;
  responses.clear();
  state.current = { user: { method: 'nsec', pubkey, signer }, users: [] };
  state.current.users = [state.current.user];
  (window as unknown as { dinos?: unknown }).dinos = { nostrHost: bridge };
});

afterEach(() => {
  delete (window as unknown as { dinos?: unknown }).dinos;
});

describe("the signer's permissions record", () => {
  beforeEach(() => {
    // The user once let the site keep its settings: "Always allow" for
    // signing kind 30078 and for encrypting.
    const allowed: SignerGrants = {
      [EVIL]: {
        status: 'connected',
        name: 'Notes',
        methods: { 'nip44.encrypt': 'allow' },
        kinds: { '30078': 'allow' },
        createdAt: Date.now(),
        lastUsed: Date.now(),
      },
    };
    localStorage.setItem(
      appDataCacheKey(pubkey, SIGNER_GRANTS_KEY),
      JSON.stringify({ value: allowed, updatedAt: Math.floor(Date.now() / 1000) }),
    );
  });

  it("isn't signed for a site", async () => {
    startDin();
    const ciphertext = await fromSite('nip44.encrypt', { pubkey, plaintext: serializeAppData(FORGED) });
    expect(ciphertext.ok).toBe(true);

    const signed = await fromSite('signEvent', {
      event: { kind: APP_DATA_KIND, content: ciphertext.result, tags: [['d', GRANTS_D]], created_at: Math.floor(Date.now() / 1000) },
    });
    expect(signed.ok).toBe(false);
  });

  it("still signs the site's own settings", async () => {
    startDin();
    const signed = await fromSite('signEvent', {
      event: { kind: APP_DATA_KIND, content: 'settings', tags: [['d', 'notes.example/settings']], created_at: Math.floor(Date.now() / 1000) },
    });
    expect(signed.ok).toBe(true);
  });

  it("isn't signed for a site dated in the future either", async () => {
    startDin();
    const signed = await fromSite('signEvent', {
      event: { kind: APP_DATA_KIND, content: 'settings', tags: [['d', 'notes.example/settings']], created_at: YEAR_2100 },
    });
    expect(signed.ok).toBe(false);
  });

  it("isn't believed when it's dated in the future", async () => {
    // However it got signed, a grants record dated 2100 is on the relays.
    state.events = [await forgedRecord()];
    const query = vi.spyOn(state.nostr, 'query');

    startDin();
    await waitFor(() => expect(query).toHaveBeenCalled());
    await waitFor(() => expect(probe!.grants[EVIL]?.methods['nip44.decrypt']).toBeDefined(), { timeout: 1000 }).catch(() => {});
    expect(decide(probe!.grants[EVIL], 'nip44.decrypt')).toBe('ask');
  });

  it("isn't kept when this device took it before Din refused those", async () => {
    localStorage.setItem(
      appDataCacheKey(pubkey, SIGNER_GRANTS_KEY),
      JSON.stringify({ value: FORGED, updatedAt: YEAR_2100 }),
    );
    startDin();
    await waitFor(() => expect(probe).not.toBeNull());
    expect(decide(probe!.grants[EVIL], 'nip44.decrypt')).toBe('ask');
  });
});

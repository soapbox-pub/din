import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NPool, NRelay1 } from '@nostrify/nostrify';
import { NostrContext } from '@nostrify/react';
import type { StoreState } from '@/sdk/din';
import { dinStore, FALLBACK_RELAYS, StoreStateContext } from './store';

/** The relays the window's pool asks now: the ones the desktop named last. */
let routed: string[] = FALLBACK_RELAYS;

/** One pool for the window, routed to whichever relays the desktop names now. */
function makePool(): NPool {
  return new NPool({
    open: (url) => new NRelay1(url),
    reqRouter: (filters) => new Map(routed.map((url) => [url, filters])),
    // The store publishes nothing itself: the desktop does, for what the user asks.
    eventRouter: () => [],
    eoseTimeout: 400,
  });
}

/** What the desktop says (useStoreState), and the store's own relay pool (useNostr). */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState | null>(null);
  useEffect(() => {
    let live = true;
    let pushed = false;
    // The pool's routes change before anything renders with the new relays.
    const take = (next: StoreState) => {
      if (next.relays.length) routed = next.relays;
      setState(next);
    };
    const off = dinStore().onChange((next) => {
      pushed = true;
      if (live) take(next);
    });
    // What's pushed meanwhile is newer than the answer.
    void dinStore().state().then((next) => {
      if (live && !pushed) take(next);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const [pool] = useState(makePool);
  useEffect(() => () => void pool.close(), [pool]);
  const nostr = useMemo(() => ({ nostr: pool }), [pool]);

  return (
    <StoreStateContext.Provider value={state}>
      <NostrContext.Provider value={nostr}>{children}</NostrContext.Provider>
    </StoreStateContext.Provider>
  );
}


import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/hooks/useAppContext';
import { useNativeApps } from '@/hooks/useNativeApps';
import { toast } from '@/hooks/useToast';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useMonitors } from '@/contexts/MonitorsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { getBootBridge } from '@/lib/boot';
import { launchNativeApp } from '@/lib/nativeApps';
import {
  claimSessionStart,
  clearSession,
  expectNativeWindows,
  holdSkippedSession,
  markRestored,
  readSession,
  reopenSkippedSession,
  restoreInterrupted,
  setRestoring,
  setSessionReopener,
  snapshotSession,
  subscribeWindowStates,
  writeSession,
  type LiveSession,
  type SavedSession,
  type SavedWindow,
} from '@/lib/windowSession';

/** How long after the last change the session is saved. */
const SAVE_DELAY_MS = 300;
/** How long saved windows wait for their app to be listed (native apps and nsites come in late). */
const RESTORE_DEADLINE_MS = 30_000;
/**
 * How long a native app gets to announce windows it still has open (the
 * desktop reloaded without Din restarting) before it's started again.
 */
const NATIVE_GRACE_MS = 3_000;
/**
 * How long Din runs after a restore before the restore counts as done (see
 * setRestoring): long enough to catch a window that brings Din down a
 * while after it opens, not just at once.
 */
const SETTLED_MS = 2 * 60_000;
/** How long "Reopening your windows" waits for "Start without them". */
const PROMPT_MS = 2_500;

/** Private browser windows leave nothing behind. */
const keep = (w: LiveSession['windows'][number]) => !(w.appId === 'web-browser' && w.params?.private === true);

/** Saved windows still waiting for their app. */
interface Pending {
  windows: SavedWindow[];
  /** The tiling trees and workspaces, for the first windows that come back. */
  trees: SavedSession['trees'] | null;
  active: SavedSession['active'] | null;
  until: number;
}

/**
 * Keeps the windows open on file (src/lib/windowSession.ts) and reopens
 * them when Din starts, once the monitors are known: built-in apps and web
 * apps as their apps are listed, native apps by starting them again.
 */
export function WindowSessionHost() {
  const { windows, active, actions } = useWindowManager();
  const { getApp } = useInstalledApps();
  const { available: nativeAvailable } = useNativeApps();
  const { ready: monitorsReady } = useMonitors();
  const { config } = useAppContext();
  const enabled = config.restoreWindows;

  const live = useRef({ getApp, nativeAvailable, actions, enabled });
  useLayoutEffect(() => {
    live.current = { getApp, nativeAvailable, actions, enabled };
  });
  /** Whether saving has begun: not before the saved session is read (or while it's offered). */
  const begun = useRef(false);
  /** The session about to be reopened, while "Start without them" is offered. */
  const [offered, setOffered] = useState<SavedSession | null>(null);
  const offeredRef = useRef<SavedSession | null>(null);
  const pending = useRef<Pending | null>(null);

  const save = useCallback(() => {
    const { actions, getApp, enabled } = live.current;
    if (!begun.current || !enabled) return;
    const session = snapshotSession(actions.getSession(), (id) => getApp(id)?.native === true, keep);
    // Windows still to come back stay on file, in case Din stops first.
    for (const w of pending.current?.windows ?? []) session.windows.push({ ...w, id: `pending:${w.id}` });
    writeSession(session);
  }, []);

  /** Reopen what has an app to open it by now; the rest wait. */
  const advance = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    const { getApp, nativeAvailable, actions } = live.current;
    const ready: SavedWindow[] = [];
    const later: SavedWindow[] = [];
    const natives = new Map<string, SavedWindow[]>();
    for (const w of p.windows) {
      const app = getApp(w.appId);
      if (!app || (w.native && !nativeAvailable)) later.push(w);
      else if (w.native) natives.set(w.appId, [...(natives.get(w.appId) ?? []), w]);
      else ready.push(w);
    }
    if (ready.length > 0) {
      const ids = actions.adoptSession(ready, p.trees ?? {}, p.active ?? {});
      for (const w of ready) markRestored(ids.get(w.id)!, w.state);
      p.trees = null;
      p.active = null;
    }
    for (const [appId, list] of natives) {
      expectNativeWindows(appId, list);
      setTimeout(() => {
        const running = live.current.actions
          .getSession()
          .windows.some((w) => w.appId === appId && typeof w.params?.xid === 'number');
        const app = live.current.getApp(appId);
        if (!running && app) launchNativeApp(app);
      }, NATIVE_GRACE_MS);
    }
    p.windows = Date.now() < p.until ? later : [];
    if (p.windows.length === 0) pending.current = null;
  }, []);

  const restore = useCallback((session: SavedSession) => {
    setRestoring(true);
    setTimeout(() => setRestoring(false), SETTLED_MS);
    pending.current = {
      windows: session.windows,
      trees: session.trees,
      active: session.active,
      until: Date.now() + RESTORE_DEADLINE_MS,
    };
    advance();
    // Whatever's still waiting then is given up on.
    setTimeout(() => {
      advance();
      save();
    }, RESTORE_DEADLINE_MS + 100);
  }, [advance, save]);

  useEffect(() => {
    setSessionReopener(restore);
    return () => setSessionReopener(null);
  }, [restore]);

  /** Leave a session closed this start, ready to reopen from a notification or `din windows reopen`. */
  const skip = useCallback((session: SavedSession, description: string) => {
    begun.current = true;
    setRestoring(false);
    holdSkippedSession(session);
    toast({
      title: 'Your windows stayed closed',
      description,
      actions: [{ id: 'reopen', label: 'Reopen windows' }],
      onAction: () => void reopenSkippedSession(),
    });
  }, []);

  // Once the monitors are known, so windows land on the monitors they were on.
  useEffect(() => {
    if (!monitorsReady || !claimSessionStart()) return;
    if (!live.current.enabled) {
      begun.current = true;
      return;
    }
    const session = readSession();
    if (!session || session.windows.length === 0) {
      begun.current = true;
      return;
    }
    if (restoreInterrupted()) {
      skip(session, 'Din stopped while reopening them, twice, so it started without them.');
      return;
    }
    // `touch ~/.config/din/skip-restore` from a text console, or ?norestore in a browser.
    const asked = new URLSearchParams(location.search).has('norestore');
    void (asked ? Promise.resolve(true) : (getBootBridge()?.skipRestore() ?? Promise.resolve(false)))
      .catch(() => false)
      .then((skipped) => {
        if (skipped) return skip(session, 'You asked Din to start without them.');
        offeredRef.current = session;
        setOffered(session);
      });
  }, [monitorsReady, skip]);

  /** "Reopen now", or the prompt running out. */
  const accept = useCallback(() => {
    const session = offeredRef.current;
    offeredRef.current = null;
    setOffered(null);
    if (!session) return;
    begun.current = true;
    restore(session);
  }, [restore]);
  const decline = useCallback(() => {
    const session = offeredRef.current;
    offeredRef.current = null;
    setOffered(null);
    if (session) skip(session, 'Reopen them when you’re ready.');
  }, [skip]);

  useEffect(() => {
    if (!offered) return;
    const timer = setTimeout(accept, PROMPT_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') decline();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [offered, accept, decline]);

  // Apps listed since (native apps, nsites, folders) bring their windows back.
  useEffect(advance, [getApp, nativeAvailable, advance]);

  // Turned off, the saved windows are forgotten (and saving stops until it's on again).
  useEffect(() => {
    if (!enabled) clearSession();
  }, [enabled]);

  // A moment after every change, and when a window's app saves its state.
  useEffect(() => {
    const timer = setTimeout(save, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [windows, active, enabled, save]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWindowStates(() => {
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [save]);
  // Din told it's going: whatever's left unsaved.
  useEffect(() => {
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [save]);

  if (!offered) return null;
  return (
    <div
      role="status"
      className="fixed bottom-24 left-1/2 z-[10002] flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-background/90 py-2 pl-4 pr-2 text-sm text-foreground shadow-lg backdrop-blur motion-safe:animate-in motion-safe:fade-in"
    >
      <span>Reopening your windows…</span>
      <Button size="sm" variant="secondary" onClick={decline}>
        Start without them
      </Button>
      <Button size="sm" variant="ghost" onClick={accept}>
        Reopen now
      </Button>
    </div>
  );
}

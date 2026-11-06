import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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
/**
 * The longest a change waits to be saved, however often more come (a
 * browser window's tabs loading keep changing their titles, a drag the
 * window's place): waiting for a quiet moment alone could wait for minutes.
 */
const SAVE_MAX_WAIT_MS = 2_000;
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
  /** Whether saving has begun: not before the saved session is read. */
  const begun = useRef(false);
  const pending = useRef<Pending | null>(null);

  const save = useCallback(() => {
    const { actions, getApp, enabled } = live.current;
    if (!begun.current || !enabled) return;
    const session = snapshotSession(actions.getSession(), (id) => getApp(id)?.native === true, keep);
    // Windows still to come back stay on file, in case Din stops first.
    for (const w of pending.current?.windows ?? []) session.windows.push({ ...w, id: `pending:${w.id}` });
    // On the disk now: Chromium would otherwise keep it in memory a while.
    if (writeSession(session)) getBootBridge()?.flushStorage();
  }, []);

  /** Save a moment after the last change, or SAVE_MAX_WAIT_MS after the first one waiting. */
  const saveTimer = useRef<{ timer: ReturnType<typeof setTimeout>; since: number } | null>(null);
  const saveSoon = useCallback(() => {
    const since = saveTimer.current?.since ?? Date.now();
    if (saveTimer.current) clearTimeout(saveTimer.current.timer);
    const delay = Math.min(SAVE_DELAY_MS, Math.max(0, since + SAVE_MAX_WAIT_MS - Date.now()));
    saveTimer.current = {
      since,
      timer: setTimeout(() => {
        saveTimer.current = null;
        save();
      }, delay),
    };
  }, [save]);
  /** Save now, whatever was waiting. */
  const saveNow = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current.timer);
    saveTimer.current = null;
    save();
  }, [save]);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current.timer);
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
        begun.current = true;
        restore(session);
      });
  }, [monitorsReady, restore, skip]);

  // Apps listed since (native apps, nsites, folders) bring their windows back.
  useEffect(advance, [getApp, nativeAvailable, advance]);

  // Turned off, the saved windows are forgotten (and saving stops until it's on again).
  useEffect(() => {
    if (!enabled) clearSession();
  }, [enabled]);

  // A moment after every change, and when a window's app saves its state.
  useEffect(saveSoon, [windows, active, enabled, saveSoon]);
  useEffect(() => subscribeWindowStates(saveSoon), [saveSoon]);
  // Din told it's going (about to be restarted or turned off, or the page
  // unloading): whatever's left unsaved.
  useEffect(() => getBootBridge()?.onSaveNow(saveNow), [saveNow]);
  useEffect(() => {
    window.addEventListener('pagehide', saveNow);
    return () => window.removeEventListener('pagehide', saveNow);
  }, [saveNow]);

  return null;
}

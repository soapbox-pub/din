import { useCallback, useEffect, useRef, useState } from 'react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import { setWindowSwitcherActive } from '@/lib/windowSwitcherState';
import { cn } from '@/lib/utils';
import type { WindowState } from '@/hooks/useWindows';

/**
 * How long, after the last guest-forwarded cycle, to auto-commit the
 * selection if Alt's release never arrives. Keyboard focus inside an Electron
 * <webview> reaches us only as bridge events (see shellShortcuts); the main
 * process forwards Alt's keyup as `alt-released`, which commits at once, and
 * this timer only recovers a keyup that went missing.
 */
const BRIDGE_COMMIT_DELAY = 3000;

/** An active Alt+Tab switching gesture. */
interface SwitchSession {
  /** Candidate window ids, snapshot in most-recently-used (top-first) order. */
  ids: string[];
  /** Index into `ids` of the highlighted window. */
  index: number;
  /**
   * How the gesture is being driven, which decides how it ends:
   *  - `held`: opened from a shell-DOM Alt+Tab, so we hold the overlay open
   *    while Alt is down and commit on its keyup.
   *  - `bridge`: opened from a guest-forwarded cycle (focus was inside a
   *    <webview>), where no keyup is observable, so an idle timer commits.
   */
  mode: 'held' | 'bridge';
}

/**
 * The Alt+Tab window switcher: a held-modifier overlay that previews every
 * open window and raises the one selected when the gesture ends.
 *
 * Alt+Tab (or a guest-forwarded cycle) opens a centered strip of window
 * tiles in most-recently-used order with the *previous* window preselected -
 * so a quick tap-and-release flips between the two front windows, while
 * holding Alt and tapping Tab (or the arrow keys) walks the whole stack.
 * Releasing Alt commits; Escape or a backdrop click cancels; clicking a tile
 * jumps straight to it. Unlike a bare focus-cycle, z-order isn't disturbed
 * until the gesture commits, so aborting leaves the stack exactly as it was.
 *
 * Two input paths feed the same session, mirroring DesktopHotkeys: a
 * capture-phase keydown/keyup listener for keys pressed in the shell DOM, and
 * the shell-shortcut bridge for Alt+Tab pressed inside an Electron <webview>
 * guest (where keydown never reaches the shell). The guest path can't see Alt
 * release, so it auto-commits on an idle timer.
 */
export function WindowSwitcher() {
  const { windows, actions } = useWindowManager();
  const { getApp } = useInstalledApps();
  const [session, setSession] = useState<SwitchSession | null>(null);

  // The listeners are bound once and read live state through refs, so they
  // never need to re-bind (and never go stale) as windows change.
  const windowsRef = useRef<WindowState[]>(windows);
  const actionsRef = useRef(actions);
  const sessionRef = useRef<SwitchSession | null>(session);
  const bridgeTimer = useRef(0);
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  /** Commit the session state and mirror it into the sync-read flag/ref. */
  const commitState = useCallback((next: SwitchSession | null) => {
    sessionRef.current = next;
    setWindowSwitcherActive(next !== null);
    setSession(next);
  }, []);

  /**
   * Open the switcher, or advance the selection if it's already open.
   * Opening preselects the previous window (index 1 forward), so a quick
   * tap-and-release performs the classic flip to the last-used window.
   */
  const step = useCallback(
    (backward: boolean, mode: 'held' | 'bridge') => {
      const prev = sessionRef.current;
      if (prev) {
        const n = prev.ids.length;
        if (n === 0) return;
        const index = (prev.index + (backward ? -1 : 1) + n) % n;
        commitState({ ...prev, index });
        return;
      }
      const ids = [...windowsRef.current]
        .filter((w) => !w.closing)
        .sort((a, b) => b.z - a.z)
        .map((w) => w.id);
      // Nothing to switch between.
      if (ids.length < 2) return;
      commitState({ ids, index: backward ? ids.length - 1 : 1, mode });
    },
    [commitState],
  );

  /** End the gesture, raising the highlighted window. */
  const commit = useCallback(() => {
    window.clearTimeout(bridgeTimer.current);
    const current = sessionRef.current;
    const id = current?.ids[current.index];
    if (id) actionsRef.current.focus(id);
    commitState(null);
  }, [commitState]);

  /** Abort the gesture, leaving focus and stacking untouched. */
  const cancel = useCallback(() => {
    window.clearTimeout(bridgeTimer.current);
    commitState(null);
  }, [commitState]);

  /** Point the selection at a specific window id (pointer hover/click). */
  const select = useCallback(
    (id: string) => {
      window.clearTimeout(bridgeTimer.current);
      const current = sessionRef.current;
      if (!current) return;
      const index = current.ids.indexOf(id);
      if (index >= 0) commitState({ ...current, index });
    },
    [commitState],
  );

  /** Jump straight to a window and end the gesture (pointer click). */
  const choose = useCallback(
    (id: string) => {
      window.clearTimeout(bridgeTimer.current);
      actionsRef.current.focus(id);
      commitState(null);
    },
    [commitState],
  );

  // Shell-DOM keyboard: opening/advancing and ending the gesture.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        step(e.shiftKey, 'held');
        return;
      }
      // While the overlay is open, own the navigation/commit keys so neither
      // app content nor DesktopHotkeys (Alt+Arrow = browser history) sees them.
      if (!sessionRef.current) return;
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopImmediatePropagation();
          cancel();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          e.stopImmediatePropagation();
          step(false, 'held');
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          e.stopImmediatePropagation();
          step(true, 'held');
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          e.stopImmediatePropagation();
          commit();
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const current = sessionRef.current;
      if (!current || current.mode !== 'held') return;
      // Releasing Alt ends a held gesture.
      if (e.key === 'Alt' || !e.altKey) commit();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [step, commit, cancel]);

  // Guest-forwarded Alt+Tab (focus inside a <webview>): advance, and commit
  // when Alt comes up, with an idle timer as the backstop.
  useEffect(() => {
    const bridge = getShellShortcuts();
    if (!bridge) return;
    return bridge.onShortcut((shortcut) => {
      if (shortcut.action === 'alt-released') {
        if (sessionRef.current?.mode === 'bridge') commit();
        return;
      }
      if (shortcut.action !== 'cycle-windows') return;
      step(shortcut.backward, 'bridge');
      window.clearTimeout(bridgeTimer.current);
      bridgeTimer.current = window.setTimeout(commit, BRIDGE_COMMIT_DELAY);
    });
  }, [step, commit]);

  // Clear the flag and any pending timer if we unmount mid-gesture.
  useEffect(
    () => () => {
      setWindowSwitcherActive(false);
      window.clearTimeout(bridgeTimer.current);
    },
    [],
  );

  if (!session) return null;

  const byId = new Map(windows.map((w) => [w.id, w]));
  const tiles = session.ids
    .map((id) => byId.get(id))
    .filter((w): w is WindowState => w !== undefined && !w.closing);
  if (tiles.length === 0) return null;

  const selectedId = session.ids[session.index];

  // Human label per window: what its app says it's showing, else the app
  // name, disambiguated with a running index when the app has more than one
  // untitled window.
  const totals = new Map<string, number>();
  for (const w of windows) {
    if (!w.title) totals.set(w.appId, (totals.get(w.appId) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labelFor = (w: WindowState) => {
    if (w.title) return w.title;
    const name = getApp(w.appId)?.name ?? w.appId;
    const n = (seen.get(w.appId) ?? 0) + 1;
    seen.set(w.appId, n);
    return (totals.get(w.appId) ?? 1) > 1 ? `${name} ${n}` : name;
  };
  const labels = new Map(tiles.map((w) => [w.id, labelFor(w)]));
  const selectedLabel = labels.get(selectedId) ?? '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={selectedLabel ? `Switch window: ${selectedLabel}` : 'Switch window'}
      onClick={cancel}
      className={cn(
        'absolute inset-0 z-[10001] flex items-center justify-center p-6',
        'bg-black/40 backdrop-blur-sm',
        'motion-safe:animate-in motion-safe:fade-in-0',
      )}
    >
      <div
        // Fixed dark glass, independent of the desktop theme (like the macOS
        // switcher), so window previews always read clearly over any wallpaper.
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'max-w-[90vw] rounded-2xl border border-white/10 bg-neutral-900/80 p-4 shadow-2xl',
          'text-white backdrop-blur-xl',
          'motion-safe:animate-in motion-safe:zoom-in-95',
        )}
      >
        <ul className="flex max-w-[80vw] flex-wrap justify-center gap-1">
          {tiles.map((w) => {
            const isSelected = w.id === selectedId;
            const app = getApp(w.appId);
            return (
              <li key={w.id}>
                <button
                  type="button"
                  aria-current={isSelected}
                  onMouseMove={() => select(w.id)}
                  onClick={() => choose(w.id)}
                  className={cn(
                    'flex w-24 flex-col items-center gap-2 rounded-xl p-3 transition-colors',
                    'focus-visible:outline-none',
                    isSelected ? 'bg-white/15 ring-2 ring-white/80' : 'hover:bg-white/5',
                  )}
                >
                  <span className="relative">
                    {app && (
                      <AppIcon
                        icon={w.icon ?? app.icon}
                        className="size-14 text-white drop-shadow"
                      />
                    )}
                    {w.minimized && (
                      <span className="absolute -bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-white/70" />
                    )}
                  </span>
                  <span className="w-full truncate text-center text-xs text-white/80">
                    {labels.get(w.id)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 truncate text-center text-sm font-medium text-white">
          {selectedLabel}
        </p>
      </div>
    </div>
  );
}

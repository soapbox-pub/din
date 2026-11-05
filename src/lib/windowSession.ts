import { z } from 'zod';
import { SNAP_ZONES, type SnapSplit, type SnapZone } from '@/lib/monitors';
import type { TileNode } from '@/lib/tiling';
import { WEB_POPUP_APP_ID } from '@/lib/webPopup';
import { PRINT_WINDOW_APP_ID } from '@/lib/printing';
import { PROVIDER_WINDOW_APP_ID } from '@/shared/assistant/providerWindow';

/**
 * The windows Din had open, kept on this device so the next start reopens
 * them: after Restart Din, an update, a crash, logging out or a reboot.
 *
 * Din is stopped without warning (systemd restarts din-shell), so there's
 * no moment to save at quit: the desktop saves a snapshot a moment after
 * every change instead (WindowSessionHost). Each window keeps its app, its
 * launch params, where it was (monitor, workspace, geometry, maximized,
 * tiled, minimized, stacking) and, if its app saved one, a state of its own
 * (a Din app's navigation state, the browser's tabs) that it gets back on restore.
 */

/** The snapshot of the windows open. */
const SESSION_KEY = 'din:session:windows';
/**
 * Counts restores under way, until Din has run a while after one. Still set
 * at the next start, the restore may be what brought Din down: after two in
 * a row, a start leaves the windows closed and offers to reopen them instead.
 */
const RESTORING_KEY = 'din:session:restoring';

/** The most an app's saved state can take, as JSON. */
export const MAX_WINDOW_STATE_BYTES = 512 * 1024;

/**
 * Apps whose windows don't come back: they're tied to something that died
 * with Din (a page's DevTools or pop-up, an unrecognized native window) or
 * are one-off tools.
 */
const NOT_RESTORED = new Set(['devtools', WEB_POPUP_APP_ID, 'installer', 'native-window', 'screenshot', PROVIDER_WINDOW_APP_ID, PRINT_WINDOW_APP_ID]);

/**
 * Launch params that only mean something to the run that set them: a native
 * window's X id and size, a tab parked for a window to adopt, the browser's
 * tabs (its saved state carries those), and a shortcut, which would run again.
 */
const LIVE_PARAMS = ['xid', 'width', 'height', 'adoptTab', 'restoreSession', 'shortcut', 'actionAt'];

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const tileSchema: z.ZodType<TileNode> = z.lazy(() =>
  z.union([
    z.object({ leaf: z.string() }),
    z.object({ split: z.enum(['h', 'v']), ratio: z.number(), a: tileSchema, b: tileSchema }),
  ]),
);

const savedWindowSchema = z.object({
  /** The window's id in the run that saved it, for the tiling trees. */
  id: z.string(),
  appId: z.string(),
  params: z.record(z.string(), z.unknown()),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  z: z.number(),
  minimized: z.boolean(),
  maximized: z.boolean(),
  snapped: z.enum(SNAP_ZONES).nullable(),
  /** Older sessions have none: even borders. */
  split: z.object({ x: z.number(), left: z.number(), right: z.number() }).nullable().optional(),
  monitor: z.string().nullable(),
  restore: rectSchema.nullable(),
  frameless: z.boolean(),
  floating: z.boolean(),
  workspace: z.number().int().min(1),
  /** A native Linux app's window: its app is started again, not opened. */
  native: z.boolean(),
  /** What the window's app saved of itself, if anything. */
  state: z.unknown().optional(),
});

export type SavedWindow = z.infer<typeof savedWindowSchema>;

const sessionSchema = z.object({
  windows: z.array(savedWindowSchema),
  trees: z.record(z.string(), tileSchema),
  active: z.record(z.string(), z.number().int().min(1)),
});

export type SavedSession = z.infer<typeof sessionSchema>;

/** The window manager's state, as much of it as a snapshot needs. */
export interface LiveSession {
  windows: {
    id: string;
    appId: string;
    params?: Record<string, unknown>;
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    minimized: boolean;
    closing: boolean;
    maximized: boolean;
    snapped: SnapZone | null;
    split: SnapSplit | null;
    monitor: string | null;
    restore: { x: number; y: number; width: number; height: number } | null;
    frameless: boolean;
    floating: boolean;
    workspace: number;
  }[];
  trees: Record<string, TileNode>;
  active: Record<string, number>;
}

// ---- what apps save of themselves ----

/** Each open window's saved state, by window id. */
const windowStates = new Map<string, unknown>();
/** Windows this run opened from the saved session. */
const restoredWindows = new Set<string>();
const stateListeners = new Set<() => void>();

/**
 * Keep a window's own state for the next start (a Din app's navigation state, the
 * browser's tabs). JSON only, up to MAX_WINDOW_STATE_BYTES; null forgets it.
 * Returns false when it's too big or can't be stored as JSON.
 */
export function saveWindowState(windowId: string, value: unknown): boolean {
  if (value === null || value === undefined) {
    windowStates.delete(windowId);
  } else {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return false;
    }
    if (json === undefined || json.length > MAX_WINDOW_STATE_BYTES) return false;
    windowStates.set(windowId, JSON.parse(json));
  }
  for (const listener of stateListeners) listener();
  return true;
}

/** The state a window saved (or was restored with), or null. */
export function windowStateOf(windowId: string): unknown {
  return windowStates.get(windowId) ?? null;
}

/** Whether a window was reopened from the saved session. */
export function wasRestored(windowId: string): boolean {
  return restoredWindows.has(windowId);
}

/** Hear of windows saving their state (to save the session again). */
export function subscribeWindowStates(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** A window was reopened from the saved session, with this state. */
export function markRestored(windowId: string, state: unknown): void {
  restoredWindows.add(windowId);
  if (state !== undefined && state !== null) windowStates.set(windowId, state);
}

// ---- native apps, started again ----

/** Where native apps' windows go as they map again, by app, oldest first. */
const nativePlacements = new Map<string, { window: SavedWindow; until: number }[]>();
/** How long a restarted native app has to map its windows. */
const NATIVE_PLACEMENT_MS = 60_000;

/** Have the next windows `appId` maps go where these were. */
export function expectNativeWindows(appId: string, windows: SavedWindow[]): void {
  const until = Date.now() + NATIVE_PLACEMENT_MS;
  nativePlacements.set(appId, windows.map((window) => ({ window, until })));
}

/** Where a native app's new window goes, if it's one coming back. */
export function takeNativePlacement(appId: string): SavedWindow | null {
  const list = nativePlacements.get(appId);
  if (!list) return null;
  const now = Date.now();
  let next = list.shift();
  while (next && next.until < now) next = list.shift();
  if (list.length === 0) nativePlacements.delete(appId);
  return next?.window ?? null;
}

// ---- the snapshot ----

/** Launch params worth keeping: JSON, without the ones only this run understands. */
function lasting(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (LIVE_PARAMS.includes(key) || value === undefined) continue;
    try {
      if (JSON.stringify(value) === undefined) continue;
    } catch {
      continue;
    }
    out[key] = value;
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

/**
 * The snapshot of a session. `isNative` tells native apps' windows, and
 * `keep` the windows worth saving at all (private browser windows aren't).
 */
export function snapshotSession(
  live: LiveSession,
  isNative: (appId: string) => boolean,
  keep: (w: LiveSession['windows'][number]) => boolean = () => true,
): SavedSession {
  const windows = live.windows
    .filter((w) => !w.closing && !NOT_RESTORED.has(w.appId) && keep(w))
    // A native window of an app Din couldn't name can't be started again.
    .filter((w) => typeof w.params?.xid !== 'number' || isNative(w.appId))
    .sort((a, b) => a.z - b.z)
    .map((w, i): SavedWindow => {
      const state = windowStates.get(w.id);
      return {
        id: w.id,
        appId: w.appId,
        params: lasting(w.params),
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
        z: i + 1,
        minimized: w.minimized,
        maximized: w.maximized,
        snapped: w.snapped,
        split: w.split,
        monitor: w.monitor,
        restore: w.restore,
        frameless: w.frameless,
        floating: w.floating,
        workspace: w.workspace,
        native: typeof w.params?.xid === 'number',
        ...(state !== undefined ? { state } : {}),
      };
    });
  // Forget what closed windows saved.
  const ids = new Set(live.windows.map((w) => w.id));
  for (const id of windowStates.keys()) if (!ids.has(id)) windowStates.delete(id);
  return { windows, trees: live.trees, active: live.active };
}

/** The saved session, or null when there's none (or it's unreadable). */
export function readSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

let lastWritten: string | null = null;

/** Save the session (skipped when nothing changed). */
export function writeSession(session: SavedSession): void {
  const json = JSON.stringify(session);
  if (json === lastWritten) return;
  try {
    localStorage.setItem(SESSION_KEY, json);
    lastWritten = json;
  } catch (error) {
    console.warn('Failed to save the open windows:', error);
  }
}

/** Forget the saved session (`din windows forget`, or the setting turned off). */
export function clearSession(): void {
  lastWritten = null;
  localStorage.removeItem(SESSION_KEY);
}

let started = false;

/** True the first time it's asked in a page load: the session restores once. */
export function claimSessionStart(): boolean {
  if (started) return false;
  started = true;
  return true;
}

// ---- a restore left for the user to ask for ----

/** The session this start didn't reopen (the last restore never finished). */
let skipped: SavedSession | null = null;
let reopener: ((session: SavedSession) => void) | null = null;

/** Hold a session the user may still ask to reopen. */
export function holdSkippedSession(session: SavedSession | null): void {
  skipped = session;
}

/** Whether there's a skipped session to reopen. */
export function hasSkippedSession(): boolean {
  return skipped !== null;
}

/** The desktop's way of reopening a session (WindowSessionHost). */
export function setSessionReopener(fn: ((session: SavedSession) => void) | null): void {
  reopener = fn;
}

/**
 * Reopen the windows this start left closed (`din windows reopen`, the
 * notification's button). False when there are none, or no desktop.
 */
export function reopenSkippedSession(): boolean {
  if (!skipped || !reopener) return false;
  const session = skipped;
  skipped = null;
  reopener(session);
  return true;
}

/** Restores in a row that never finished. */
const interruptedRestores = () => Number(localStorage.getItem(RESTORING_KEY)) || 0;

/**
 * Whether the last restores never finished (see RESTORING_KEY): two in a
 * row, so one restart soon after starting doesn't count as a crash.
 */
export function restoreInterrupted(): boolean {
  return interruptedRestores() >= 2;
}

/** Mark a restore begun (true) or come through (false). */
export function setRestoring(on: boolean): void {
  try {
    if (on) localStorage.setItem(RESTORING_KEY, String(interruptedRestores() + 1));
    else localStorage.removeItem(RESTORING_KEY);
  } catch {
    // Best-effort: without it, a crashing restore just isn't caught.
  }
}

import { z } from 'zod';

/**
 * The browser's tabs, kept across closing it and across restarts (Chrome's
 * "continue where you left off"). Private windows never come through here.
 *
 * Every open browser window keeps a snapshot of its tabs in localStorage,
 * tagged with this run of Din. Opening the browser when no other browser
 * window is open restores what was there before: the windows still on file
 * from an earlier run (Din quit or crashed with them open), or else the last
 * window closed in this one. A browser window opened next to another one
 * starts fresh.
 */

/** One saved tab. */
export interface SavedTab {
  url: string;
  title: string | null;
  favicon: string | null;
  pinned: boolean;
  /** Index of the tab that opened this one, for the tree sidebar. */
  parent: number | null;
}

/** One saved browser window. */
export interface SavedWindow {
  tabs: SavedTab[];
  /** Index of the selected tab. */
  active: number;
}

const savedWindowSchema: z.ZodType<SavedWindow> = z.object({
  tabs: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      favicon: z.string().nullable(),
      pinned: z.boolean(),
      parent: z.number().int().nullable(),
    }),
  ),
  active: z.number().int(),
});

const liveSchema = z.record(
  z.string(),
  z.object({ run: z.string(), updatedAt: z.number(), window: savedWindowSchema }),
);
type Live = z.infer<typeof liveSchema>;

/** Snapshots of the browser windows that are open, by run and window id. */
const LIVE_KEY = 'din:browser:session:windows';
/** The last browser window closed, for when the browser opens again. */
const LAST_KEY = 'din:browser:session:last';

/** This run of Din: window ids repeat between runs, so entries carry it. */
const RUN = crypto.randomUUID();

const entryKey = (windowId: string) => `${RUN}/${windowId}`;

function read<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Failed to save ${key} to localStorage:`, error);
  }
}

const readLive = (): Live => read(LIVE_KEY, liveSchema) ?? {};

/** What each window last saved, to skip writes when nothing changed. */
const lastSaved = new Map<string, { json: string; window: SavedWindow }>();

/** Record a window's tabs. Cheap to call on every tab update. */
export function saveBrowserWindow(windowId: string, window: SavedWindow): void {
  const json = JSON.stringify(window);
  if (lastSaved.get(windowId)?.json === json) return;
  lastSaved.set(windowId, { json, window });
  const live = readLive();
  live[entryKey(windowId)] = { run: RUN, updatedAt: Date.now(), window };
  write(LIVE_KEY, live);
}

/**
 * A window went away. If it was the last browser window open, its tabs are
 * what the browser reopens with.
 */
export function forgetBrowserWindow(windowId: string): void {
  const saved = lastSaved.get(windowId)?.window;
  lastSaved.delete(windowId);
  const live = readLive();
  delete live[entryKey(windowId)];
  write(LIVE_KEY, live);
  if (Object.values(live).some((entry) => entry.run === RUN)) return;
  write(LAST_KEY, saved && saved.tabs.length > 0 ? saved : null);
}

/** What a newly opened window restores: its own tabs, and any more windows. */
export interface SessionClaim {
  window: SavedWindow;
  others: SavedWindow[];
}

const claims = new Map<string, SessionClaim | null>();

/**
 * The tabs a newly opened browser window should restore, or null to start
 * fresh. Consumes what it returns; repeat calls for a window (state
 * initializers run twice in development) return the same answer.
 */
export function claimBrowserSession(windowId: string): SessionClaim | null {
  if (claims.has(windowId)) return claims.get(windowId) ?? null;
  const claim = takeSession(windowId);
  claims.set(windowId, claim);
  return claim;
}

function takeSession(windowId: string): SessionClaim | null {
  const live = readLive();
  const others = Object.entries(live).filter(([key]) => key !== entryKey(windowId));
  // Another browser window is open: this one is a new window, not a reopen.
  if (others.some(([, entry]) => entry.run === RUN)) return null;
  const stale = others
    .map(([, entry]) => entry)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => entry.window)
    .filter((w) => w.tabs.length > 0);
  write(LIVE_KEY, null);
  if (stale.length > 0) {
    write(LAST_KEY, null);
    return { window: stale[0], others: stale.slice(1) };
  }
  const last = read(LAST_KEY, savedWindowSchema);
  write(LAST_KEY, null);
  return last && last.tabs.length > 0 ? { window: last, others: [] } : null;
}

/** A saved window passed in launch params (one restored alongside another). */
export function restoredWindowParam(params: Record<string, unknown> | undefined): SavedWindow | null {
  const parsed = savedWindowSchema.safeParse(params?.restoreSession);
  return parsed.success ? parsed.data : null;
}

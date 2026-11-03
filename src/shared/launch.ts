/**
 * Launches as the web has them (docs/din/lifecycle.md): each comes to the
 * page's `launchQueue` consumer, its parameters in the `targetURL`'s query
 * and its files as handles; what a window saved for Din to reopen it with is
 * its Navigation API state. Only web APIs: the desktop encodes the
 * parameters (`encodeLaunchParams`), and this reads them back.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { LaunchParams } from '@/sdk/din';

// ---- parameters in a URL's query ----

/** Read as JSON, not text: objects, arrays, quoted strings, numbers, booleans and null. */
const JSON_VALUE = /^(?:[[{"]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$|true$|false$|null$)/;

/**
 * Put launch parameters in a URL's query: a string as itself, unless it
 * would read back as something else (`"2024"`, `"true"`), anything else as
 * JSON. `undefined` is left out.
 */
export function encodeLaunchParams(url: URL, params: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, typeof value === 'string' && !JSON_VALUE.test(value) ? value : JSON.stringify(value));
  }
}

/**
 * The URL that launches an app with these parameters, for `window.open`
 * (or `din.app.launch`, to hand it files too): `din://<id>/` with the
 * parameters in its query. Null for a new window of this app.
 */
export function appLink(appId: string | null, params: Record<string, unknown> = {}): string {
  const url = appId === null ? new URL('/', location.href) : new URL(`din://${appId}/`);
  encodeLaunchParams(url, params);
  return url.href;
}

/**
 * Whether an app can be opened now, by `navigator.getInstalledRelatedApps()`:
 * the app's manifest must list it in `related_applications` as
 * `{ "platform": "webapp", "url": "din://<id>/manifest.webmanifest" }`.
 */
export async function canOpenApp(appId: string): Promise<boolean> {
  if (typeof navigator.getInstalledRelatedApps !== 'function') return false;
  const url = `din://${appId}/manifest.webmanifest`;
  return (await navigator.getInstalledRelatedApps()).some((app) => app.platform === 'webapp' && app.url === url);
}

/** The launch parameters in a URL's query, as `encodeLaunchParams` put them there. */
export function decodeLaunchParams(url: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let query: URLSearchParams;
  try {
    query = new URL(url).searchParams;
  } catch {
    return out;
  }
  for (const [key, value] of query) {
    if (!JSON_VALUE.test(value)) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

// ---- the Navigation API, which TypeScript's DOM types don't have yet ----

interface NavigationState {
  currentEntry: { getState(): unknown } | null;
  updateCurrentEntry(options: { state: unknown }): void;
}

const navigationApi = (): NavigationState | undefined => (globalThis as { navigation?: NavigationState }).navigation;

// ---- the page's one launchQueue consumer ----

/** A launch, with its parameters read from its URL. */
export interface Launch extends LaunchParams {
  readonly params: Record<string, unknown>;
}

interface Launches {
  first: Promise<Launch>;
  own: Launch | null;
  /** The window's saved state as it was at its launch: undefined for a new window. */
  restored: unknown;
  listeners: Set<(launch: Launch) => void>;
}
let launches: Launches | null = null;

const NO_LAUNCH: Launch = { targetURL: '', files: [], params: {} };

/** The page's one `launchQueue` consumer: the first launch is the window's own, the rest come after. */
function listen(): Launches {
  if (launches) return launches;
  let resolve!: (launch: Launch) => void;
  const l: Launches = { first: new Promise((r) => (resolve = r)), own: null, restored: undefined, listeners: new Set() };
  launches = l;
  const first = (launch: Launch) => {
    l.own = launch;
    l.restored = navigationApi()?.currentEntry?.getState();
    resolve(launch);
  };
  if (typeof launchQueue === 'undefined') {
    first(NO_LAUNCH);
    return l;
  }
  launchQueue.setConsumer((params) => {
    const launch: Launch = { targetURL: params.targetURL, files: params.files, params: decodeLaunchParams(params.targetURL) };
    if (!l.own) first(launch);
    else for (const cb of [...l.listeners]) cb(launch);
  });
  return l;
}

/** This window's own launch, once it's come (`startApp` waits for it). */
export function launched(): Promise<Launch> {
  return listen().first;
}

/** This window's own launch, at once: `startApp` waits for it before the app renders. */
export function windowLaunch(): Launch {
  return listen().own ?? NO_LAUNCH;
}

/**
 * Each launch after the window's own: a single-instance app launched again,
 * a Dock shortcut chosen. The window is already focused.
 */
export function onLaunch(cb: (launch: Launch) => void): () => void {
  const l = listen();
  l.listeners.add(cb);
  return () => l.listeners.delete(cb);
}

/** `onLaunch` while mounted, with the latest callback. */
export function useOnLaunch(cb: (launch: Launch) => void): void {
  const latest = useRef(cb);
  useLayoutEffect(() => {
    latest.current = cb;
  });
  useEffect(() => onLaunch((launch) => latest.current(launch)), []);
}

// ---- what a window keeps for Din to reopen it with ----

/**
 * What this window had saved, when Din reopened it (after restarting, or
 * after the app crashed); null for a new window. The Navigation API's
 * `navigation.currentEntry.getState()`, as it was at the window's launch.
 */
export function restoredState(): unknown {
  return listen().restored ?? null;
}

/**
 * Whether the window is one Din reopened, saved state or not, rather than a
 * new one: its launch's parameters were carried out the first time. Its
 * Navigation API entry has state (null if it saved none); a new window's
 * has none.
 */
export function wasReopened(): boolean {
  return listen().restored !== undefined;
}

/**
 * Keep what the window shows for when Din reopens it: JSON, up to 512 KB.
 * Each call replaces the last; null forgets it. Save as it changes: Din can
 * stop at any time. The Navigation API's `navigation.updateCurrentEntry`.
 */
export function saveState(state: unknown): void {
  navigationApi()?.updateCurrentEntry({ state });
}

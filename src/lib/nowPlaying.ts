import { useSyncExternalStore } from 'react';
import { localFileUrl } from '@/lib/fs';

/**
 * Everything playing on the computer, for the media controls in the volume
 * menu: the Media Player (which registers itself once it's loaded, see
 * registerMediaSource), the shell's own <audio>/<video> elements (Preview,
 * Quick Look), and, from the Electron preload (`window.media`, see
 * electron/media.mts), web pages and native apps.
 *
 * Pause works on all of them. Play, Next and Previous depend on the source:
 * a web page has them only if it says how (its Media Session), and the
 * shell's elements have no next or previous.
 *
 * The media keys (keyboards' and Bluetooth headsets') control one source,
 * the way GNOME and KDE pick: Play/Pause pauses the newest one playing, or
 * resumes the newest paused one; Next and Previous go to the newest one
 * that has them, preferring one that's playing.
 */

export type MediaAction = 'play' | 'pause' | 'nexttrack' | 'previoustrack';
export type MediaKey = 'playpause' | 'play' | 'pause' | 'stop' | 'nexttrack' | 'previoustrack';

export interface MediaSource {
  id: string;
  kind: 'player' | 'shell' | 'web' | 'app';
  title: string;
  /** The artist, or the app or site it's playing in. */
  subtitle: string;
  artwork: string | null;
  playing: boolean;
  canPlay: boolean;
  canPrevious: boolean;
  canNext: boolean;
  /** When it started playing (ms since epoch), for ordering. */
  since: number;
}

/** What the Electron preload exposes as `window.media`. */
export interface MediaBridge {
  list(): Promise<MediaSource[]>;
  onChange(callback: (sources: MediaSource[]) => void): () => void;
  control(id: string, action: MediaAction): Promise<void>;
  onKey(callback: (key: MediaKey) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    media?: MediaBridge;
  }
}

/** A source living in the shell's own code, like the Media Player. */
export interface LocalMediaSource {
  current(): MediaSource | null;
  subscribe(listener: () => void): () => void;
  control(action: MediaAction): void;
  /**
   * Start playing though it isn't listed (stopped, with something queued),
   * for a play key pressed with nothing else to play. False if it can't.
   */
  playIdle?(): boolean;
}

const locals = new Set<LocalMediaSource>();
const elements = new Map<HTMLMediaElement, { id: string; since: number }>();
let external: MediaSource[] = [];
let snapshot: MediaSource[] = [];
const listeners = new Set<() => void>();
let nextElementId = 1;

function fileName(src: string): string {
  try {
    const url = new URL(src);
    if (url.protocol === 'blob:') return '';
    return decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
  } catch {
    return '';
  }
}

function elementSource(el: HTMLMediaElement, entry: { id: string; since: number }): MediaSource {
  const app = el.closest<HTMLElement>('[data-window-id]')?.dataset.appName ?? '';
  return {
    id: entry.id,
    kind: 'shell',
    title: fileName(el.currentSrc) || app || 'Media',
    subtitle: app,
    artwork: null,
    playing: !el.paused && !el.ended,
    canPlay: true,
    canPrevious: false,
    canNext: false,
    since: entry.since,
  };
}

function rebuild(): void {
  const sources: MediaSource[] = [];
  for (const local of locals) {
    const source = local.current();
    if (source) sources.push(source);
  }
  for (const [el, entry] of elements) sources.push(elementSource(el, entry));
  sources.push(...external);
  // Not by whether it's playing: a row mustn't jump away from under the
  // pointer when its Pause is pressed.
  sources.sort((a, b) => b.since - a.since);
  snapshot = sources;
  for (const listener of listeners) listener();
}

function onMediaEvent(event: Event): void {
  const el = event.target;
  if (!(el instanceof HTMLMediaElement) || el.dataset.dinPlayer !== undefined) return;
  if (event.type === 'play') {
    if (!elements.has(el)) elements.set(el, { id: `shell:${nextElementId++}`, since: Date.now() });
  } else if (!elements.has(el)) {
    return;
  } else if (event.type === 'ended' || event.type === 'emptied' || (el.paused && !el.isConnected)) {
    elements.delete(el);
  }
  rebuild();
}

function start(): void {
  for (const type of ['play', 'pause', 'ended', 'emptied']) {
    document.addEventListener(type, onMediaEvent, true);
  }
  const bridge = window.media;
  if (!bridge) return;
  const receive = (sources: MediaSource[]) => {
    external = Array.isArray(sources) ? sources : [];
    rebuild();
  };
  bridge.onChange(receive);
  bridge.list().then(receive, () => {});
  bridge.onKey(handleMediaKey);
}

function handleMediaKey(key: MediaKey): void {
  const playing = snapshot.find((s) => s.playing);
  if (key === 'pause' || key === 'stop' || (key === 'playpause' && playing)) {
    if (playing) controlMedia(playing.id, 'pause');
    return;
  }
  if (key === 'play' || key === 'playpause') {
    if (playing) return;
    const paused = snapshot.find((s) => s.canPlay);
    if (paused) controlMedia(paused.id, 'play');
    else for (const local of locals) if (local.playIdle?.()) return;
    return;
  }
  const can = (s: MediaSource) => (key === 'nexttrack' ? s.canNext : s.canPrevious);
  const target = snapshot.find((s) => s.playing && can(s)) ?? snapshot.find(can);
  if (target) controlMedia(target.id, key);
}

if (typeof document !== 'undefined') start();

/** Add a source of the shell's own. Returns a function that removes it. */
export function registerMediaSource(source: LocalMediaSource): () => void {
  locals.add(source);
  const unsubscribe = source.subscribe(rebuild);
  rebuild();
  return () => {
    unsubscribe();
    locals.delete(source);
    rebuild();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // An element taken out of the document (its window closed) pauses without
  // its events reaching the document.
  let pruned = false;
  for (const el of elements.keys()) {
    if (el.isConnected || !el.paused) continue;
    elements.delete(el);
    pruned = true;
  }
  if (pruned) rebuild();
  return () => listeners.delete(listener);
}

/** What's playing or paused, most recently started first. */
export function useNowPlaying(): MediaSource[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function controlMedia(id: string, action: MediaAction): void {
  for (const local of locals) {
    if (local.current()?.id === id) {
      local.control(action);
      return;
    }
  }
  for (const el of elements.keys()) {
    if (elements.get(el)?.id !== id) continue;
    if (action === 'pause') el.pause();
    else if (action === 'play') void el.play().catch(() => {});
    return;
  }
  void window.media?.control(id, action).catch(() => {});
}

/** An artwork URL the shell can load: native apps' file:// art goes through din-file. */
export function artworkSrc(artwork: string | null): string | null {
  if (!artwork) return null;
  if (artwork.startsWith('file://')) {
    try {
      return localFileUrl(decodeURIComponent(new URL(artwork).pathname));
    } catch {
      return null;
    }
  }
  return artwork;
}

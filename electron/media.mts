// What's playing outside the shell's own document, for the media controls in
// the volume menu (VolumeIndicator.tsx): web pages in browser tabs and
// installed web apps, and native apps over MPRIS (mpris.mts). The Media
// Player and the shell's own <audio>/<video> elements are the shell's to see
// for itself (src/lib/nowPlaying.ts).
//
// A web page reports its media from media-preload.cjs, one report per frame:
// whether it's playing, whether it has something paused to resume, its Media
// Session's title, artist and artwork, and which session actions it handles.
// Chromium's audibility covers what the preload can't see. Controls go back
// to the frames; Play, Next and Previous may do nothing on a page that gives
// no way to, but Pause always works: a page still audible a moment after
// being asked to pause is muted, until Din plays it again.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain, webContents, type WebContents, type WebFrameMain } from 'electron';
import { mprisControl, mprisPlayers, startMpris, type MprisAction } from './mpris.mts';

/** How long a paused page may stay audible before it's muted. */
const PAUSE_GRACE_MS = 1500;
const MAX_TEXT = 300;
const MAX_ARTWORK = 256 * 1024;

export type MediaAction = 'play' | 'pause' | 'nexttrack' | 'previoustrack';
const ACTIONS: readonly MediaAction[] = ['play', 'pause', 'nexttrack', 'previoustrack'];

/** One thing playing (or paused), as the shell lists it. */
export interface ExternalMediaSource {
  id: string;
  kind: 'web' | 'app';
  title: string;
  /** The artist, or the site or app it's playing in. */
  subtitle: string;
  /** An https, data or file URL. */
  artwork: string | null;
  playing: boolean;
  canPlay: boolean;
  canPrevious: boolean;
  canNext: boolean;
  /** When it started playing (ms since epoch), for ordering. */
  since: number;
  /** The guest it's in, for a web page. */
  wcId?: number;
}

interface FrameState {
  playing: boolean;
  resumable: boolean;
  sessionState: string;
  title: string;
  artist: string;
  artwork: string | null;
  actions: string[];
}

interface Guest {
  contents: WebContents;
  frames: Map<string, { frame: WebFrameMain; state: FrameState }>;
  audible: boolean;
  since: number;
  listed: boolean;
  /** Din paused it, so Play is worth offering whatever the page says. */
  pausedByDin: boolean;
  /** Frames that were playing when Din paused, which Play goes back to. */
  pausedFrames: Set<string>;
  mutedByDin: boolean;
  muteTimer: NodeJS.Timeout | null;
}

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** Whether a guest belongs to the shell and its media may be listed. */
  isMediaGuest: (contents: WebContents) => boolean;
}

let options: Options | null = null;
const guests = new Map<number, Guest>();
let publishTimer: NodeJS.Timeout | null = null;

function frameKey(frame: WebFrameMain): string {
  return `${frame.processId}:${frame.routingId}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

function artworkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('https:') && value.length <= 4096) return value;
  if (/^data:image\/(png|jpeg|webp|gif);/.test(value) && value.length <= MAX_ARTWORK) return value;
  return null;
}

/** A frame's report, from the page: trust none of it. */
function parseState(raw: unknown): FrameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    playing: r.playing === true,
    resumable: r.resumable === true,
    sessionState: text(r.sessionState),
    title: text(r.title),
    artist: text(r.artist),
    artwork: artworkUrl(r.artwork),
    actions: Array.isArray(r.actions) ? r.actions.filter((a): a is string => ACTIONS.includes(a as MediaAction)) : [],
  };
}

function schedulePublish(): void {
  publishTimer ??= setTimeout(() => {
    publishTimer = null;
    options?.sendToShell('media:sources', listSources());
  }, 100);
}

function setMuted(guest: Guest, muted: boolean): void {
  if (guest.muteTimer) clearTimeout(guest.muteTimer);
  guest.muteTimer = null;
  if (guest.mutedByDin === muted) return;
  guest.mutedByDin = muted;
  if (!guest.contents.isDestroyed()) guest.contents.setAudioMuted(muted);
}

/** It started playing again by itself: whatever Din did to pause it is over. */
function resumed(guest: Guest): void {
  guest.pausedByDin = false;
  guest.pausedFrames.clear();
  setMuted(guest, false);
}

function guestFor(contents: WebContents): Guest {
  let guest = guests.get(contents.id);
  if (guest) return guest;
  guest = {
    contents,
    frames: new Map(),
    audible: contents.isCurrentlyAudible(),
    since: 0,
    listed: false,
    pausedByDin: false,
    pausedFrames: new Set(),
    mutedByDin: false,
    muteTimer: null,
  };
  guests.set(contents.id, guest);
  const g = guest;
  contents.on('audio-state-changed', (event) => {
    g.audible = event.audible;
    schedulePublish();
  });
  contents.on('media-started-playing', () => {
    if (g.pausedByDin || g.mutedByDin) resumed(g);
    schedulePublish();
  });
  contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame) {
      g.frames.clear();
      resumed(g);
    } else {
      g.frames.delete(`${processId}:${routingId}`);
    }
    schedulePublish();
  });
  contents.once('destroyed', () => {
    if (g.muteTimer) clearTimeout(g.muteTimer);
    guests.delete(contents.id);
    schedulePublish();
  });
  return guest;
}

/** The frame whose media stands for the page: playing, and named, first. */
function leadFrame(guest: Guest): { key: string; state: FrameState } | null {
  let best: { key: string; state: FrameState } | null = null;
  let bestScore = -1;
  for (const [key, { state }] of guest.frames) {
    const score =
      (state.playing ? 4 : 0) + (state.title ? 2 : 0) + (state.resumable || state.sessionState === 'paused' ? 1 : 0);
    if (score > bestScore) {
      best = { key, state };
      bestScore = score;
    }
  }
  return best;
}

function guestSource(guest: Guest): ExternalMediaSource | null {
  const { contents } = guest;
  if (contents.isDestroyed() || !options?.isMediaGuest(contents)) return null;
  const states = [...guest.frames.values()].map((f) => f.state);
  const audible = guest.audible && !guest.mutedByDin;
  const playing = audible || states.some((s) => s.playing);
  const resumable = states.some((s) => s.resumable || (s.sessionState === 'paused' && s.title));
  if (!playing && !resumable && !guest.pausedByDin) {
    guest.listed = false;
    return null;
  }
  if (!guest.listed) guest.since = Date.now();
  guest.listed = true;
  const actions = new Set(states.flatMap((s) => s.actions));
  const lead = leadFrame(guest)?.state;
  const host = hostOf(contents.getURL());
  const title = lead?.title || contents.getTitle() || host || 'Web page';
  return {
    id: `web:${contents.id}`,
    kind: 'web',
    title,
    subtitle: (lead?.title && lead.artist) || host,
    // The shell loads an https picture itself, outside the page's session:
    // from a private or Tor tab, only a picture the page handed over whole.
    artwork: lead?.artwork && (contents.session.isPersistent() || lead.artwork.startsWith('data:')) ? lead.artwork : null,
    playing,
    canPlay: actions.has('play') || resumable || guest.pausedByDin,
    canPrevious: actions.has('previoustrack'),
    canNext: actions.has('nexttrack'),
    since: guest.since,
    wcId: contents.id,
  };
}

function listSources(): ExternalMediaSource[] {
  const sources: ExternalMediaSource[] = [];
  for (const guest of guests.values()) {
    const source = guestSource(guest);
    if (source) sources.push(source);
  }
  for (const player of mprisPlayers()) {
    sources.push({
      id: `mpris:${player.name}`,
      kind: 'app',
      title: player.title || player.identity,
      subtitle: (player.title && player.artist) || player.identity,
      artwork: player.artUrl,
      playing: player.status === 'Playing',
      canPlay: player.canPlay,
      canPrevious: player.canGoPrevious,
      canNext: player.canGoNext,
      since: player.since,
    });
  }
  return sources;
}

function sendToFrame(frame: WebFrameMain, action: MediaAction): void {
  try {
    if (!frame.detached) frame.send('media:command', action);
  } catch {
    // The frame went away.
  }
}

function controlGuest(guest: Guest, action: MediaAction): void {
  const { contents } = guest;
  if (contents.isDestroyed()) return;
  if (action === 'pause') {
    guest.pausedFrames = new Set(
      [...guest.frames].filter(([, f]) => f.state.playing).map(([key]) => key),
    );
    // Every frame: Web Audio playing in one that never reported is paused too.
    for (const frame of contents.mainFrame.framesInSubtree) sendToFrame(frame, 'pause');
    guest.pausedByDin = true;
    if (guest.muteTimer) clearTimeout(guest.muteTimer);
    guest.muteTimer = setTimeout(() => {
      guest.muteTimer = null;
      if (!contents.isDestroyed() && guest.pausedByDin && contents.isCurrentlyAudible()) {
        setMuted(guest, true);
        schedulePublish();
      }
    }, PAUSE_GRACE_MS);
  } else if (action === 'play') {
    setMuted(guest, false);
    const keys = guest.pausedFrames.size > 0 ? guest.pausedFrames : new Set([leadFrame(guest)?.key]);
    const targets = [...guest.frames].filter(([key]) => keys.has(key)).map(([, f]) => f.frame);
    for (const frame of targets.length > 0 ? targets : [contents.mainFrame]) sendToFrame(frame, 'play');
    guest.pausedByDin = false;
    guest.pausedFrames.clear();
  } else {
    const lead = leadFrame(guest);
    const target = lead?.state.actions.includes(action)
      ? guest.frames.get(lead.key)
      : [...guest.frames.values()].find((f) => f.state.actions.includes(action));
    if (target) sendToFrame(target.frame, action);
  }
  schedulePublish();
}

/**
 * Pause everything playing: pages and apps alike. For headphones taken away
 * mid-song, so it doesn't carry on out of the speakers.
 */
export function pauseAllMedia(): void {
  for (const guest of guests.values()) {
    if (guestSource(guest)?.playing) controlGuest(guest, 'pause');
  }
  for (const player of mprisPlayers()) {
    if (player.status === 'Playing') void mprisControl(player.name, 'pause').catch(() => {});
  }
}

/** Watch a <webview> guest's audio from the moment it's made. */
export function watchMediaGuest(contents: WebContents): void {
  guestFor(contents);
}

export function registerMediaHandlers(opts: Options): void {
  options = opts;
  startMpris(schedulePublish);

  ipcMain.handle('media:list', (event) => {
    opts.assertShellSender(event);
    return listSources();
  });

  ipcMain.handle('media:control', async (event, id: unknown, action: unknown) => {
    opts.assertShellSender(event);
    if (typeof id !== 'string' || !ACTIONS.includes(action as MediaAction)) return;
    const verb = action as MediaAction;
    if (id.startsWith('mpris:')) {
      await mprisControl(id.slice('mpris:'.length), verb as MprisAction);
      return;
    }
    const wcId = Number(id.replace(/^web:/, ''));
    const guest = guests.get(wcId);
    if (guest) controlGuest(guest, verb);
  });

  // From media-preload.cjs: a frame's media changed.
  ipcMain.on('media:frame', (event, raw: unknown) => {
    const frame = event.senderFrame;
    const state = parseState(raw);
    if (!frame || !state) return;
    const contents = webContents.fromFrame(frame);
    if (!contents || contents.getType() !== 'webview') return;
    const guest = guestFor(contents);
    const key = frameKey(frame);
    const before = guest.frames.get(key)?.state;
    guest.frames.set(key, { frame, state });
    if (state.playing && !before?.playing && (guest.pausedByDin || guest.mutedByDin)) resumed(guest);
    schedulePublish();
  });
}

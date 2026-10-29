import { useSyncExternalStore } from 'react';
import type { Din, MediaSession } from '@/sdk';
import { EQ_BANDS, EQ_MAX_DB } from './eq';
import { baseTitle, coverFor, isUrl, isVideoLocation, mediaUrl, trackInfo } from './metadata';

/**
 * The Media Player's engine: the Now Playing list and the sound itself.
 * Every skin - Din's own, Winamp's and Windows Media Player's - drives this
 * one object, so switching skins never interrupts the music.
 *
 * Sound runs through Web Audio: each of two decks (for crossfading) feeds a
 * preamp, the ten-band equalizer, bass boost, the "quiet mode" compressor,
 * balance and volume, and an analyser that the visualizations read.
 *
 * Streams from servers that don't send CORS headers can't go through Web
 * Audio (Chromium would play silence), so those play on a plain element
 * instead, without the equalizer or visualizations.
 */

export interface Track {
  /** Unique within the list, stable across reordering. */
  key: string;
  /** An absolute local path, or a stream URL. */
  location: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds, once known. */
  duration: number | null;
  video: boolean;
  /** It failed to play. */
  failed?: boolean;
}

export type PlayStatus = 'stopped' | 'playing' | 'paused';
export type RepeatMode = 'off' | 'all' | 'one';

export interface PlayerSettings {
  /** 0-1. */
  volume: number;
  muted: boolean;
  /** -1 (left) to 1 (right). */
  balance: number;
  shuffle: boolean;
  repeat: RepeatMode;
  eqOn: boolean;
  /** Winamp's "Auto": load a song's own preset (kept for skins that show it). */
  eqAuto: boolean;
  /** dB, ±12. */
  preamp: number;
  /** dB, ±12, one per EQ_BANDS. */
  bands: number[];
  /** Name of the preset last applied, if the bands are still it. */
  eqPreset: string | null;
  /** Play speed, 0.5-2. */
  rate: number;
  /** Seconds of crossfade between songs, 0 for none. */
  crossfade: number;
  /** Evens out loud and quiet passages (WMP's Quiet Mode). */
  quiet: boolean;
  /** dB of low-shelf boost (WMP's SRS TruBass). */
  bassBoost: number;
}

/** What the stream says about itself (Winamp's kbps/kHz/stereo). */
export interface StreamInfo {
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
}

export interface PlayerState extends PlayerSettings {
  queue: Track[];
  /** Index into queue of the current song, or -1. */
  current: number;
  status: PlayStatus;
  /** Loading or buffering. */
  waiting: boolean;
  error: string | null;
  info: StreamInfo;
  /** The current song plays without Web Audio (a stream without CORS). */
  direct: boolean;
  /** Fast forward or rewind in progress. */
  scan: 'ffwd' | 'rew' | null;
}

export interface PlaybackTime {
  position: number;
  duration: number;
}

const STORAGE_KEY = 'din:media-player:state';

const DEFAULT_SETTINGS: PlayerSettings = {
  volume: 0.8,
  muted: false,
  balance: 0,
  shuffle: false,
  repeat: 'off',
  eqOn: false,
  eqAuto: false,
  preamp: 0,
  bands: EQ_BANDS.map(() => 0),
  eqPreset: 'Flat',
  rate: 1,
  crossfade: 0,
  quiet: false,
  bassBoost: 0,
};

let nextKey = 1;
const newKey = () => `t${nextKey++}`;

/** A track for a location, titled from its name until its tags are read. */
export function makeTrack(location: string, hint: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'duration'>> = {}): Track {
  return {
    key: newKey(),
    location,
    title: hint.title || baseTitle(location),
    artist: hint.artist ?? '',
    album: hint.album ?? '',
    duration: hint.duration ?? null,
    video: isVideoLocation(location),
  };
}

/** "Artist - Title", as Winamp shows a song. */
export function displayTitle(track: Track): string {
  return track.artist ? `${track.artist} - ${track.title}` : track.title;
}

export function formatTime(seconds: number | null | undefined, showHours = false): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 || showHours ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

interface Deck {
  el: HTMLVideoElement;
  gain: GainNode | null;
  /** Which queue entry it holds. */
  key: string | null;
}

interface Saved {
  queue: Pick<Track, 'location' | 'title' | 'artist' | 'album' | 'duration'>[];
  current: number;
  position: number;
  settings: Partial<PlayerSettings>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class MusicEngine {
  private state: PlayerState;
  private time: PlaybackTime = { position: 0, duration: 0 };
  private listeners = new Set<() => void>();
  private timeListeners = new Set<() => void>();

  private ctx: AudioContext | null = null;
  private preampNode: GainNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private bassNode: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private quietIn: GainNode | null = null;
  private dryIn: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private volumeNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;

  private decks: Deck[] = [];
  private active = 0;
  private directEl: HTMLAudioElement | null = null;
  /** Hidden holder that keeps the decks in the document (see attachVideo). */
  private host: HTMLDivElement | null = null;

  private shuffleOrder: number[] = [];
  private failures = 0;
  private fading = false;
  private ticker: number | null = null;
  private scanTimer: number | null = null;
  private saveTimer: number | null = null;
  private restoredPosition = 0;
  private lastSavedPosition = 0;

  constructor() {
    const saved = this.load();
    const queue = (saved?.queue ?? []).map((t) => makeTrack(t.location, t));
    const current = saved && saved.current < queue.length ? saved.current : queue.length > 0 ? 0 : -1;
    this.restoredPosition = saved?.position ?? 0;
    this.state = {
      ...DEFAULT_SETTINGS,
      ...(saved?.settings ?? {}),
      queue,
      current,
      status: 'stopped',
      waiting: false,
      error: null,
      info: { bitrate: null, sampleRate: null, channels: null },
      direct: false,
      scan: null,
    };
    if (this.state.bands.length !== EQ_BANDS.length) this.state.bands = DEFAULT_SETTINGS.bands;
    this.reshuffle();
    for (const track of queue) void this.fillInfo(track.key);
  }

  // ---- store -------------------------------------------------------------

  getState = (): PlayerState => this.state;
  getTime = (): PlaybackTime => this.time;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeTime = (listener: () => void): (() => void) => {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  };

  private set(patch: Partial<PlayerState>, save = true): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
    if (save) this.scheduleSave();
  }

  private setTime(position: number, duration: number): void {
    if (this.time.position === position && this.time.duration === duration) return;
    this.time = { position, duration };
    for (const l of this.timeListeners) l();
  }

  get currentTrack(): Track | null {
    return this.state.queue[this.state.current] ?? null;
  }

  // ---- persistence -------------------------------------------------------

  private load(): Saved | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Saved;
      if (!Array.isArray(parsed.queue)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  save(): void {
    const s = this.state;
    const settings: PlayerSettings = {
      volume: s.volume, muted: s.muted, balance: s.balance, shuffle: s.shuffle, repeat: s.repeat,
      eqOn: s.eqOn, eqAuto: s.eqAuto, preamp: s.preamp, bands: s.bands, eqPreset: s.eqPreset,
      rate: s.rate, crossfade: s.crossfade, quiet: s.quiet, bassBoost: s.bassBoost,
    };
    const saved: Saved = {
      queue: s.queue
        .filter((t) => !t.location.startsWith('blob:'))
        .map(({ location, title, artist, album, duration }) => ({ location, title, artist, album, duration })),
      current: s.current,
      position: this.time.position,
      settings,
    };
    this.lastSavedPosition = this.time.position;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Storage full: the list just isn't remembered.
    }
  }

  // ---- audio graph -------------------------------------------------------

  private ensureGraph(): void {
    if (this.decks.length > 0) return;
    this.host = document.createElement('div');
    this.host.setAttribute('aria-hidden', 'true');
    this.host.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;';
    document.body.appendChild(this.host);

    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch {
      ctx = null;
    }
    this.ctx = ctx;
    if (ctx) {
      this.preampNode = ctx.createGain();
      this.filters = EQ_BANDS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.4;
        return f;
      });
      this.bassNode = ctx.createBiquadFilter();
      this.bassNode.type = 'lowshelf';
      this.bassNode.frequency.value = 120;
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -30;
      this.compressor.knee.value = 20;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.01;
      this.compressor.release.value = 0.3;
      this.quietIn = ctx.createGain();
      this.dryIn = ctx.createGain();
      this.panner = ctx.createStereoPanner();
      this.volumeNode = ctx.createGain();
      this.analyserNode = ctx.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.5;
      const splitter = ctx.createChannelSplitter(2);
      this.analyserL = ctx.createAnalyser();
      this.analyserR = ctx.createAnalyser();
      this.analyserL.fftSize = this.analyserR.fftSize = 1024;

      let node: AudioNode = this.preampNode;
      for (const f of this.filters) {
        node.connect(f);
        node = f;
      }
      node.connect(this.bassNode);
      // Quiet mode: the compressor path or the dry one, switched by gains.
      this.bassNode.connect(this.quietIn);
      this.bassNode.connect(this.dryIn);
      this.quietIn.connect(this.compressor);
      this.compressor.connect(this.panner);
      this.dryIn.connect(this.panner);
      this.panner.connect(this.volumeNode);
      this.volumeNode.connect(this.analyserNode);
      this.volumeNode.connect(splitter);
      splitter.connect(this.analyserL, 0);
      splitter.connect(this.analyserR, 1);
      this.analyserNode.connect(ctx.destination);
    }

    for (let i = 0; i < 2; i++) {
      const el = document.createElement('video');
      el.dataset.dinPlayer = '';
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.playsInline = true;
      el.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
      this.host.appendChild(el);
      let gain: GainNode | null = null;
      if (ctx) {
        const source = ctx.createMediaElementSource(el);
        gain = ctx.createGain();
        gain.gain.value = i === 0 ? 1 : 0;
        source.connect(gain);
        gain.connect(this.preampNode!);
      }
      const deck: Deck = { el, gain, key: null };
      this.wireDeck(deck);
      this.decks.push(deck);
    }
    this.applySettings();
  }

  private wireDeck(deck: Deck): void {
    const { el } = deck;
    const isActive = () => this.decks[this.active] === deck && !this.state.direct;
    el.addEventListener('ended', () => {
      if (isActive() && !this.fading) this.advance(false);
    });
    el.addEventListener('error', () => {
      if (isActive()) this.onError(deck.key, el.error);
    });
    el.addEventListener('waiting', () => isActive() && this.set({ waiting: true }, false));
    el.addEventListener('playing', () => {
      if (!isActive()) return;
      this.failures = 0;
      this.set({ waiting: false }, false);
    });
    el.addEventListener('loadedmetadata', () => {
      if (!isActive()) return;
      this.noteDuration(deck.key, el.duration);
      this.syncTime();
    });
    el.addEventListener('durationchange', () => isActive() && this.syncTime());
    el.addEventListener('seeked', () => isActive() && this.syncTime());
  }

  private get directElement(): HTMLAudioElement {
    if (!this.directEl) {
      const el = new Audio();
      el.dataset.dinPlayer = '';
      el.preload = 'auto';
      el.addEventListener('ended', () => this.state.direct && this.advance(false));
      el.addEventListener('error', () => {
        if (this.state.direct) this.onError(this.currentTrack?.key ?? null, el.error, true);
      });
      el.addEventListener('waiting', () => this.state.direct && this.set({ waiting: true }, false));
      el.addEventListener('playing', () => this.state.direct && this.set({ waiting: false }, false));
      el.addEventListener('loadedmetadata', () => this.state.direct && this.syncTime());
      this.directEl = el;
    }
    return this.directEl;
  }

  /** The element playing now. */
  private get media(): HTMLMediaElement | null {
    if (this.state.direct) return this.directEl;
    return this.decks[this.active]?.el ?? null;
  }

  private applySettings(): void {
    const s = this.state;
    const ctx = this.ctx;
    if (ctx && this.preampNode && this.volumeNode && this.panner) {
      const now = ctx.currentTime;
      const gainFor = (db: number) => 10 ** (db / 20);
      this.preampNode.gain.setTargetAtTime(s.eqOn ? gainFor(s.preamp) : 1, now, 0.02);
      this.filters.forEach((f, i) => f.gain.setTargetAtTime(s.eqOn ? clamp(s.bands[i] ?? 0, -EQ_MAX_DB, EQ_MAX_DB) : 0, now, 0.02));
      this.bassNode?.gain.setTargetAtTime(s.bassBoost, now, 0.02);
      this.quietIn?.gain.setTargetAtTime(s.quiet ? 1 : 0, now, 0.02);
      this.dryIn?.gain.setTargetAtTime(s.quiet ? 0 : 1, now, 0.02);
      this.panner.pan.setTargetAtTime(clamp(s.balance, -1, 1), now, 0.02);
      // Perceived loudness follows the square of the slider.
      this.volumeNode.gain.setTargetAtTime(s.muted ? 0 : s.volume * s.volume, now, 0.02);
    }
    for (const deck of this.decks) {
      deck.el.playbackRate = s.scan === 'ffwd' ? 5 : s.rate;
      deck.el.preservesPitch = true;
    }
    if (this.directEl) {
      this.directEl.volume = s.muted ? 0 : s.volume * s.volume;
      this.directEl.playbackRate = s.rate;
    }
  }

  /** The analyser after volume (mono mix), for visualizations; null before anything plays. */
  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  /** Left and right analysers, for stereo scopes and VU meters. */
  get stereoAnalysers(): [AnalyserNode, AnalyserNode] | null {
    return this.analyserL && this.analyserR ? [this.analyserL, this.analyserR] : null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  /**
   * Show the current song's video in `container`. Returns a function that
   * puts the element back in its hidden holder, in the same task, so it
   * keeps playing (a media element taken out of the document pauses).
   */
  attachVideo(container: HTMLElement): () => void {
    this.ensureGraph();
    let shown: HTMLVideoElement | null = null;
    const place = () => {
      const el = this.decks[this.active]?.el ?? null;
      if (shown === el) return;
      if (shown) this.host?.appendChild(shown);
      shown = el;
      if (el) container.appendChild(el);
    };
    place();
    const unsubscribe = this.subscribe(place);
    return () => {
      unsubscribe();
      if (shown) this.host?.appendChild(shown);
      shown = null;
    };
  }

  // ---- playback ----------------------------------------------------------

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = window.setInterval(() => this.tick(), 100);
  }

  private stopTicker(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  private syncTime(): void {
    const el = this.media;
    if (!el) return;
    const track = this.currentTrack;
    const duration = Number.isFinite(el.duration) ? el.duration : (track?.duration ?? 0);
    this.setTime(el.currentTime, duration);
  }

  private tick(): void {
    this.syncTime();
    if (Math.abs(this.time.position - this.lastSavedPosition) > 5) this.save();
    this.maybeCrossfade();
  }

  private noteDuration(key: string | null, duration: number): void {
    if (!key || !Number.isFinite(duration) || duration <= 0) return;
    const i = this.state.queue.findIndex((t) => t.key === key);
    if (i === -1 || this.state.queue[i].duration === duration) return;
    const queue = this.state.queue.slice();
    queue[i] = { ...queue[i], duration };
    this.set({ queue });
  }

  /** Read a queued song's tags and fill in its title, artist, album and length. */
  private async fillInfo(key: string): Promise<void> {
    const track = this.state.queue.find((t) => t.key === key);
    if (!track) return;
    const info = await trackInfo(track.location);
    const i = this.state.queue.findIndex((t) => t.key === key);
    if (i === -1) return;
    const t = this.state.queue[i];
    const patch: Partial<Track> = {};
    if (info.title && t.title === baseTitle(t.location)) patch.title = info.title;
    if (info.artist && !t.artist) patch.artist = info.artist;
    if (info.album && !t.album) patch.album = info.album;
    if (info.duration && !t.duration) patch.duration = info.duration;
    if (Object.keys(patch).length > 0) {
      const queue = this.state.queue.slice();
      queue[i] = { ...t, ...patch };
      this.set({ queue });
    }
    if (i === this.state.current) {
      this.set({ info: { bitrate: info.bitrate ?? null, sampleRate: info.sampleRate ?? null, channels: info.channels ?? null } }, false);
      void this.updateMediaSession();
    }
  }

  private async updateMediaSession(): Promise<void> {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    const track = this.currentTrack;
    if (!track) {
      ms.metadata = null;
      return;
    }
    const cover = await coverFor(track.location);
    if (this.currentTrack?.key !== track.key) return;
    try {
      ms.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: cover ? [{ src: cover }] : [],
      });
    } catch {
      // MediaMetadata rejects some artwork URLs; the title still matters more.
    }
  }

  private registerMediaSession(): void {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['stop', () => this.stop()],
      ['previoustrack', () => this.previous()],
      ['nexttrack', () => this.next()],
      ['seekto', (d) => d.seekTime != null && this.seek(d.seekTime)],
      ['seekbackward', (d) => this.seekBy(-(d.seekOffset ?? 10))],
      ['seekforward', (d) => this.seekBy(d.seekOffset ?? 10)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Unsupported action.
      }
    }
  }

  /** Load queue[index] onto the active deck (or the direct element). */
  private loadCurrent(autoplay: boolean, startAt = 0): void {
    const track = this.currentTrack;
    this.cancelFade();
    if (!track) {
      this.stopAll();
      return;
    }
    this.ensureGraph();
    this.registerMediaSession();
    const useDirect = isUrl(track.location) && this.directUrls.has(track.location);
    // Stop whatever else is sounding.
    for (const deck of this.decks) {
      deck.el.pause();
      if (deck.gain && this.ctx) deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    }
    this.directEl?.pause();

    const deck = this.decks[this.active];
    if (useDirect) {
      const el = this.directElement;
      el.src = track.location;
      el.currentTime = startAt;
      this.set({ direct: true, waiting: autoplay, error: null, info: { bitrate: null, sampleRate: null, channels: null } });
      this.applySettings();
      if (autoplay) void el.play().catch(() => {});
    } else {
      if (deck.gain && this.ctx) deck.gain.gain.setValueAtTime(1, this.ctx.currentTime);
      for (const other of this.decks) if (other !== deck && other.gain && this.ctx) other.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      deck.key = track.key;
      this.setSource(deck, track.location, () => {
        if (startAt > 0) {
          const at = startAt;
          deck.el.addEventListener('loadedmetadata', () => (deck.el.currentTime = at), { once: true });
        }
        if (autoplay) {
          void this.ctx?.resume();
          void deck.el.play().catch(() => {});
        }
      });
      this.set({ direct: false, waiting: autoplay, error: null, info: { bitrate: null, sampleRate: null, channels: null } });
      this.applySettings();
    }
    this.setTime(startAt, track.duration ?? 0);
    void this.fillInfo(track.key);
    void this.updateMediaSession();
  }

  /** Point a deck at a location, then go on, unless it's been given another meanwhile. */
  private setSource(deck: Deck, location: string, then: () => void): void {
    const key = deck.key;
    void mediaUrl(location).then(
      (url) => {
        if (deck.key !== key) return;
        deck.el.src = url;
        then();
      },
      () => {
        if (deck.key === key) this.onError(key, null);
      },
    );
  }

  /** Stream URLs that turned out to need the plain element. */
  private directUrls = new Set<string>();

  private onError(key: string | null, error: MediaError | null, direct = false): void {
    const track = this.currentTrack;
    if (!track || track.key !== key && !direct) return;
    // A stream without CORS: retry it outside Web Audio.
    if (!direct && isUrl(track.location) && !this.directUrls.has(track.location)) {
      this.directUrls.add(track.location);
      this.loadCurrent(this.state.status === 'playing');
      return;
    }
    const queue = this.state.queue.slice();
    queue[this.state.current] = { ...track, failed: true };
    this.failures++;
    const message = error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ? `Din can’t play “${track.title}”.`
      : `“${track.title}” couldn’t be played.`;
    this.set({ queue, error: message, waiting: false });
    if (this.state.status === 'playing' && this.failures < this.state.queue.length) {
      window.setTimeout(() => this.advance(false), 400);
    } else {
      this.stopAll();
      this.set({ status: 'stopped' });
    }
  }

  private stopAll(): void {
    for (const deck of this.decks) deck.el.pause();
    this.directEl?.pause();
    this.stopTicker();
    this.stopScan();
  }

  play(): void {
    this.stopScan();
    const track = this.currentTrack;
    if (!track) {
      if (this.state.queue.length > 0) this.playIndex(this.state.shuffle ? (this.shuffleOrder[0] ?? 0) : 0);
      return;
    }
    if (this.state.status === 'paused' && this.media && (this.state.direct || this.decks[this.active].key === track.key)) {
      void this.ctx?.resume();
      void this.media.play().catch(() => {});
      this.set({ status: 'playing' });
      this.startTicker();
      return;
    }
    if (this.state.status === 'playing') {
      // Winamp: Play while playing starts the song over.
      this.seek(0);
      return;
    }
    const startAt = this.restoredPosition;
    this.restoredPosition = 0;
    this.set({ status: 'playing' });
    this.loadCurrent(true, startAt);
    this.startTicker();
  }

  pause(): void {
    this.stopScan();
    if (this.state.status !== 'playing') return;
    this.cancelFade();
    this.media?.pause();
    this.set({ status: 'paused', waiting: false });
    this.stopTicker();
    this.syncTime();
    this.save();
  }

  /** Play/pause, as one button. */
  toggle(): void {
    if (this.state.status === 'playing') this.pause();
    else this.play();
  }

  stop(): void {
    this.cancelFade();
    this.stopAll();
    const el = this.media;
    if (el) {
      el.pause();
      try {
        el.currentTime = 0;
      } catch {
        // Not seekable (a stream).
      }
    }
    this.restoredPosition = 0;
    this.set({ status: 'stopped', waiting: false });
    this.setTime(0, this.time.duration);
  }

  playIndex(index: number): void {
    if (index < 0 || index >= this.state.queue.length) return;
    this.restoredPosition = 0;
    this.set({ current: index, status: 'playing', error: null });
    if (this.state.shuffle && this.shuffleOrder[0] !== index) this.reshuffle();
    this.loadCurrent(true);
    this.startTicker();
  }

  /** Make queue[index] current without playing it. */
  select(index: number): void {
    if (index < 0 || index >= this.state.queue.length) return;
    const playing = this.state.status === 'playing';
    this.restoredPosition = 0;
    this.set({ current: index, error: null, status: playing ? 'playing' : 'stopped' });
    if (playing) this.loadCurrent(true);
    else {
      this.stopAll();
      this.setTime(0, this.currentTrack?.duration ?? 0);
      void this.fillInfo(this.state.queue[index].key);
    }
  }

  /** Which song follows (or precedes) the current one, or -1. */
  private neighbor(direction: 1 | -1, manual: boolean): number {
    const { queue, current, shuffle, repeat } = this.state;
    if (queue.length === 0) return -1;
    if (!manual && repeat === 'one') return current;
    const wrap = repeat === 'all' || manual;
    if (shuffle) {
      const pos = this.shuffleOrder.indexOf(current);
      const next = pos + direction;
      if (next >= 0 && next < this.shuffleOrder.length) return this.shuffleOrder[next];
      if (!wrap) return -1;
      if (direction === 1) {
        this.reshuffle(-1);
        return this.shuffleOrder[0];
      }
      return this.shuffleOrder[this.shuffleOrder.length - 1];
    }
    const next = current + direction;
    if (next >= 0 && next < queue.length) return next;
    if (!wrap) return -1;
    return direction === 1 ? 0 : queue.length - 1;
  }

  private advance(manual: boolean): void {
    const next = this.neighbor(1, manual);
    if (next === -1) {
      this.stop();
      this.set({ current: this.state.queue.length > 0 ? (this.state.shuffle ? this.shuffleOrder[0] : 0) : -1 });
      return;
    }
    if (this.state.status === 'playing' || !manual) this.playIndex(next);
    else this.select(next);
  }

  next(): void {
    this.advance(true);
  }

  previous(): void {
    if (this.time.position > 3 && this.state.status === 'playing') {
      this.seek(0);
      return;
    }
    const prev = this.neighbor(-1, true);
    if (prev === -1) return;
    if (this.state.status === 'playing') this.playIndex(prev);
    else this.select(prev);
  }

  seek(seconds: number): void {
    const el = this.media;
    if (!el || this.state.status === 'stopped') {
      this.restoredPosition = Math.max(0, seconds);
      this.setTime(Math.max(0, seconds), this.time.duration);
      return;
    }
    const duration = Number.isFinite(el.duration) ? el.duration : this.time.duration;
    try {
      el.currentTime = clamp(seconds, 0, duration > 0 ? duration - 0.05 : seconds);
    } catch {
      // Not seekable.
    }
    this.syncTime();
  }

  seekBy(delta: number): void {
    this.seek(this.time.position + delta);
  }

  /** WMP's fast forward: play at 5×, until Play or Pause. */
  fastForward(): void {
    if (this.state.status !== 'playing') this.play();
    this.stopScan();
    this.set({ scan: 'ffwd' }, false);
    this.applySettings();
  }

  /** WMP's rewind: step backwards through the song until Play or Pause. */
  rewind(): void {
    if (this.state.status === 'stopped') return;
    this.stopScan();
    this.set({ scan: 'rew' }, false);
    this.scanTimer = window.setInterval(() => {
      if (this.time.position <= 0.5) this.stopScan();
      else this.seekBy(-1.5);
    }, 100);
  }

  private stopScan(): void {
    if (this.scanTimer !== null) window.clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.state.scan) {
      this.set({ scan: null }, false);
      this.applySettings();
    }
  }

  // ---- crossfade ---------------------------------------------------------

  private fadeTimer: number | null = null;

  private maybeCrossfade(): void {
    const s = this.state;
    if (this.fading || s.crossfade <= 0 || s.status !== 'playing' || s.direct || !this.ctx) return;
    const { position, duration } = this.time;
    if (!(duration > s.crossfade * 2) || duration - position > s.crossfade) return;
    const next = this.neighbor(1, false);
    if (next === -1 || next === s.current) return;
    const track = s.queue[next];
    if (isUrl(track.location)) return;
    const from = this.decks[this.active];
    const toIndex = 1 - this.active;
    const to = this.decks[toIndex];
    const now = this.ctx.currentTime;
    const length = Math.max(0.5, duration - position);
    this.fading = true;
    to.key = track.key;
    this.setSource(to, track.location, () => void to.el.play().catch(() => {}));
    to.gain!.gain.cancelScheduledValues(now);
    to.gain!.gain.setValueAtTime(0, now);
    to.gain!.gain.linearRampToValueAtTime(1, now + length);
    from.gain!.gain.cancelScheduledValues(now);
    from.gain!.gain.setValueAtTime(from.gain!.gain.value, now);
    from.gain!.gain.linearRampToValueAtTime(0, now + length);
    this.active = toIndex;
    this.set({ current: next, error: null });
    if (s.shuffle && !this.shuffleOrder.includes(next)) this.reshuffle();
    this.applySettings();
    void this.fillInfo(track.key);
    void this.updateMediaSession();
    this.fadeTimer = window.setTimeout(() => {
      from.el.pause();
      this.fading = false;
      this.fadeTimer = null;
    }, length * 1000 + 100);
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    if (this.fading) {
      for (let i = 0; i < this.decks.length; i++) if (i !== this.active) this.decks[i].el.pause();
    }
    this.fading = false;
  }

  // ---- the list ----------------------------------------------------------

  private reshuffle(first = this.state.current): void {
    const indices = this.state.queue.map((_, i) => i).filter((i) => i !== first);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    this.shuffleOrder = first >= 0 && first < this.state.queue.length ? [first, ...indices] : indices;
  }

  /** Replace the list and (by default) start playing it. */
  setQueue(tracks: Track[], start = 0, autoplay = true): void {
    this.stopAll();
    this.set({ queue: tracks, current: tracks.length > 0 ? clamp(start, 0, tracks.length - 1) : -1, status: 'stopped', error: null });
    this.reshuffle();
    for (const t of tracks) void this.fillInfo(t.key);
    if (tracks.length === 0) {
      this.setTime(0, 0);
      return;
    }
    if (autoplay) this.playIndex(this.state.current);
    else this.setTime(0, this.currentTrack?.duration ?? 0);
  }

  /** Add songs to the end of the list (or after the current one). */
  enqueue(tracks: Track[], options: { next?: boolean; play?: boolean } = {}): void {
    if (tracks.length === 0) return;
    const queue = this.state.queue.slice();
    const at = options.next && this.state.current >= 0 ? this.state.current + 1 : queue.length;
    queue.splice(at, 0, ...tracks);
    const current = this.state.current >= at ? this.state.current + tracks.length : this.state.current;
    this.set({ queue, current: current === -1 ? at : current });
    this.reshuffle();
    for (const t of tracks) void this.fillInfo(t.key);
    if (options.play) this.playIndex(at);
  }

  remove(keys: Iterable<string>): void {
    const drop = new Set(keys);
    const currentKey = this.currentTrack?.key;
    const queue = this.state.queue.filter((t) => !drop.has(t.key));
    let current = queue.findIndex((t) => t.key === currentKey);
    if (current === -1 && currentKey !== undefined) {
      // The current song went: stop, and point at whatever took its place.
      this.stop();
      current = Math.min(this.state.current, queue.length - 1);
    }
    this.set({ queue, current });
    this.reshuffle();
  }

  /** Keep only these songs (Winamp's Crop). */
  crop(keys: Iterable<string>): void {
    const keep = new Set(keys);
    this.remove(this.state.queue.filter((t) => !keep.has(t.key)).map((t) => t.key));
  }

  /** Remove songs that failed to play or whose files are gone. */
  removeFailed(): void {
    this.remove(this.state.queue.filter((t) => t.failed).map((t) => t.key));
  }

  clear(): void {
    this.stop();
    this.set({ queue: [], current: -1, error: null });
    this.shuffleOrder = [];
    this.setTime(0, 0);
    void this.updateMediaSession();
  }

  /** Move the songs `keys` so they sit before position `to` (in the list as it is). */
  move(keys: string[], to: number): void {
    const moving = new Set(keys);
    const currentKey = this.currentTrack?.key;
    const picked = this.state.queue.filter((t) => moving.has(t.key));
    const before = this.state.queue.slice(0, to).filter((t) => !moving.has(t.key));
    const after = this.state.queue.slice(to).filter((t) => !moving.has(t.key));
    const queue = [...before, ...picked, ...after];
    this.set({ queue, current: queue.findIndex((t) => t.key === currentKey) });
    this.reshuffle();
  }

  sort(by: 'title' | 'artist' | 'album' | 'location' | 'duration' | 'reverse' | 'random'): void {
    const currentKey = this.currentTrack?.key;
    let queue = this.state.queue.slice();
    if (by === 'reverse') queue.reverse();
    else if (by === 'random') {
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
    } else {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      queue = queue.sort((a, b) =>
        by === 'duration' ? (a.duration ?? 0) - (b.duration ?? 0) : collator.compare(String(a[by] ?? ''), String(b[by] ?? '')),
      );
    }
    this.set({ queue, current: queue.findIndex((t) => t.key === currentKey) });
    this.reshuffle();
  }

  // ---- settings ----------------------------------------------------------

  private setSettings(patch: Partial<PlayerSettings>): void {
    this.set(patch);
    this.applySettings();
  }

  setVolume(volume: number): void {
    this.setSettings({ volume: clamp(volume, 0, 1), muted: false });
  }

  setMuted(muted: boolean): void {
    this.setSettings({ muted });
  }

  setBalance(balance: number): void {
    this.setSettings({ balance: Math.abs(balance) < 0.04 ? 0 : clamp(balance, -1, 1) });
  }

  setShuffle(shuffle: boolean): void {
    this.set({ shuffle });
    this.reshuffle();
  }

  setRepeat(repeat: RepeatMode): void {
    this.set({ repeat });
  }

  /** Off → all → one → off, as WMP's and Din's repeat button goes. */
  cycleRepeat(): void {
    this.setRepeat(this.state.repeat === 'off' ? 'all' : this.state.repeat === 'all' ? 'one' : 'off');
  }

  setEqOn(eqOn: boolean): void {
    this.setSettings({ eqOn });
  }

  setEqAuto(eqAuto: boolean): void {
    this.set({ eqAuto });
  }

  setBand(index: number, db: number): void {
    const bands = this.state.bands.slice();
    bands[index] = clamp(db, -EQ_MAX_DB, EQ_MAX_DB);
    this.setSettings({ bands, eqPreset: null, eqOn: true });
  }

  setPreamp(db: number): void {
    this.setSettings({ preamp: clamp(db, -EQ_MAX_DB, EQ_MAX_DB), eqPreset: null });
  }

  applyPreset(preset: { name: string; preamp: number; bands: number[] }): void {
    this.setSettings({
      preamp: clamp(preset.preamp, -EQ_MAX_DB, EQ_MAX_DB),
      bands: EQ_BANDS.map((_, i) => clamp(preset.bands[i] ?? 0, -EQ_MAX_DB, EQ_MAX_DB)),
      eqPreset: preset.name,
      eqOn: true,
    });
  }

  setRate(rate: number): void {
    this.setSettings({ rate: clamp(Math.round(rate * 20) / 20, 0.5, 2) });
  }

  setCrossfade(seconds: number): void {
    this.set({ crossfade: clamp(Math.round(seconds), 0, 10) });
  }

  setQuiet(quiet: boolean): void {
    this.setSettings({ quiet });
  }

  setBassBoost(db: number): void {
    this.setSettings({ bassBoost: clamp(db, 0, 12) });
  }

  /** Forget the error banner. */
  dismissError(): void {
    this.set({ error: null }, false);
  }

  /** The window closed: stop, remembering where the song was. */
  shutdown(): void {
    this.cancelFade();
    this.stopAll();
    this.syncTime();
    // Play picks the song up from here (see play()).
    this.restoredPosition = this.time.position;
    this.save();
    for (const deck of this.decks) deck.key = null;
    this.set({ status: 'stopped', waiting: false }, false);
    void this.ctx?.suspend();
  }
}

/** The one engine every Media Player window and skin drives. */
export const player = new MusicEngine();
export type { MusicEngine };

/** Longest edge of the cover sent to the desktop's media controls. */
const ARTWORK_SIZE = 256;

/** A cover as a small data: URL, the only kind the desktop can load from an app. */
async function artworkDataUrl(src: string): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const scale = Math.min(1, ARTWORK_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

/** What's playing, in Din's media controls (the volume menu's) and for the media keys. */
export function connectMediaSession(din: Din): () => void {
  let cover: { location: string; url: string | null } | null = null;
  let listed = false;
  let sent = '';
  const update = () => {
    const { status } = player.getState();
    const track = player.currentTrack;
    // Once it's been playing it stays: Next while paused stops the player
    // (as Winamp does), and its controls mustn't vanish for that.
    let session: MediaSession | null = null;
    if (!track || (status === 'stopped' && !listed)) {
      listed = false;
    } else {
      listed = true;
      if (cover?.location !== track.location) {
        const location = track.location;
        cover = { location, url: null };
        void coverFor(location).then(async (src) => {
          const url = src && (await artworkDataUrl(src));
          if (cover?.location !== location || !url) return;
          cover = { location, url };
          update();
        });
      }
      session = {
        title: track.title,
        subtitle: track.artist || 'Media Player',
        artwork: cover.url,
        playing: status === 'playing',
        canPlay: true,
        canPrevious: true,
        canNext: true,
      };
    }
    const json = JSON.stringify(session);
    if (json === sent) return;
    sent = json;
    din.media.setSession(session);
  };
  const unsubscribe = player.subscribe(update);
  const offAction = din.media.onAction((action) => {
    if (action === 'play') player.play();
    else if (action === 'pause') player.pause();
    else if (action === 'nexttrack') player.next();
    else player.previous();
  });
  update();
  return () => {
    unsubscribe();
    offAction();
    din.media.setSession(null);
  };
}

/** Subscribe a component to part of the player's state. */
export function usePlayer<T>(selector: (state: PlayerState) => T): T {
  return useSyncExternalStore(player.subscribe, () => selector(player.getState()));
}

/** Position and duration, updated ten times a second while playing. */
export function usePlaybackTime(): PlaybackTime {
  return useSyncExternalStore(player.subscribeTime, player.getTime);
}

/**
 * Din's voice: text read aloud, on this computer.
 *
 * The main process makes the sound (`window.dinos.speech`, electron/
 * speech.mts: Kokoro, the `speech` optional feature); the desktop plays it,
 * one utterance at a time for all of Din, so the assistant and an app never
 * talk over each other. What's to be said waits its turn in one queue;
 * each utterance is cut into sentences (src/shared/speakable.ts), and the
 * next piece is made while one plays, so speech starts within a second or
 * two whatever its length.
 *
 * Speakers: the assistant (its spoken replies and Read Aloud, the desktop's
 * own and the Assistant app's), apps' `speechSynthesis` (DinAppFrame), and
 * `din speak`. Each utterance has an owner, so an app's cancel() takes back
 * only its own. Anything that opens the microphone for the user's voice
 * (holdMedia: dictation, Record Audio) stops it: they're talking now.
 */

import { getFeaturesBridge } from '@/lib/features';
import { speechPieces } from '@/shared/speakable';

export interface SpeechVoice {
  /** Kokoro's name for it ("af_bella"). */
  id: string;
  /** A person's name for it ("Bella"). */
  name: string;
  /** BCP 47 ("en-US"). */
  lang: string;
}

export interface SpeechBridge {
  available(): Promise<boolean>;
  voices(): Promise<SpeechVoice[]>;
  /** A WAV file of `text` read aloud. */
  synthesize(text: string, voice?: string, rate?: number): Promise<Uint8Array>;
  cancel(): Promise<void>;
  /** Load the voice ahead of what's to be said. */
  prepare(): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    speech?: SpeechBridge;
  }
}

/** Why speech stopped short, SpeechSynthesisErrorEvent's words for it. */
export type SpeechError = 'canceled' | 'interrupted' | 'synthesis-unavailable' | 'synthesis-failed' | 'audio-hardware';

export interface Utterance {
  text: string;
  /** A voice's id; the user's choice (Settings → Assistant) if unset or unknown. */
  voice?: string;
  /** 0.5 to 2. */
  rate?: number;
  /** 0 to 1. */
  volume?: number;
  /** Whose it is, for cancelSpeech(owner). */
  owner: unknown;
  /** What it reads, for a Read Aloud button to know it's its own. */
  key?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: SpeechError, message: string) => void;
}

export interface SpeechState {
  /** The voice is installed. */
  available: boolean;
  voices: SpeechVoice[];
  /** What's being said (or made ready to say) now. */
  current: { owner: unknown; key: string | null; paused: boolean } | null;
  /** Utterances waiting after it. */
  pending: number;
}

let state: SpeechState = { available: false, voices: [], current: null, pending: 0 };
const listeners = new Set<() => void>();

function setState(patch: Partial<SpeechState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getSpeechState(): SpeechState {
  return state;
}

/** For useSyncExternalStore. */
export function subscribeSpeech(listener: () => void): () => void {
  ensureWatching();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function bridge(): SpeechBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.speech;
}

/** Whether there's a voice to ask at all (the Electron shell). */
export function hasSpeechBridge(): boolean {
  return Boolean(bridge());
}

/** Why speech can't start on DinOS before its optional feature is installed. */
export const SPEECH_NEEDS_FEATURE = 'Speech isn’t installed yet. Install Speech in Settings → Optional Features.';

let watching = false;
let refreshing: Promise<void> | null = null;

/** Asks main again whether the voice is installed, and which voices it has. */
export function refreshSpeech(): Promise<void> {
  const api = bridge();
  if (!api) return Promise.resolve();
  refreshing ??= Promise.all([api.available(), api.voices()])
    .then(([available, voices]) => {
      if (available !== state.available || JSON.stringify(voices) !== JSON.stringify(state.voices)) {
        setState({ available, voices });
      }
    })
    .catch(() => {})
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Follows the optional feature, so the voice is there the moment it's installed. */
function ensureWatching(): void {
  if (watching || !bridge()) return;
  watching = true;
  void refreshSpeech();
  getFeaturesBridge()?.onChanged(() => void refreshSpeech());
}

let defaultVoice = '';

/** Settings → Assistant's voice, kept current by the desktop. */
export function setSpeechVoice(voice: string): void {
  if (voice === defaultVoice) return;
  defaultVoice = voice;
  // Apps' speechSynthesis says which voice is the default.
  for (const listener of listeners) listener();
}

/** The user's voice, as a voice that's there (the first, if theirs isn't). */
export function defaultSpeechVoice(): string {
  const voices = state.voices;
  return voices.some((v) => v.id === defaultVoice) ? defaultVoice : (voices[0]?.id ?? '');
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

interface Playing {
  utterance: Utterance;
  /** Set when it's cancelled; the loop stops at its next step. */
  stopped: boolean;
  source: AudioBufferSourceNode | null;
  /** Resolves the wait for the piece playing now. */
  finishPiece: (() => void) | null;
  paused: boolean;
}

const queue: Utterance[] = [];
let playing: Playing | null = null;
let context: AudioContext | null = null;
/** What's being played, for speechOutputLevel. */
let analyser: AnalyserNode | null = null;
const levelBuffer = new Float32Array(1024);

function audio(): AudioContext {
  if (!context) {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
  }
  return context;
}

/**
 * How loud Din's voice is playing right now (RMS, 0 to 1), 0 while it's
 * quiet: dictation tells the user talking over it from its echo.
 */
export function speechOutputLevel(): number {
  if (!analyser || !playing?.source || playing.paused) return 0;
  analyser.getFloatTimeDomainData(levelBuffer);
  let power = 0;
  for (let i = 0; i < levelBuffer.length; i++) power += levelBuffer[i]! * levelBuffer[i]!;
  return Math.sqrt(power / levelBuffer.length);
}

/** Load the voice now, ahead of what's to be said (a call starting), so the first words come sooner. */
export function prepareSpeech(): void {
  if (state.available) void bridge()?.prepare().catch(() => {});
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

function publish(): void {
  setState({
    current: playing ? { owner: playing.utterance.owner, key: playing.utterance.key ?? null, paused: playing.paused } : null,
    pending: queue.length,
  });
}

/** Say `utterance` once what's ahead of it has been said. */
export function speak(utterance: Utterance): void {
  ensureWatching();
  queue.push(utterance);
  publish();
  if (!playing) void next();
}

/**
 * Stop and take back what `owner` asked to say (everything, without an
 * owner): the utterance being said ends 'interrupted', those waiting
 * 'canceled'.
 */
export function cancelSpeech(owner?: unknown): void {
  const mine = (u: Utterance) => owner === undefined || u.owner === owner;
  const dropped = queue.filter(mine);
  for (let i = queue.length - 1; i >= 0; i--) if (mine(queue[i]!)) queue.splice(i, 1);
  for (const u of dropped) u.onError?.('canceled', 'Canceled');
  if (playing && mine(playing.utterance)) {
    const p = playing;
    p.stopped = true;
    try {
      p.source?.stop();
    } catch {
      // Not started yet.
    }
    p.finishPiece?.();
    // Drops what's waiting to be made; the piece being made is short.
    void bridge()?.cancel().catch(() => {});
  }
  publish();
}

/** Pause what `owner` is saying now (anyone's, without an owner). */
export function pauseSpeech(owner?: unknown): void {
  if (!playing || playing.paused || (owner !== undefined && playing.utterance.owner !== owner)) return;
  playing.paused = true;
  void context?.suspend();
  publish();
}

export function resumeSpeech(owner?: unknown): void {
  if (!playing || !playing.paused || (owner !== undefined && playing.utterance.owner !== owner)) return;
  playing.paused = false;
  void context?.resume();
  publish();
}

/** Whether `key` is what's being said now. */
export function isSpeaking(key: string): boolean {
  return state.current?.key === key;
}

async function next(): Promise<void> {
  const utterance = queue.shift();
  if (!utterance) {
    playing = null;
    publish();
    return;
  }
  const p: Playing = { utterance, stopped: false, source: null, finishPiece: null, paused: false };
  playing = p;
  publish();
  try {
    await say(p);
    if (p.stopped) utterance.onError?.('interrupted', 'Interrupted');
    else utterance.onEnd?.();
  } catch (error) {
    if (p.stopped) utterance.onError?.('interrupted', 'Interrupted');
    else utterance.onError?.(state.available ? 'synthesis-failed' : 'synthesis-unavailable', cleanError(error));
  }
  if (p.paused) void context?.resume();
  void next();
}

async function say(p: Playing): Promise<void> {
  const api = bridge();
  if (!api) throw new Error('Speech isn’t available here');
  if (!state.available) await refreshSpeech();
  if (!state.available) throw new Error(SPEECH_NEEDS_FEATURE);
  const { utterance } = p;
  const voice = state.voices.some((v) => v.id === utterance.voice) ? utterance.voice! : defaultSpeechVoice();
  const rate = Math.min(2, Math.max(0.5, utterance.rate ?? 1));
  const pieces = speechPieces(utterance.text);
  const ctx = audio();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const make = (text: string) =>
    api.synthesize(text, voice, rate).then((wav) => ctx.decodeAudioData(new Uint8Array(wav).buffer));
  // Each piece is made while the one before plays.
  let coming = pieces.length > 0 ? make(pieces[0]!) : null;
  coming?.catch(() => {});
  let started = false;
  for (let i = 0; i < pieces.length && coming; i++) {
    const buffer = await coming;
    if (p.stopped) return;
    coming = i + 1 < pieces.length ? make(pieces[i + 1]!) : null;
    coming?.catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, utterance.volume ?? 1));
    source.connect(gain).connect(ctx.destination);
    if (analyser) gain.connect(analyser);
    p.source = source;
    await new Promise<void>((resolve) => {
      p.finishPiece = resolve;
      source.onended = () => resolve();
      source.start();
      if (!started) {
        started = true;
        utterance.onStart?.();
      }
    });
    p.source = null;
    p.finishPiece = null;
    if (p.stopped) return;
  }
}

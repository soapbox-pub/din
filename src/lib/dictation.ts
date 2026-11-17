/**
 * Dictation: speak, and the words are typed where you were typing.
 *
 * One session at a time, started by Super+H (into whatever has focus), by
 * holding Super+A (into the assistant's prompt) or by a mic button (into
 * its own field). The shell records the microphone, and whisper.cpp turns
 * it into text in the main process (`window.dinos.dictation`, see
 * electron/dictation.mts).
 *
 * The recording is cut into segments, a sentence or so each, at the pauses
 * between them (or, in a long run of speech, at a gap between words), and
 * each is transcribed on its own, with what was said before it as context,
 * and typed as soon as it's done. Short pieces keep whisper fast and well
 * inside its 30-second window, where a whole long recording came back
 * garbled, or empty. While a segment is heard, its words so far are shown
 * in the field itself where the target can take them back (Din's own text
 * fields, apps' SpeechRecognition with interim results), and in the
 * overlay (DictationOverlay) everywhere.
 *
 * A toggled session ends by itself after a longer pause; a held one
 * (Super+A) when the key comes up.
 *
 * Targets are found from the shell's focus: text fields get the text as if
 * typed (undo and React's onChange keep working), web pages through
 * Electron, and the components that put their own focus somewhere a field
 * can't reach (the Terminal, native app windows) register a target for
 * their element with registerDictationTarget. Those two get each segment
 * once it's final.
 */
import { getAudioBridge } from '@/lib/audio';
import { getFeaturesBridge } from '@/lib/features';
import { notifyWithFeature } from '@/lib/featureNotifications';
import { holdMedia } from '@/lib/mediaPause';
import { guestId, isGuestElement } from '@/platform/guest';
import { dictationTyper } from '@/shared/dictationField';
import { speechOutputLevel } from '@/lib/speech';

/** Why dictation can't start on DinOS before its optional feature is installed. */
export const DICTATION_NEEDS_FEATURE = 'Dictation isn’t installed yet. Install Dictation & transcripts in Settings → Optional Features.';
const DICTATION_DOWNLOADING = 'Dictation hasn’t finished downloading';
const DICTATION_WAITING = 'Dictation downloads when this computer is online';
const DICTATION_LIVE = 'Dictation downloads once DinOS is installed. To get it now, install Dictation & transcripts in Settings → Optional Features.';

/** Whether dictation stopped for not being on this computer (yet), for SpeechRecognition's error code. */
export function isDictationMissing(message: string | null): boolean {
  if (!message) return false;
  return (
    message === 'Dictation isn’t available here' ||
    message === DICTATION_NEEDS_FEATURE ||
    message === DICTATION_WAITING ||
    message === DICTATION_LIVE ||
    message.startsWith(DICTATION_DOWNLOADING)
  );
}

/**
 * Why dictation isn't here, from its optional feature: on its way (it comes
 * with the computer), waiting for a connection, held back on a live USB
 * stick, or removed.
 */
async function missingReason(): Promise<string> {
  const features = getFeaturesBridge();
  if (!features) return 'Dictation isn’t available here';
  const state = await features.state().catch(() => null);
  // Off DinOS it isn't one: distributions don't package whisper.cpp's programs.
  if (state?.source === 'packages') return 'Dictation isn’t available here';
  const feature = state?.features.find((f) => f.id === 'dictation');
  if (!state || !feature) return DICTATION_NEEDS_FEATURE;
  if (feature.busy?.action === 'install') {
    const progress = feature.busy.progress;
    return progress !== null ? `${DICTATION_DOWNLOADING} (${Math.round(progress * 100)}%)` : DICTATION_DOWNLOADING;
  }
  if (!feature.wanted) return DICTATION_NEEDS_FEATURE;
  if (state.live) return DICTATION_LIVE;
  return feature.error ? DICTATION_WAITING : DICTATION_DOWNLOADING;
}

export interface DictationBridge {
  available(): Promise<boolean>;
  prepare(): Promise<void>;
  /** The text in `pcm`; `prompt` is what was said before it. */
  transcribe(pcm: Uint8Array, prompt?: string): Promise<string>;
  insertIntoGuest(wcId: number, text: string): Promise<boolean>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    dictation?: DictationBridge;
  }
}

/** Where dictated text goes. */
export interface DictationTarget {
  /** Type `text`, a segment heard to the end. Later segments come with a space before them. */
  insert(text: string): void | Promise<void>;
  /**
   * For targets that can take words back: type `final` (heard to the end,
   * '' for nothing new) and show `interim`, what's heard after it so far,
   * in place of the interim text shown before. Used instead of insert.
   */
  update?(final: string, interim: string): void | Promise<void>;
  /** What it types into, for a mic button to know the session is its own. */
  owner?: unknown;
}

export type DictationStatus = 'idle' | 'listening' | 'transcribing' | 'error';

export interface DictationState {
  status: DictationStatus;
  /** The microphone's level, 0-1. */
  level: number;
  /** What's been heard and isn't typed yet. */
  preview: string;
  /** Why it stopped, when status is 'error'. */
  error: string | null;
  /** Whether it ends when a held key comes up, rather than after a pause. */
  held: boolean;
  /** Whether the overlay shows it; an app listening without end shows that it does itself. */
  overlay: boolean;
  /** The user is speaking now (until a breath's pause): speechstart and speechend for apps. */
  voiced: boolean;
  owner: unknown;
}

const SAMPLE_RATE = 16_000;
/** A toggled session ends after this much quiet once speech was heard. */
const PAUSE_MS = 3_000;
/** And gives up after this long hearing nothing at all. */
const NOTHING_HEARD_MS = 10_000;
/** Sessions stop here. */
const MAX_MS = 30 * 60_000;
/** A segment ends after this much quiet: a breath between sentences. */
const SEGMENT_PAUSE_MS = 700;
/** Past this long, a segment ends at the next gap between words… */
const SEGMENT_SOFT_MS = 12_000;
/** …and here regardless. */
const SEGMENT_MAX_MS = 20_000;
/** Of the quiet before a segment's speech, this much is kept. */
const LEAD_SAMPLES = SAMPLE_RATE / 2;
/** Less speech than this is a cough or a click, not words. */
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE / 4;
/** The interim text is redone with this much new audio. */
const PREVIEW_STEP_SAMPLES = SAMPLE_RATE / 2;
/** How much of what was said goes along as context. */
const CONTEXT_CHARS = 400;
/** Errors stay up this long. */
const ERROR_MS = 4_000;

const IDLE: DictationState = { status: 'idle', level: 0, preview: '', error: null, held: false, overlay: true, voiced: false, owner: null };

let state: DictationState = IDLE;
const listeners = new Set<() => void>();

function setState(patch: Partial<DictationState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getDictationState(): DictationState {
  return state;
}

/** For useSyncExternalStore. */
export function subscribeDictation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function bridge(): DictationBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.dictation;
}

/** Whether there's a place to send the audio at all (the Electron shell). */
export function hasDictationBridge(): boolean {
  return Boolean(bridge());
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** whisper's notes about the audio ("[BLANK_AUDIO]", "(music)"), which aren't words. */
function cleanTranscript(text: string): string {
  const cleaned = text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[([*].*[)\]*]$/.test(cleaned) ? '' : cleaned;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const registered = new WeakMap<Element, (text: string) => void | Promise<void>>();

/**
 * Dictation into `element` or anything in it goes to `insert`. For
 * components whose focus is a stand-in for somewhere else (a terminal's
 * pty, a native app). Returns an unregister fn.
 */
export function registerDictationTarget(element: Element, insert: (text: string) => void | Promise<void>): () => void {
  registered.set(element, insert);
  return () => {
    if (registered.get(element) === insert) registered.delete(element);
  };
}

type TextField = HTMLTextAreaElement | HTMLInputElement;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

function isTextField(element: Element | null): element is TextField {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  return (
    element instanceof HTMLInputElement &&
    TEXT_INPUT_TYPES.has(element.type) &&
    !element.readOnly &&
    !element.disabled
  );
}

/**
 * Type into a text field or editable element as if the keyboard had, the
 * words shown as they're heard (src/shared/dictationField.ts).
 */
export function elementTarget(element: TextField | HTMLElement): DictationTarget {
  const type = dictationTyper(element);
  return {
    owner: element,
    insert: (text) => type(text.trim(), ''),
    update: type,
  };
}

/** Where the keyboard is now, or null when nothing there takes text. */
export function focusedDictationTarget(): DictationTarget | null {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  for (let el: Element | null = active; el; el = el.parentElement) {
    const insert = registered.get(el);
    if (insert) return { owner: el, insert };
  }
  if (isGuestElement(active)) {
    const api = bridge();
    const wcId = guestId(active);
    if (wcId === null || !api) return null;
    return {
      owner: active,
      insert: async (text) => {
        await api.insertIntoGuest(wcId, text);
      },
    };
  }
  if (isTextField(active) || (active instanceof HTMLElement && active.isContentEditable)) {
    return elementTarget(active as TextField | HTMLElement);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** A stretch of the recording, transcribed on its own. */
interface Segment {
  chunks: Int16Array[];
  samples: number;
  /** Whether there's speech in it. */
  heard: boolean;
  /** Its words so far, for the interim text. */
  preview: string;
  previewedSamples: number;
}

interface Session {
  target: DictationTarget;
  held: boolean;
  /**
   * Whether the target is shown the words as they're heard. Each look is a
   * whole transcription of the stretch so far, back to back while the user
   * talks, which keeps the GPU busy (and the screen, which shares it,
   * stuttering); a target that only wants what's final is spared them.
   */
  interim: boolean;
  stream: MediaStream | null;
  context: AudioContext | null;
  /** The segment being heard. */
  segment: Segment;
  /** Segments heard to the end and waiting for their text, oldest first. */
  pending: Segment[];
  /** Transcriptions of `pending`, one at a time and in order. */
  transcribing: Promise<void>;
  /** Calls to the target, in order. */
  writing: Promise<void>;
  /** What's been said and typed, for whisper's context. */
  said: string;
  /** Segments typed. */
  typed: number;
  /** The interim text the target shows. */
  shown: string;
  previewing: boolean;
  heard: boolean;
  startedAt: number;
  lastSpeechAt: number;
  ended: boolean;
  /** The microphone was muted, and was unmuted for this session. */
  remute: boolean;
  /** Plays again what was paused while listening (src/lib/mediaPause.ts). */
  releaseMedia: (() => void) | null;
}

let session: Session | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
/** A finished session muting the microphone again. */
let remuting: Promise<unknown> = Promise.resolve();

function newSegment(): Segment {
  return { chunks: [], samples: 0, heard: false, preview: '', previewedSamples: 0 };
}

/** End `current` without typing more: what's typed stays, the interim text goes. */
function drop(current: Session): void {
  current.ended = true;
  stopRecording();
  session = null;
  const { target } = current;
  if (target.update && current.shown) {
    current.shown = '';
    const update = target.update;
    current.writing = current.writing.then(() => update('', '')).catch(() => {});
  }
}

function fail(message: string): void {
  // The pill goes in a few seconds: a missing feature's Install button stays in a notification.
  if (message === DICTATION_NEEDS_FEATURE || message === DICTATION_LIVE) {
    void notifyWithFeature({ source: { name: 'Dictation' }, title: 'Dictation isn’t installed', body: message, replaceKey: 'dictation:feature' }, 'dictation');
  }
  if (session) drop(session);
  setState({ ...IDLE, status: 'error', error: message });
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    if (state.status === 'error') setState(IDLE);
  }, ERROR_MS);
}

function stopRecording(): void {
  if (!session) return;
  session.stream?.getTracks().forEach((track) => track.stop());
  void session.context?.close().catch(() => {});
  session.stream = null;
  session.context = null;
  session.releaseMedia?.();
  session.releaseMedia = null;
  if (session.remute) {
    session.remute = false;
    remuting = getAudioBridge()?.setInputMuted(true).catch(() => {}) ?? Promise.resolve();
  }
}

function pcm(segment: Segment): Uint8Array {
  const all = new Int16Array(segment.samples);
  let offset = 0;
  for (const chunk of segment.chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new Uint8Array(all.buffer);
}

function joinWords(a: string, b: string): string {
  return a && b ? `${a} ${b}` : a || b;
}

/** What's been heard and not typed: the waiting segments' words, then the current one's. */
function interimText(current: Session): string {
  return [...current.pending, current.segment].map((s) => s.preview).filter(Boolean).join(' ');
}

/**
 * Type `final` (a segment's text, or '' for none) and show the interim text
 * after it, where the target can; queued behind what's being typed.
 */
function deliver(current: Session, final: string): Promise<void> {
  const interim = interimText(current);
  if (session === current) setState({ preview: interim });
  const { target } = current;
  const update = target.update;
  let call: (() => void | Promise<void>) | null = null;
  if (update) {
    if (final || interim !== current.shown) {
      current.shown = interim;
      call = () => update(final, interim);
    }
  } else if (final) {
    const text = current.typed ? ` ${final}` : final;
    call = () => target.insert(text);
  }
  if (final) current.typed++;
  if (call) {
    const run = call;
    current.writing = current.writing.then(run).catch(() => {
      if (session === current) fail('Couldn’t type the text there');
    });
  }
  return current.writing;
}

/** End the current segment, and transcribe and type it once those before it are. */
function cut(current: Session): void {
  const segment = current.segment;
  current.segment = newSegment();
  const api = bridge();
  if (!api || !segment.heard || segment.samples < MIN_SEGMENT_SAMPLES) return;
  current.pending.push(segment);
  const audio = pcm(segment);
  current.transcribing = current.transcribing.then(async () => {
    if (session !== current) return;
    let text: string;
    try {
      text = cleanTranscript(await api.transcribe(audio, current.said.slice(-CONTEXT_CHARS)));
    } catch (error) {
      if (session === current) fail(cleanError(error));
      return;
    }
    if (session !== current) return;
    current.pending.splice(current.pending.indexOf(segment), 1);
    current.said = joinWords(current.said, text).slice(-CONTEXT_CHARS * 2);
    await deliver(current, text);
  });
}

/** Transcribe the current segment so far, if there's enough new to be worth it. */
function preview(current: Session): void {
  const api = bridge();
  const segment = current.segment;
  // Waiting segments go first: whisper takes one request at a time.
  if (!api || !current.interim || current.previewing || current.ended || !segment.heard || current.pending.length) return;
  if (segment.samples - segment.previewedSamples < PREVIEW_STEP_SAMPLES) return;
  segment.previewedSamples = segment.samples;
  current.previewing = true;
  api
    .transcribe(pcm(segment), current.said.slice(-CONTEXT_CHARS))
    .then((text) => {
      if (session !== current || (current.segment !== segment && !current.pending.includes(segment))) return;
      segment.preview = cleanTranscript(text);
      void deliver(current, '');
    })
    .catch(() => {})
    .finally(() => {
      current.previewing = false;
    });
}

/** Average `input` (at `rate`) down to 16 kHz, carrying the remainder over. */
function makeResampler(rate: number) {
  const step = rate / SAMPLE_RATE;
  let carry = 0;
  let sum = 0;
  let count = 0;
  return (input: Float32Array): Int16Array => {
    const out = new Int16Array(Math.ceil(input.length / step) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i];
      count++;
      carry += 1;
      if (carry >= step) {
        carry -= step;
        const value = Math.max(-1, Math.min(1, sum / count));
        out[n++] = value < 0 ? value * 0x8000 : value * 0x7fff;
        sum = 0;
        count = 0;
      }
    }
    return out.subarray(0, n);
  };
}

/**
 * Unmute the microphone for `current`, if it's muted; stopRecording mutes it
 * again. Waits for the last session's re-mute first, or that would land
 * after this one read the microphone as unmuted.
 */
async function unmuteFor(current: Session): Promise<void> {
  const audio = getAudioBridge();
  if (!audio) return;
  await remuting;
  try {
    const status = await audio.inputStatus();
    if (!status.available || !status.muted) return;
    await audio.setInputMuted(false);
  } catch {
    return;
  }
  if (session === current && !current.ended) current.remute = true;
  else remuting = audio.setInputMuted(true).catch(() => {});
}

/**
 * Start listening for `target`. A held session goes until finishDictation;
 * otherwise it ends after a pause. A session already running is cancelled.
 */
export async function startDictation(
  target: DictationTarget,
  options: { held?: boolean; overlay?: boolean; interim?: boolean } = {},
): Promise<void> {
  if (session) {
    cancelDictation();
  }
  const api = bridge();
  if (!api) {
    fail('Dictation isn’t available here');
    return;
  }
  if (errorTimer) clearTimeout(errorTimer);
  const current: Session = {
    target,
    held: Boolean(options.held),
    interim: options.interim !== false,
    stream: null,
    context: null,
    segment: newSegment(),
    pending: [],
    transcribing: Promise.resolve(),
    writing: Promise.resolve(),
    said: '',
    typed: 0,
    shown: '',
    previewing: false,
    heard: false,
    startedAt: Date.now(),
    lastSpeechAt: Date.now(),
    ended: false,
    remute: false,
    releaseMedia: null,
  };
  session = current;
  setState({ ...IDLE, status: 'listening', held: current.held, overlay: options.overlay !== false, owner: target.owner ?? null });

  const ok = await api.available().catch(() => false);
  if (session !== current) return;
  if (!ok) {
    const reason = await missingReason();
    if (session === current) fail(reason);
    return;
  }
  await unmuteFor(current);
  if (session !== current) return;
  // Loads the model while the microphone opens.
  api.prepare().catch((error: unknown) => {
    if (session === current) fail(cleanError(error));
  });

  // Quiet before the microphone opens, so it doesn't hear the music.
  current.releaseMedia = holdMedia();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    if (session === current) fail('Couldn’t use the microphone');
    return;
  }
  if (session !== current || current.ended) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  current.stream = stream;
  const context = new AudioContext();
  current.context = context;
  const source = context.createMediaStreamSource(stream);
  // A ScriptProcessor rather than a worklet: a worklet needs a module URL the
  // shell's CSP would have to allow, and dictation's chunks are big enough
  // that the main thread keeps up.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const resample = makeResampler(context.sampleRate);
  const chunkMs = (4096 / context.sampleRate) * 1000;
  let floor = 0.004;
  // While Din speaks (a call), what the microphone hears is mostly its voice
  // coming back from the speakers, which echo cancellation may or may not
  // take out. How loud that comes back, per unit of what's played, is
  // learned while it speaks: it's speech only when the microphone is well
  // above that, for long enough to be a word (the user talking over it),
  // so Din's own words neither start a segment, costing a transcription,
  // nor count as the user's.
  let echo = 0;
  let output = 0;
  let outputFor = 0;
  let over = 0;
  processor.onaudioprocess = (event) => {
    if (session !== current || current.ended) return;
    const input = event.inputBuffer.getChannelData(0);
    const chunk = resample(input);
    const segment = current.segment;
    segment.chunks.push(chunk);
    segment.samples += chunk.length;

    let power = 0;
    for (let i = 0; i < input.length; i++) power += input[i] * input[i];
    const rms = Math.sqrt(power / input.length);
    // The background's level, followed down quickly and up slowly.
    floor = rms < floor ? floor * 0.5 + rms * 0.5 : floor * 0.995 + rms * 0.005;
    const now = Date.now();
    let speaking = rms > Math.max(0.012, floor * 2.5);
    // What's played, held over a word's gaps and the room's delay.
    output = Math.max(speechOutputLevel(), output * 0.6);
    if (output > 0.004) {
      const ratio = rms / output;
      outputFor += chunkMs;
      if (outputFor < 500) {
        // The echo's level, learned as the voice starts.
        echo = Math.max(echo, ratio);
        over = 0;
        speaking = false;
      } else {
        // Followed down quickly, and up slowly, so the user's voice doesn't teach it.
        echo = ratio < echo ? echo * 0.6 + ratio * 0.4 : echo * 0.97 + ratio * 0.03;
        over = speaking && rms > echo * output * 3 ? over + chunkMs : 0;
        speaking = over >= 250;
      }
    } else {
      outputFor = 0;
      over = 0;
    }
    if (speaking) {
      current.heard = true;
      segment.heard = true;
      current.lastSpeechAt = now;
    } else if (!segment.heard) {
      // Before anything's said, only the last moment of quiet is kept.
      while (segment.chunks.length > 1 && segment.samples - segment.chunks[0].length >= LEAD_SAMPLES) {
        segment.samples -= segment.chunks.shift()!.length;
      }
    }
    const quiet = now - current.lastSpeechAt;
    const voiced = segment.heard && quiet <= SEGMENT_PAUSE_MS;
    setState(voiced !== state.voiced ? { level: Math.min(1, Math.sqrt(rms) * 2.2), voiced } : { level: Math.min(1, Math.sqrt(rms) * 2.2) });

    const length = (segment.samples / SAMPLE_RATE) * 1000;
    if (now - current.startedAt > MAX_MS) {
      void finishDictation();
    } else if (!current.held && current.heard && quiet > PAUSE_MS) {
      void finishDictation();
    } else if (!current.held && !current.heard && now - current.startedAt > NOTHING_HEARD_MS) {
      fail('Didn’t hear anything');
    } else if (segment.heard && (quiet > SEGMENT_PAUSE_MS || length > SEGMENT_MAX_MS || (length > SEGMENT_SOFT_MS && !speaking))) {
      cut(current);
    } else {
      preview(current);
    }
  };
  source.connect(processor);
  // A processor only runs when connected onward; it outputs silence.
  processor.connect(context.destination);
}

/** Stop listening, and type the rest of what was said. */
export async function finishDictation(): Promise<void> {
  const current = session;
  if (!current || current.ended) return;
  current.ended = true;
  stopRecording();
  cut(current);
  if (current.pending.length) setState({ status: 'transcribing', level: 0 });
  await current.transcribing;
  if (session !== current) return;
  // A segment that came back empty takes its interim words with it.
  await deliver(current, '');
  if (session !== current) return;
  session = null;
  setState(IDLE);
}

/** Stop listening and throw away what isn't typed yet. */
export function cancelDictation(): void {
  if (!session) return;
  drop(session);
  setState(IDLE);
}

export function isDictating(): boolean {
  return session !== null;
}

/** Super+H: start dictating where the keyboard is, or stop. */
export function toggleDictation(): void {
  if (session) {
    void finishDictation();
    return;
  }
  const target = focusedDictationTarget();
  if (!target) {
    fail('Click where you want to type first');
    return;
  }
  void startDictation(target);
}

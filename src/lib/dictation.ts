/**
 * Dictation: speak, and the words are typed where you were typing.
 *
 * One session at a time, started by Super+H (into whatever has focus), by
 * holding Super+A (into the assistant's prompt) or by a mic button (into
 * its own field). The shell records the microphone, and whisper.cpp turns
 * it into text in the main process (`window.dinos.dictation`, see
 * electron/dictation.mts). While you speak, what's been heard so far is
 * shown as a preview (DictationOverlay); when you stop, the final text goes
 * to the session's target.
 *
 * A toggled session ends by itself after a pause; a held one (Super+A) when
 * the key comes up.
 *
 * Targets are found from the shell's focus: text fields get the text as if
 * typed (undo and React's onChange keep working), web pages through
 * Electron, and the components that put their own focus somewhere a field
 * can't reach (the Terminal, native app windows) register a target for
 * their element with registerDictationTarget.
 */
import { getAudioBridge } from '@/lib/audio';
import { getFeaturesBridge } from '@/lib/features';
import { holdMedia } from '@/lib/mediaPause';
import { guestId, isGuestElement } from '@/platform/guest';

/** Why dictation can't start on DinOS before its optional feature is installed. */
export const DICTATION_NEEDS_FEATURE = 'Dictation needs Dictation & transcripts, in Settings → Optional Features';
const DICTATION_DOWNLOADING = 'Dictation hasn’t finished downloading';
const DICTATION_WAITING = 'Dictation downloads when this computer is online';
const DICTATION_LIVE = 'Dictation comes with DinOS once it’s installed, or install it now in Settings → Optional Features';

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
  transcribe(pcm: Uint8Array): Promise<string>;
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
  insert(text: string): void | Promise<void>;
  /** What it types into, for a mic button to know the session is its own. */
  owner?: unknown;
}

export type DictationStatus = 'idle' | 'listening' | 'transcribing' | 'error';

export interface DictationState {
  status: DictationStatus;
  /** The microphone's level, 0-1. */
  level: number;
  /** What's been heard so far. */
  preview: string;
  /** Why it stopped, when status is 'error'. */
  error: string | null;
  /** Whether it ends when a held key comes up, rather than after a pause. */
  held: boolean;
  owner: unknown;
}

const SAMPLE_RATE = 16_000;
/** A toggled session ends after this much quiet once speech was heard. */
const PAUSE_MS = 1_600;
/** And gives up after this long hearing nothing at all. */
const NOTHING_HEARD_MS = 10_000;
/** Recordings stop here. */
const MAX_MS = 5 * 60_000;
/** The preview is redone with this much new audio. */
const PREVIEW_STEP_SAMPLES = SAMPLE_RATE / 2;
/** Errors stay up this long. */
const ERROR_MS = 4_000;

const IDLE: DictationState = { status: 'idle', level: 0, preview: '', error: null, held: false, owner: null };

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

/** A space before the text unless it starts a line or follows one. */
function spaced(before: string, text: string): string {
  return before && !/\s$/.test(before) && !/^[.,!?;:]/.test(text) ? ` ${text}` : text;
}

/** Type into a text field or editable element as if the keyboard had. */
export function elementTarget(element: TextField | HTMLElement): DictationTarget {
  return {
    owner: element,
    insert: (text) => {
      if (!element.isConnected) return;
      element.focus();
      let before = '';
      if (isTextField(element)) {
        before = element.value.slice(0, element.selectionStart ?? element.value.length);
      } else {
        const selection = window.getSelection();
        const node = selection?.anchorNode;
        if (node?.nodeType === Node.TEXT_NODE) before = (node.textContent ?? '').slice(0, selection?.anchorOffset ?? 0);
      }
      document.execCommand('insertText', false, spaced(before, text));
    },
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

interface Session {
  target: DictationTarget;
  held: boolean;
  stream: MediaStream | null;
  context: AudioContext | null;
  chunks: Int16Array[];
  samples: number;
  heard: boolean;
  startedAt: number;
  lastSpeechAt: number;
  previewedSamples: number;
  previewing: Promise<void> | null;
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

function fail(message: string): void {
  stopRecording();
  session = null;
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

function recording(current: Session): Uint8Array {
  const all = new Int16Array(current.samples);
  let offset = 0;
  for (const chunk of current.chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new Uint8Array(all.buffer);
}

/** Retranscribe everything so far, if there's enough new to be worth it. */
function preview(current: Session): void {
  const api = bridge();
  if (!api || current.previewing || current.ended || !current.heard) return;
  if (current.samples - current.previewedSamples < PREVIEW_STEP_SAMPLES) return;
  current.previewedSamples = current.samples;
  current.previewing = api
    .transcribe(recording(current))
    .then((text) => {
      if (session === current && !current.ended) setState({ preview: cleanTranscript(text) });
    })
    .catch(() => {})
    .finally(() => {
      current.previewing = null;
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
export async function startDictation(target: DictationTarget, options: { held?: boolean } = {}): Promise<void> {
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
    stream: null,
    context: null,
    chunks: [],
    samples: 0,
    heard: false,
    startedAt: Date.now(),
    lastSpeechAt: Date.now(),
    previewedSamples: 0,
    previewing: null,
    ended: false,
    remute: false,
    releaseMedia: null,
  };
  session = current;
  setState({ ...IDLE, status: 'listening', held: current.held, owner: target.owner ?? null });

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
  let floor = 0.004;
  processor.onaudioprocess = (event) => {
    if (session !== current || current.ended) return;
    const input = event.inputBuffer.getChannelData(0);
    const chunk = resample(input);
    current.chunks.push(chunk);
    current.samples += chunk.length;

    let power = 0;
    for (let i = 0; i < input.length; i++) power += input[i] * input[i];
    const rms = Math.sqrt(power / input.length);
    // The background's level, followed down quickly and up slowly.
    floor = rms < floor ? floor * 0.5 + rms * 0.5 : floor * 0.995 + rms * 0.005;
    const now = Date.now();
    if (rms > Math.max(0.012, floor * 2.5)) {
      current.heard = true;
      current.lastSpeechAt = now;
    }
    setState({ level: Math.min(1, Math.sqrt(rms) * 2.2) });

    if (now - current.startedAt > MAX_MS) {
      void finishDictation();
    } else if (!current.held && current.heard && now - current.lastSpeechAt > PAUSE_MS) {
      void finishDictation();
    } else if (!current.held && !current.heard && now - current.startedAt > NOTHING_HEARD_MS) {
      fail('Didn’t hear anything');
    } else {
      preview(current);
    }
  };
  source.connect(processor);
  // A processor only runs when connected onward; it outputs silence.
  processor.connect(context.destination);
}

/** Stop listening and type what was said. */
export async function finishDictation(): Promise<void> {
  const current = session;
  const api = bridge();
  if (!current || current.ended || !api) return;
  current.ended = true;
  stopRecording();
  if (!current.heard || current.samples < SAMPLE_RATE / 4) {
    session = null;
    setState(IDLE);
    return;
  }
  setState({ status: 'transcribing', level: 0 });
  let text: string;
  try {
    await current.previewing;
    text = cleanTranscript(await api.transcribe(recording(current)));
  } catch (error) {
    if (session === current) fail(cleanError(error));
    return;
  }
  if (session !== current) return;
  session = null;
  setState(IDLE);
  if (!text) return;
  try {
    await current.target.insert(text);
  } catch {
    fail('Couldn’t type the text there');
  }
}

/** Stop listening and throw the recording away. */
export function cancelDictation(): void {
  if (!session) return;
  session.ended = true;
  stopRecording();
  session = null;
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

/**
 * Typed access to the screen recorder exposed by the Electron preload
 * (`window.dinos.screenRecorder`, see electron/screen-recorder.mts).
 *
 * Main owns the one recording (wf-recorder through din-shell's screencopy),
 * so the Screenshot app, the menu bar's stop button and `din screenshot
 * record` all see and stop the same one. Absent in a plain browser, and
 * `available: false` where wf-recorder or the compositor's screencopy isn't.
 */

import { useSyncExternalStore } from 'react';

/** The sound recorded with the screen. */
export type RecordingAudio = 'none' | 'system' | 'microphone';

export interface ActiveRecording {
  path: string;
  /** Epoch milliseconds. */
  startedAt: number;
  audio: RecordingAudio;
  /** Whether it's an area rather than the whole screen. */
  area: boolean;
}

export interface RecorderStatus {
  available: boolean;
  recording: ActiveRecording | null;
}

export interface FinishedRecording {
  /** The saved file, or null when nothing usable was written. */
  path: string | null;
  durationMs: number;
  /** Why it stopped on its own, when it did. */
  error?: string;
}

export interface RecordingRequest {
  /** The area to record, in viewport CSS pixels; the primary monitor when absent. */
  region?: { x: number; y: number; width: number; height: number };
  audio?: RecordingAudio;
  /** Where to save it; ~/Videos/Screen Recordings when absent. */
  path?: string;
}

export interface ScreenRecorderBridge {
  status(): Promise<RecorderStatus>;
  start(request: RecordingRequest): Promise<RecorderStatus>;
  stop(): Promise<FinishedRecording | null>;
  onState(callback: (status: RecorderStatus) => void): () => void;
  onFinished(callback: (finished: FinishedRecording) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    screenRecorder?: ScreenRecorderBridge;
  }
}

/** The screen recorder bridge, or undefined outside the Electron shell. */
export function getScreenRecorderBridge(): ScreenRecorderBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.screenRecorder;
}

const UNAVAILABLE: RecorderStatus = { available: false, recording: null };

let current: RecorderStatus = UNAVAILABLE;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function set(next: RecorderStatus): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const bridge = getScreenRecorderBridge();
  if (bridge && !unsubscribe) {
    unsubscribe = bridge.onState(set);
    bridge.status().then(set, () => {});
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}

/** The recorder's status, kept current from main. */
export function useScreenRecorder(): RecorderStatus {
  return useSyncExternalStore(subscribe, () => current, () => UNAVAILABLE);
}

/** Ask main again, as after wf-recorder is installed. */
export function refreshScreenRecorder(): void {
  getScreenRecorderBridge()?.status().then(set, () => {});
}

/** Start recording; rejects with main's reason when it can't. */
export function startRecording(request: RecordingRequest): Promise<RecorderStatus> {
  const bridge = getScreenRecorderBridge();
  if (!bridge) return Promise.reject(new Error('Screen recording is only available inside the Din desktop'));
  return bridge.start(request);
}

/** Stop the recording running, if one is. */
export function stopRecording(): Promise<FinishedRecording | null> {
  return getScreenRecorderBridge()?.stop() ?? Promise.resolve(null);
}

/** "0:42", "12:05", "1:02:09". */
export function formatRecordingTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

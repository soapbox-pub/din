import { useSyncExternalStore } from 'react';

/**
 * Typed access to Studio's capture bridge (electron/capture.mts): projects
 * in ~/Videos/Studio, each a folder of takes (written as Studio records them)
 * and clips (files brought in), and live streams. The
 * desktop has it as `window.dinos.capture` (the menu bar's indicators,
 * `din studio`); Studio has it as `din.system.capture`, with the
 * `capture` permission.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent, so callers
 * feature-detect via `getCaptureBridge()`.
 */

export type StudioScene = 'screen-camera' | 'camera' | 'screen';
export type StudioAspect = '16:9' | '9:16' | '1:1';

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LiveStatus {
  /** The destination's name ("YouTube"). */
  destination: string;
  phase: 'connecting' | 'live' | 'ending';
  /** Epoch milliseconds. */
  startedAt: number;
  /** What's going out, in kilobits a second, once known. */
  bitrate: number | null;
  /** Bytes waiting to go out. */
  backlog: number;
  /** The connection can't keep up. */
  behind: boolean;
}

export interface CaptureState {
  recording: { take: string; title: string; project: string; startedAt: number } | null;
  live: LiveStatus | null;
}

export interface CaptureStatus {
  /** ~/Videos/Studio */
  folder: string;
  /** Whether the screen can be recorded with its pointer, at full quality. */
  screen: boolean;
  /** Whether takes are finished into MP4s and streams can go out (FFmpeg). */
  ffmpeg: boolean;
  /** Whether takes are transcribed. */
  transcribe: boolean;
  /** The primary display within a capture of the screen, as fractions of it. */
  screenRect: CaptureRect;
  state: CaptureState;
}

export type TranscriptState = 'none' | 'working' | 'done' | 'failed';

export interface TakeInfo {
  path: string;
  /** The folder's name, "Take 3". */
  name: string;
  /** The project's folder, or null for a take from before projects. */
  project: string | null;
  /** Recorded in Studio, or a file the user brought in. */
  kind: 'recording' | 'clip';
  title: string;
  /** ISO 8601. */
  created: string;
  /** Seconds. */
  duration: number;
  scene: StudioScene;
  aspect: StudioAspect;
  status: 'recording' | 'finishing' | 'ready' | 'interrupted';
  transcript: TranscriptState;
  /** The picture as it was recorded, or null. */
  program: string | null;
  poster: string | null;
  /** What the Assistant made from it. */
  edits: string[];
}

export interface ProjectItem {
  take: TakeInfo;
  /** In the edit; false for one the user set aside. */
  keep: boolean;
  /** What the user said about it, for the Assistant. */
  note: string;
  /** The part to use, in seconds on the take's clock; null for its start or end. */
  in: number | null;
  out: number | null;
}

export interface ProjectInfo {
  /** ~/Videos/Studio/<date> <title> */
  path: string;
  name: string;
  title: string;
  /** ISO 8601. */
  created: string;
  /** When a take was last added, ISO 8601. */
  updated: string;
  /** Its takes and clips, in the order they go. */
  items: ProjectItem[];
  /** What the Assistant made from it. */
  edits: string[];
  /** A take from before projects, made into a project when it's opened (`openProject`). */
  single: boolean;
}

export interface ProjectChange {
  title?: string;
  /** Every take's folder name, in the new order. */
  order?: string[];
  /** One take's place in the edit, by its folder name; a null `in` or `out` clears it. */
  item?: { name: string; keep?: boolean; note?: string; in?: number | null; out?: number | null };
}

export interface TakeStart {
  /** The project to record into; a new one when left out. */
  project?: string;
  title?: string;
  scene: StudioScene;
  aspect: StudioAspect;
  canvas: { width: number; height: number };
  /** Record the screen too (with its pointer), with the computer's sound or not. */
  screen: { audio: boolean } | null;
}

export interface TrackStart {
  /** The file written with `open`, in the take's folder (`.program.webm`). */
  file: string;
  /** Epoch milliseconds of its first frame. */
  start: number;
  width?: number;
  height?: number;
  mirrored?: boolean;
  audio?: string;
}

export interface SceneSwitch {
  /** Epoch milliseconds. */
  at: number;
  scene: StudioScene;
  camera: (CaptureRect & { shape: string }) | null;
  screen: CaptureRect | null;
}

export interface TakeMarker {
  /** Epoch milliseconds. */
  at: number;
  /** `retake`: what was just said goes; `highlight`: a moment to keep. */
  kind: 'highlight' | 'retake';
}

export interface TakeEnd {
  /** Epoch milliseconds: the take's clock starts here. */
  startedAt: number;
  durationMs: number;
  tracks: { program?: TrackStart; camera?: TrackStart; mic?: TrackStart };
  switches: SceneSwitch[];
  markers: TakeMarker[];
  discard?: boolean;
}

export type DestinationService = 'youtube' | 'twitch' | 'kick' | 'custom';

export interface Destination {
  id: string;
  service: DestinationService;
  name: string;
  server: string;
  hasKey: boolean;
}

export interface DestinationInput {
  id?: string;
  service: DestinationService;
  name: string;
  server: string;
  /** Left out to keep the saved one. */
  key?: string;
}

export interface StreamEnded {
  destination: string;
  durationMs: number;
  /** Why it ended, when it wasn't asked to; null when it was. */
  error: string | null;
}

export interface PointerImage {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  rgba: Uint8Array;
  size: number;
  displayHeight: number;
}

export interface CaptureBridge {
  status(): Promise<CaptureStatus>;
  /** Where the pointer is on the primary display, as fractions of it. */
  pointer(): Promise<{ x: number; y: number }>;
  /**
   * The pointer's arrow from the cursor theme, as straight RGBA, `size`
   * logical pixels big on a primary display `displayHeight` tall; null where
   * there's no theme to read.
   */
  pointerImage(): Promise<PointerImage | null>;
  /** Every take, newest first; or one project's, in its order. */
  takes(project?: string): Promise<TakeInfo[]>;
  /** The projects, the one added to last first. */
  projects(): Promise<ProjectInfo[]>;
  project(path: string): Promise<ProjectInfo | null>;
  createProject(title?: string): Promise<ProjectInfo>;
  /** A project to work in: a take from before projects is made into one first. */
  openProject(path: string): Promise<ProjectInfo>;
  updateProject(path: string, change: ProjectChange): Promise<ProjectInfo>;
  /** Make a clip's folder in a project; write its file with `open`, `write` and `close`, then `importEnd`. */
  importBegin(project: string, name: string): Promise<{ take: string; file: string }>;
  /** The clip's file is written (or, with `discard`, abandoned): it's read, given a poster and transcribed. */
  importEnd(take: string, discard?: boolean): Promise<TakeInfo | null>;
  /** The desktop's alone: copy a file into a project by its path. */
  importFile?(project: string, file: string): Promise<TakeInfo | null>;
  take(path: string): Promise<TakeInfo | null>;
  rename(take: string, title: string): Promise<void>;
  /** Make a take's folder and start its screen track; the app starts its own recorders once this resolves. */
  begin(request: TakeStart): Promise<{ take: string; title: string; project: string; screen: { start: number; width: number; height: number } | null }>;
  /** Stop the screen track, finish the files and write take.json; null when discarded. */
  end(request: TakeEnd): Promise<TakeInfo | null>;
  /** Open one of the take's files to write as it's recorded; resolves with a writer id. */
  open(take: string, file: string): Promise<string>;
  write(id: string, data: Uint8Array): Promise<void>;
  close(id: string): Promise<void>;
  transcribe(take: string): Promise<void>;
  destinations(): Promise<Destination[]>;
  saveDestination(input: DestinationInput): Promise<Destination>;
  removeDestination(id: string): Promise<void>;
  /** Start sending to a destination; the stream is what `streamWrite` sends, WebM with H.264 and Opus. */
  streamStart(id: string): Promise<LiveStatus>;
  streamWrite(data: Uint8Array): void;
  streamStop(): Promise<void>;
  /** The desktop's alone: tell main where the pointer is, in CSS pixels of the desktop (src/lib/capturePointer.ts). */
  pointerAt?(x: number, y: number): void;
  /** The desktop's alone: main wants to know where the pointer is for a while (Studio's drawing it). */
  onReportPointer?(callback: () => void): () => void;
  onState(callback: (state: CaptureState) => void): () => void;
  /** A take changed (or `removed`). */
  onChanged(callback: (take: TakeInfo | { path: string; removed: true }) => void): () => void;
  /** A project changed: a take added, set aside, moved, renamed (or `removed`). */
  onProjectChanged(callback: (project: ProjectInfo | { path: string; removed: true }) => void): () => void;
  onStreamEnded(callback: (ended: StreamEnded) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    capture?: CaptureBridge;
  }
}

/** The capture bridge, or undefined outside the Electron shell. */
export function getCaptureBridge(): CaptureBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.capture;
}

/** A bridge error without Electron's "Error invoking remote method" wrapping. */
export function cleanCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

const IDLE: CaptureState = { recording: null, live: null };
let current: CaptureState = IDLE;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function set(next: CaptureState): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const bridge = getCaptureBridge();
  if (bridge && !unsubscribe) {
    unsubscribe = bridge.onState(set);
    bridge.status().then((s) => set(s.state), () => {});
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}

/** Whether Studio is recording or live, kept current from main. For the desktop. */
export function useCaptureState(): CaptureState {
  return useSyncExternalStore(subscribe, () => current, () => IDLE);
}

// Screen recording (window.dinos.screenRecorder): the Screenshot app's Record
// mode, the menu bar's stop button and `din screenshot record`.
//
// The recording is wf-recorder's, through din-shell's wlroots screencopy: the
// real screen, pointer included, paced by what changes on it, encoded on the
// GPU (VA-API) where there is one and by x264 where there isn't, with the
// computer's sound (the default output's monitor) or the microphone mixed in
// by PulseAudio (pipewire-pulse). DinOS names the binary in DIN_WF_RECORDER;
// elsewhere one on PATH is used, and without one recording is unavailable.
//
// One recording at a time, owned here rather than by the window that started
// it, so it survives that window closing and the shell reloading. Stopping
// sends wf-recorder SIGINT, which finishes the MP4 (an MP4 cut off without
// its index doesn't play).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, screen, type BrowserWindow } from 'electron';

/** How long wf-recorder gets to fail at starting before it's taken as recording. */
const START_GRACE_MS = 1200;
/** How long it gets to finish the file once asked to stop. */
const STOP_TIMEOUT_MS = 15_000;
export const RENDER_NODE = '/dev/dri/renderD128';

export type RecordingAudio = 'none' | 'system' | 'microphone';

export interface RecordingStart {
  /** The area to record, in the shell's viewport CSS pixels; the primary display when absent. */
  region?: { x: number; y: number; width: number; height: number };
  audio?: RecordingAudio;
  /** Where to save it; ~/Videos/Screen Recordings when absent. */
  path?: string;
}

export interface ActiveRecording {
  path: string;
  /** Epoch milliseconds. */
  startedAt: number;
  audio: RecordingAudio;
  /** Whether it's an area rather than a whole display. */
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

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  shellWindow: () => BrowserWindow | null;
  /** The display Din treats as primary (the one with the menu bar). */
  primaryBounds: () => Promise<Electron.Rectangle>;
}

let options: Options | null = null;

interface Running extends ActiveRecording {
  child: ChildProcess;
  stopping: boolean;
  /** Resolves when wf-recorder has exited and the file is final. */
  exited: Promise<void>;
}

let current: Running | null = null;

/** wf-recorder: DinOS's, else one on PATH, else null. */
export function findRecorder(): string | null {
  const named = process.env.DIN_WF_RECORDER;
  if (named) return fs.existsSync(named) ? named : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'wf-recorder');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function available(): boolean {
  return !!process.env.WAYLAND_DISPLAY && findRecorder() !== null;
}

function status(): RecorderStatus {
  return {
    available: available(),
    recording: current && !current.stopping
      ? { path: current.path, startedAt: current.startedAt, audio: current.audio, area: current.area }
      : null,
  };
}

function publish(): void {
  options?.sendToShell('screen-recorder:state', status());
}

/**
 * ~/Videos/Screen Recordings/Screen Recording 2026-07-18 at 14.32.05.mp4,
 * like the screenshots' names. A folder already there under another case
 * ("Screen recordings") is used rather than made twice.
 */
function defaultPath(): string {
  const videos = path.join(os.homedir(), 'Videos');
  let folder = 'Screen Recordings';
  try {
    folder = fs.readdirSync(videos).find((name) => name.toLowerCase() === folder.toLowerCase()) ?? folder;
  } catch {
    // No ~/Videos yet.
  }
  const dir = path.join(videos, folder);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `Screen Recording ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} at ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
  let file = path.join(dir, `${base}.mp4`);
  for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `${base} (${n}).mp4`);
  return file;
}

function finite(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Invalid recording area');
  return n;
}

/**
 * The compositor area to record, in its layout coordinates: a viewport region
 * converted out of the page zoom and offset by the shell window's place, kept
 * to the one display it's mostly on (wf-recorder records a single output), or
 * the primary display.
 */
async function geometry(region: RecordingStart['region']): Promise<Electron.Rectangle> {
  if (!options) throw new Error('Screen recording is unavailable');
  if (!region) return options.primaryBounds();
  const win = options.shellWindow();
  const zoom = win && !win.webContents.isDestroyed() ? win.webContents.getZoomFactor() : 1;
  const origin = win ? win.getContentBounds() : { x: 0, y: 0 };
  const x = origin.x + finite(region.x) * zoom;
  const y = origin.y + finite(region.y) * zoom;
  const width = finite(region.width) * zoom;
  const height = finite(region.height) * zoom;
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) }).bounds;
  const left = Math.max(display.x, Math.round(x));
  const top = Math.max(display.y, Math.round(y));
  const right = Math.min(display.x + display.width, Math.round(x + width));
  const bottom = Math.min(display.y + display.height, Math.round(y + height));
  if (right - left < 16 || bottom - top < 16) throw new Error('That area is too small to record');
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function recorderArgs(area: Electron.Rectangle, file: string, audio: RecordingAudio, gpu: boolean): string[] {
  const args = ['-y', '-g', `${area.x},${area.y} ${area.width}x${area.height}`];
  if (gpu) args.push('-c', 'h264_vaapi', '-d', RENDER_NODE);
  else args.push('-c', 'libx264', '-x', 'yuv420p', '-p', 'preset=veryfast');
  if (audio === 'system') args.push('--audio=@DEFAULT_MONITOR@');
  if (audio === 'microphone') args.push('--audio=@DEFAULT_SOURCE@');
  args.push('-f', file);
  return args;
}

/** The last thing wf-recorder (or FFmpeg) said that reads like an error. */
export function lastError(log: string): string {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  const error = [...lines].reverse().find((l) => /fail|error|invalid|cannot|could not|unable/i.test(l));
  return error ?? lines.at(-1) ?? 'The recorder stopped';
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Start wf-recorder and give it a moment: one that can't open the screen, the
 * encoder or the sound exits straight away, and says why.
 */
function launch(binary: string, args: string[]): Promise<{ child: ChildProcess; log: () => string; exited: Promise<number | null> } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const take = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8192);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const exited = new Promise<number | null>((done) => {
      child.once('exit', (code) => done(code));
      child.once('error', () => done(null));
    });
    const timer = setTimeout(() => resolve({ child, log: () => log, exited }), START_GRACE_MS);
    void exited.then(() => {
      clearTimeout(timer);
      resolve({ error: lastError(log) });
    });
  });
}

async function start(request: RecordingStart): Promise<RecorderStatus> {
  if (current) throw new Error('Already recording the screen');
  const binary = findRecorder();
  if (!binary || !process.env.WAYLAND_DISPLAY) throw new Error('Screen recording isn’t available here');
  const audio: RecordingAudio = request.audio === 'system' || request.audio === 'microphone' ? request.audio : 'none';
  const area = await geometry(request.region);
  let file: string;
  if (typeof request.path === 'string' && request.path) {
    if (!path.isAbsolute(request.path)) throw new Error('An absolute path is required');
    file = path.normalize(request.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } else {
    file = defaultPath();
  }

  // The GPU's encoder where there is one, else the CPU's.
  let launched = fs.existsSync(RENDER_NODE)
    ? await launch(binary, recorderArgs(area, file, audio, true))
    : { error: 'no GPU' };
  if ('error' in launched) launched = await launch(binary, recorderArgs(area, file, audio, false));
  if ('error' in launched) {
    fs.rmSync(file, { force: true });
    throw new Error(`Couldn’t start recording: ${launched.error}`);
  }

  const { child, log } = launched;
  const running: Running = {
    path: file,
    startedAt: Date.now(),
    audio,
    area: !!request.region,
    child,
    stopping: false,
    exited: launched.exited.then(() => undefined),
  };
  current = running;
  void launched.exited.then((code) => {
    if (current !== running || running.stopping) return;
    // It stopped without being asked: a display unplugged, the disk full.
    current = null;
    publish();
    const durationMs = Date.now() - running.startedAt;
    const saved = fileSize(file) > 0 ? file : null;
    options?.sendToShell('screen-recorder:finished', {
      path: saved,
      durationMs,
      error: code === 0 ? 'The recording stopped' : lastError(log()),
    } satisfies FinishedRecording);
  });
  publish();
  return status();
}

async function stop(): Promise<FinishedRecording | null> {
  const running = current;
  if (!running || running.stopping) return null;
  running.stopping = true;
  publish();
  running.child.kill('SIGINT');
  const killer = setTimeout(() => running.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await running.exited;
  clearTimeout(killer);
  current = null;
  publish();
  const finished: FinishedRecording = {
    path: fileSize(running.path) > 0 ? running.path : null,
    durationMs: Date.now() - running.startedAt,
  };
  if (!finished.path) finished.error = 'Nothing was recorded';
  options?.sendToShell('screen-recorder:finished', finished);
  return finished;
}

export function registerScreenRecorderHandlers(opts: Options): void {
  options = opts;
  const { assertShellSender } = opts;

  ipcMain.handle('screen-recorder:status', (event) => {
    assertShellSender(event);
    return status();
  });

  ipcMain.handle('screen-recorder:start', (event, request: unknown) => {
    assertShellSender(event);
    return start(request && typeof request === 'object' ? (request as RecordingStart) : {});
  });

  ipcMain.handle('screen-recorder:stop', (event) => {
    assertShellSender(event);
    return stop();
  });
}

/** Finish the file on the way out, so a recording running at quit still plays. */
export function stopScreenRecording(): void {
  current?.child.kill('SIGINT');
}

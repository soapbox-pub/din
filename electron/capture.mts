// Studio's recordings and live streams (din.system.capture, window.dinos.capture).
//
// Studio (src/apps/studio/) records in its own window: the camera, the
// microphone and the picture it composes (MediaRecorder, H.264 and Opus in
// WebM), streamed here a chunk at a time and appended to the take's folder,
// so a long take never sits in memory and a crash leaves what was recorded.
// The screen is recorded here, by wf-recorder through din-shell's screencopy
// (pointer included, encoded on the GPU), as the Screenshot app's recordings
// are (screen-recorder.mts).
//
// A project is a folder, ~/Videos/Studio/<date> <title>/, of takes and clips
// for the Assistant to make one thing from: project.json lists them in the
// order they go, which to use, and the user's notes and trims, and edits/ is
// where the Assistant puts what it makes. Each take is a folder in its
// takes/: take.json says what's in it and lines its tracks up on one clock,
// and transcript.json has every word spoken with its time (whisper.cpp, as
// dictation uses, run after the take). A clip is a file the user brought in,
// kept in a take folder of its own with the same take.json, so the Assistant
// reads both alike. The studio skill (os/opencode/skills/studio) tells the
// Assistant how to read them. Takes from before projects sit right in
// ~/Videos/Studio; one becomes a project of its own when it's opened.
//
// Going live: Studio sends the picture it composes, already encoded, and
// FFmpeg turns its Opus into the AAC that RTMP wants and pushes it to the
// destination. Stream keys are kept here, sealed with the login keyring
// (safeStorage), and never go back to the app.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain, safeStorage, screen, webContents, type BrowserWindow } from 'electron';
import { pointerArrow } from './cursor.mts';
import { findRecorder, lastError, recorderArgs, RENDER_NODE } from './screen-recorder.mts';

/** How long wf-recorder gets to show its first frame before it's taken as recording anyway. */
const SCREEN_START_TIMEOUT_MS = 3000;
/** How long FFmpeg and wf-recorder get to finish their files once asked to stop. */
const STOP_TIMEOUT_MS = 15_000;
/** What a stream may have waiting to go out before it's called behind. */
const STREAM_BACKLOG_WARN = 8 * 1024 * 1024;
/** Past this, a stream that can't keep up is ended rather than eat the memory. */
const STREAM_BACKLOG_MAX = 256 * 1024 * 1024;
const TAKE_FORMAT = 'din-studio-take';
const TAKE_VERSION = 1;
const PROJECT_FORMAT = 'din-studio-project';
const PROJECT_VERSION = 1;
/** Where a project keeps its takes and clips. */
const TAKES_DIR = 'takes';

export type StudioScene = 'screen-camera' | 'camera' | 'screen';
export type StudioAspect = '16:9' | '9:16' | '1:1';

interface Rect {
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
  /** What FFmpeg last said it sent, in kilobits a second. */
  bitrate: number | null;
  /** Bytes waiting to go out: a growing number means the connection can't keep up. */
  backlog: number;
  behind: boolean;
}

export interface CaptureState {
  recording: { take: string; title: string; project: string; startedAt: number } | null;
  live: LiveStatus | null;
}

export interface CaptureStatus {
  folder: string;
  /** Whether the screen can be recorded with its pointer (wf-recorder). */
  screen: boolean;
  /** Whether takes are finished into MP4s, and streams can go out (FFmpeg). */
  ffmpeg: boolean;
  /** Whether takes are transcribed (whisper.cpp). */
  transcribe: boolean;
  /** The primary display in the shell's frame, as fractions of it: what a capture of the screen shows. */
  screenRect: Rect;
  state: CaptureState;
}

export type TranscriptState = 'none' | 'working' | 'done' | 'failed';

export interface TakeInfo {
  path: string;
  /** The folder's name. */
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
  /** The picture as recorded, absolute, or null when there isn't one. */
  program: string | null;
  poster: string | null;
  /** What the Assistant made from it, in its edits folder. */
  edits: string[];
}

export interface ProjectItem {
  take: TakeInfo;
  /** In the edit; false for one the user set aside. */
  keep: boolean;
  /** What the user said about it, for the Assistant. */
  note: string;
  /** Where the part to use starts and ends, in seconds on the take's clock; null for its start or end. */
  in: number | null;
  out: number | null;
}

export interface ProjectInfo {
  path: string;
  name: string;
  title: string;
  /** ISO 8601. */
  created: string;
  /** When something was last added, ISO 8601. */
  updated: string;
  /** Its takes and clips, in the order they go. */
  items: ProjectItem[];
  /** What the Assistant made, in its edits folder. */
  edits: string[];
  /** A take from before projects, made into a project when it's opened. */
  single: boolean;
}

export interface ProjectChange {
  title?: string;
  /** Every take's folder name, in the new order. */
  order?: string[];
  /** One take's place in the edit, by its folder name. */
  item?: { name: string; keep?: boolean; note?: string; in?: number | null; out?: number | null };
}

export interface TakeStart {
  /** The project to record into; a new one when left out. */
  project?: string;
  title?: string;
  scene: StudioScene;
  aspect: StudioAspect;
  canvas: { width: number; height: number };
  /** Record the screen too, with the computer's sound or not. */
  screen: { audio: boolean } | null;
}

export interface TrackStart {
  /** The file the app wrote, in the take's folder. */
  file: string;
  /** Epoch milliseconds of its first frame. */
  start: number;
  width?: number;
  height?: number;
  mirrored?: boolean;
  /** What a sound track holds ('voice', 'voice+computer'). */
  audio?: string;
}

export interface SceneSwitch {
  /** Epoch milliseconds. */
  at: number;
  scene: StudioScene;
  /** The camera's place on the canvas, as fractions of it, and its shape. */
  camera: (Rect & { shape: string }) | null;
  /** Where the screen is drawn on the canvas, as fractions of it. */
  screen: Rect | null;
}

export interface TakeMarker {
  at: number;
  kind: 'highlight' | 'retake';
}

export interface TakeEnd {
  /** Epoch milliseconds: the take's clock starts here (the program's first frame). */
  startedAt: number;
  durationMs: number;
  tracks: { program?: TrackStart; camera?: TrackStart; mic?: TrackStart };
  switches: SceneSwitch[];
  markers: TakeMarker[];
  /** Throw it away (cancelled before anything was worth keeping). */
  discard?: boolean;
}

export interface Destination {
  id: string;
  service: 'youtube' | 'twitch' | 'kick' | 'custom';
  name: string;
  /** The RTMP(S) server, without the key. */
  server: string;
  hasKey: boolean;
}

export interface DestinationInput {
  id?: string;
  service: Destination['service'];
  name: string;
  server: string;
  /** Left out to keep the one saved. */
  key?: string;
}

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  shellWindow: () => BrowserWindow | null;
  /** The display Din treats as primary (the one with the menu bar). */
  primaryBounds: () => Promise<Electron.Rectangle>;
}

let options: Options | null = null;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** FFmpeg: DinOS's, else one on PATH. */
function ffmpeg(): string | null {
  const named = process.env.DIN_FFMPEG;
  if (named) return fs.existsSync(named) ? named : null;
  return onPath('ffmpeg');
}

/** whisper.cpp's command-line tool and model: beside dictation's server on DinOS. */
function whisper(): { cli: string; model: string } | null {
  const model = process.env.DIN_WHISPER_MODEL;
  const server = process.env.DIN_WHISPER_SERVER;
  const cli = process.env.DIN_WHISPER_CLI ?? (server ? path.join(path.dirname(server), 'whisper-cli') : onPath('whisper-cli'));
  if (!model || !cli || !fs.existsSync(model) || !fs.existsSync(cli)) return null;
  return { cli, model };
}

function screenAvailable(): boolean {
  return !!process.env.WAYLAND_DISPLAY && findRecorder() !== null;
}

/** Run a tool to the end; rejects with what it last said that reads like an error. */
function run(binary: string, args: string[], nice = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (nice && child.pid) {
      try {
        os.setPriority(child.pid, 10);
      } catch {
        // It runs at the usual priority.
      }
    }
    let out = '';
    let log = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8192);
    });
    child.once('error', (error) => reject(error));
    child.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(lastError(log)))));
  });
}

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

function studioFolder(): string {
  return path.join(os.homedir(), 'Videos', 'Studio');
}

function named(value: unknown, what: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`Not a ${what}`);
  return path.resolve(value);
}

/** A take's folder from what a caller named: in a project's takes, or right inside Studio's from before projects. */
function takeFolder(take: unknown): string {
  const resolved = named(take, 'take');
  const parent = path.dirname(resolved);
  if (parent === studioFolder()) return resolved;
  if (path.basename(parent) === TAKES_DIR && path.dirname(path.dirname(parent)) === studioFolder()) return resolved;
  throw new Error('Not a take');
}

/** A project's folder from what a caller named: only folders right inside Studio's. */
function projectFolder(project: unknown): string {
  const resolved = named(project, 'project');
  if (path.dirname(resolved) !== studioFolder()) throw new Error('Not a project');
  return resolved;
}

/** The project a take is in, or null for one from before projects. */
function projectOf(take: string): string | null {
  const parent = path.dirname(take);
  return path.basename(parent) === TAKES_DIR && path.dirname(path.dirname(parent)) === studioFolder() ? path.dirname(parent) : null;
}

function today(): string {
  const date = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** A name a folder can have: no slashes, no leading dot, not too long. */
function folderName(text: string, fallback: string): string {
  const cleaned = text.replace(/[/\\\0:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return cleaned || fallback;
}

/** Make `<parent>/<base>`, or `<base> 2`, `<base> 3`… if it's taken. */
function newFolder(parent: string, base: string): string {
  fs.mkdirSync(parent, { recursive: true });
  for (let n = 1; ; n++) {
    const folder = path.join(parent, n === 1 ? base : `${base} ${n}`);
    try {
      fs.mkdirSync(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** "Take 3": the project's next number. */
function newTakeFolder(project: string): { folder: string; title: string } {
  const takes = path.join(project, TAKES_DIR);
  fs.mkdirSync(takes, { recursive: true });
  let n = 1;
  for (const name of fs.readdirSync(takes)) {
    const match = name.match(/^Take (\d+)$/);
    if (match) n = Math.max(n, Number(match[1]) + 1);
  }
  for (;;) {
    const folder = path.join(takes, `Take ${n}`);
    try {
      fs.mkdirSync(folder);
      return { folder, title: `Take ${n}` };
    } catch {
      n += 1;
    }
  }
}

type TakeJson = Record<string, unknown> & {
  title?: string;
  created?: string;
  duration?: number;
  scene?: StudioScene;
  aspect?: StudioAspect;
  status?: TakeInfo['status'];
  imported?: string;
  tracks?: Record<string, { file?: string } & Record<string, unknown>>;
  transcript?: { file?: string; status?: TranscriptState; error?: string };
};

interface ItemJson {
  take: string;
  keep?: boolean;
  note?: string;
  in?: number | null;
  out?: number | null;
}

type ProjectJson = Record<string, unknown> & {
  title?: string;
  created?: string;
  items?: ItemJson[];
};

async function readJson<T extends object>(file: string): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function readTake(folder: string): Promise<TakeJson | null> {
  return readJson<TakeJson>(path.join(folder, 'take.json'));
}

function readProject(folder: string): Promise<ProjectJson | null> {
  return readJson<ProjectJson>(path.join(folder, 'project.json'));
}

/** A folder's JSON file's writes, one at a time, each a whole file put in place at once. */
const jsonWrites = new Map<string, Promise<unknown>>();

function updateJson<T extends object>(file: string, change: (value: T) => T): Promise<T> {
  const previous = jsonWrites.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const value = change((await readJson<T>(file)) ?? ({} as T));
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}`);
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await fsp.rename(tmp, file);
    return value;
  });
  jsonWrites.set(file, next);
  void next.finally(() => {
    if (jsonWrites.get(file) === next) jsonWrites.delete(file);
  });
  return next;
}

function updateTake(folder: string, change: (take: TakeJson) => TakeJson): Promise<TakeJson> {
  return updateJson<TakeJson>(path.join(folder, 'take.json'), change);
}

function updateProjectJson(folder: string, change: (project: ProjectJson) => ProjectJson): Promise<ProjectJson> {
  return updateJson<ProjectJson>(path.join(folder, 'project.json'), change);
}

async function filesIn(folder: string): Promise<string[]> {
  try {
    return (await fsp.readdir(folder, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => path.join(folder, e.name))
      .sort();
  } catch {
    return [];
  }
}

function aspectOf(width: unknown, height: unknown): StudioAspect {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return '16:9';
  const ratio = w / h;
  return ratio > 1.2 ? '16:9' : ratio < 0.8 ? '9:16' : '1:1';
}

async function takeInfo(folder: string): Promise<TakeInfo | null> {
  const take = await readTake(folder);
  if (!take || take.format !== TAKE_FORMAT) return null;
  const existing = async (file: unknown) => {
    if (typeof file !== 'string' || file.includes('/')) return null;
    const full = path.join(folder, file);
    return fs.existsSync(full) ? full : null;
  };
  const status = take.status ?? 'ready';
  const clip = typeof take.imported === 'string';
  const program = take.tracks?.program;
  return {
    path: folder,
    name: path.basename(folder),
    project: projectOf(folder),
    kind: clip ? 'clip' : 'recording',
    title: typeof take.title === 'string' ? take.title : path.basename(folder),
    created: typeof take.created === 'string' ? take.created : new Date(0).toISOString(),
    duration: typeof take.duration === 'number' ? take.duration : 0,
    scene: take.scene ?? 'camera',
    aspect: take.aspect ?? (clip ? aspectOf(program?.width, program?.height) : '16:9'),
    // A take still "recording" or "finishing" that nothing here is working on was cut off (Din quit, a crash).
    status:
      status === 'recording' && current?.folder !== folder ? 'interrupted'
        : status === 'finishing' && clip && !importing.has(folder) ? 'interrupted'
          : status,
    transcript: take.transcript?.status ?? 'none',
    program: await existing(program?.file),
    poster: await existing('poster.jpg'),
    edits: await filesIn(path.join(folder, 'edits')),
  };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;
}

/** The takes in a project's takes folder, by folder name. */
async function takesIn(project: string): Promise<Map<string, TakeInfo>> {
  const dir = path.join(project, TAKES_DIR);
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    // None yet.
  }
  const infos = await Promise.all(names.map((n) => takeInfo(path.join(dir, n))));
  return new Map(infos.filter((t): t is TakeInfo => t !== null).map((t) => [t.name, t]));
}

/**
 * A project as it is on disk: project.json's order, with takes it doesn't
 * name yet (one being recorded, one copied in by hand) at the end, and
 * those that are gone (moved to the Trash) left out.
 */
async function projectInfo(folder: string): Promise<ProjectInfo | null> {
  const project = await readProject(folder);
  if (!project || project.format !== PROJECT_FORMAT) {
    // A take from before projects: a project of one, until it's opened.
    const take = await takeInfo(folder);
    if (!take) return null;
    return {
      path: folder,
      name: take.name,
      title: take.title,
      created: take.created,
      updated: take.created,
      items: [{ take, keep: true, note: '', in: null, out: null }],
      edits: take.edits,
      single: true,
    };
  }
  const takes = await takesIn(folder);
  const items: ProjectItem[] = [];
  for (const item of Array.isArray(project.items) ? project.items : []) {
    const take = item && typeof item.take === 'string' ? takes.get(item.take) : undefined;
    if (!take) continue;
    takes.delete(item.take);
    items.push({ take, keep: item.keep !== false, note: typeof item.note === 'string' ? item.note : '', in: finite(item.in), out: finite(item.out) });
  }
  for (const take of [...takes.values()].sort((a, b) => a.created.localeCompare(b.created))) {
    items.push({ take, keep: true, note: '', in: null, out: null });
  }
  const created = typeof project.created === 'string' ? project.created : new Date(0).toISOString();
  return {
    path: folder,
    name: path.basename(folder),
    title: typeof project.title === 'string' && project.title ? project.title : path.basename(folder),
    created,
    updated: items.reduce((latest, i) => (i.take.created > latest ? i.take.created : latest), created),
    items,
    edits: await filesIn(path.join(folder, 'edits')),
    single: false,
  };
}

async function listProjects(): Promise<ProjectInfo[]> {
  let names: string[];
  try {
    names = await fsp.readdir(studioFolder());
  } catch {
    return [];
  }
  const projects = await Promise.all(names.filter((n) => !n.startsWith('.')).map((n) => projectInfo(path.join(studioFolder(), n))));
  return projects.filter((p): p is ProjectInfo => p !== null).sort((a, b) => b.updated.localeCompare(a.updated));
}

async function listTakes(project?: string): Promise<TakeInfo[]> {
  const projects = project ? [await projectInfo(projectFolder(project))].filter((p): p is ProjectInfo => p !== null) : await listProjects();
  const takes = projects.flatMap((p) => p.items.map((i) => i.take));
  return project ? takes : takes.sort((a, b) => b.created.localeCompare(a.created));
}

async function writeProject(folder: string, title: string, created: string, items: ItemJson[]): Promise<void> {
  await updateProjectJson(folder, () => ({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    about: 'Takes and clips made with Din’s Studio, for the Assistant to make one thing from. The studio skill explains this folder.',
    title,
    created,
    items,
  }));
  await fsp.mkdir(path.join(folder, 'edits'), { recursive: true }).catch(() => {});
}

async function createProject(title: unknown): Promise<ProjectInfo> {
  const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'New Project';
  const folder = newFolder(studioFolder(), `${today()} ${folderName(name, 'Project')}`);
  await writeProject(folder, name, new Date().toISOString(), []);
  const info = await projectInfo(folder);
  if (!info) throw new Error('The project couldn’t be made');
  projectChanged(folder);
  return info;
}

/**
 * Make a take from before projects into a project of its own, in place: the
 * folder keeps its name and becomes the project, the take moves into its
 * takes folder, and what the Assistant made from it into the project's edits.
 */
async function openProject(project: unknown): Promise<ProjectInfo> {
  const folder = projectFolder(project);
  const existing = await projectInfo(folder);
  if (!existing) throw new Error('No such project');
  if (!existing.single) return existing;
  if (current?.folder === folder || transcribing.has(folder)) throw new Error('This take is busy; try again once it’s saved');
  const take = existing.items[0]!.take;
  const moving = path.join(studioFolder(), `.${path.basename(folder)}.${process.pid}`);
  await fsp.rename(folder, moving);
  try {
    await fsp.mkdir(path.join(folder, TAKES_DIR), { recursive: true });
    const name = folderName(take.title, 'Take 1');
    const moved = path.join(folder, TAKES_DIR, name);
    await fsp.rename(moving, moved);
    const edits = path.join(moved, 'edits');
    if (fs.existsSync(edits)) await fsp.rename(edits, path.join(folder, 'edits'));
    await writeProject(folder, take.title, take.created, [{ take: name, keep: true }]);
  } catch (error) {
    // Put it back as it was.
    if (fs.existsSync(moving)) {
      await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(moving, folder).catch(() => {});
    }
    throw error;
  }
  changed(path.join(folder, TAKES_DIR, folderName(take.title, 'Take 1')));
  const info = await projectInfo(folder);
  if (!info) throw new Error('No such project');
  return info;
}

/** project.json's items as they are now, every take in it named. */
async function currentItems(folder: string): Promise<ItemJson[]> {
  const info = await projectInfo(folder);
  if (!info || info.single) throw new Error('Not a project');
  return info.items.map((i) => ({
    take: i.take.name,
    keep: i.keep,
    ...(i.note ? { note: i.note } : {}),
    ...(i.in !== null ? { in: i.in } : {}),
    ...(i.out !== null ? { out: i.out } : {}),
  }));
}

async function changeProject(project: unknown, change: ProjectChange): Promise<ProjectInfo> {
  const folder = projectFolder(project);
  let items = await currentItems(folder);
  if (Array.isArray(change.order)) {
    const at = new Map(change.order.filter((n): n is string => typeof n === 'string').map((n, i) => [n, i]));
    // What the order leaves out stays after what it names, as it was.
    items = [...items].sort((a, b) => (at.get(a.take) ?? Infinity) - (at.get(b.take) ?? Infinity));
  }
  const item = change.item;
  if (item && typeof item.name === 'string') {
    const target = items.find((i) => i.take === item.name);
    if (!target) throw new Error('That take isn’t in this project');
    if (typeof item.keep === 'boolean') target.keep = item.keep;
    if (typeof item.note === 'string') {
      const note = item.note.trim().slice(0, 2000);
      if (note) target.note = note;
      else delete target.note;
    }
    for (const edge of ['in', 'out'] as const) {
      if (!(edge in item)) continue;
      const value = finite(item[edge]);
      if (value === null) delete target[edge];
      else target[edge] = value;
    }
    if (target.in !== undefined && target.out !== undefined && target.in !== null && target.out !== null && target.out <= target.in) {
      throw new Error('The end has to come after the start');
    }
  }
  const title = typeof change.title === 'string' && change.title.trim() ? change.title.trim().slice(0, 200) : undefined;
  await updateProjectJson(folder, (p) => ({ ...p, ...(title ? { title } : {}), items }));
  projectChanged(folder);
  const info = await projectInfo(folder);
  if (!info) throw new Error('No such project');
  return info;
}

/** A new take goes at the end of its project. */
async function addToProject(take: string): Promise<void> {
  const project = projectOf(take);
  if (!project) return;
  const name = path.basename(take);
  await updateProjectJson(project, (p) => {
    const items = Array.isArray(p.items) ? p.items : [];
    return items.some((i) => i?.take === name) ? p : { ...p, items: [...items, { take: name, keep: true }] };
  });
}

/** A take that's gone leaves its project's list, so a new one of the same name starts afresh. */
async function removeFromProject(take: string): Promise<void> {
  const project = projectOf(take);
  if (!project) return;
  const name = path.basename(take);
  await updateProjectJson(project, (p) => ({ ...p, items: (Array.isArray(p.items) ? p.items : []).filter((i) => i?.take !== name) })).catch(() => {});
}

function projectChanged(folder: string): void {
  void projectInfo(folder).then((project) => options?.sendToShell('capture:projectChanged', project ?? { path: folder, removed: true }));
}

function changed(folder: string): void {
  void takeInfo(folder).then((take) => options?.sendToShell('capture:changed', take ?? { path: folder, removed: true }));
  const project = projectOf(folder);
  if (project) projectChanged(project);
}

// ---------------------------------------------------------------------------
// Clips: files the user brings in
// ---------------------------------------------------------------------------

/** What FFmpeg says a file holds: its length and picture size, and whether it has sound. */
function probe(file: string): Promise<{ duration: number; width?: number; height?: number; video: boolean; audio: boolean }> {
  return new Promise((resolve) => {
    const tool = ffmpeg();
    if (!tool) {
      resolve({ duration: 0, video: true, audio: true });
      return;
    }
    const child = spawn(tool, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-65_536);
    });
    const done = () => {
      const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
      const v = log.match(/Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
      resolve({
        duration: d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) / 1000 : 0,
        ...(v ? { width: Number(v[1]), height: Number(v[2]) } : {}),
        video: /Stream #[^\n]*Video:/.test(log),
        audio: /Stream #[^\n]*Audio:/.test(log),
      });
    };
    child.once('exit', done);
    child.once('error', done);
  });
}

/** Clips being copied in: their folder, and the webContents writing them. */
const importing = new Map<string, number>();

/** The extension a clip's file keeps: its own, if it's a plain one. */
function clipFile(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return `clip.${/^[a-z0-9]{1,5}$/.test(ext) ? ext : 'mp4'}`;
}

/** Make a clip's folder in a project, for its file to be written into (`open`, `write`, `close`, then `importEnd`). */
async function importBegin(owner: number, project: unknown, name: unknown): Promise<{ take: string; file: string }> {
  const folder = projectFolder(project);
  const info = await projectInfo(folder);
  if (!info || info.single) throw new Error('Not a project');
  const original = typeof name === 'string' && name.trim() ? path.basename(name.trim()).slice(0, 200) : 'Clip';
  const title = original.replace(/\.[^.]+$/, '') || original;
  const take = newFolder(path.join(folder, TAKES_DIR), folderName(title, 'Clip'));
  const file = clipFile(original);
  importing.set(take, owner);
  watchOwner(owner);
  await updateTake(take, () => ({
    format: TAKE_FORMAT,
    version: TAKE_VERSION,
    about: 'A clip brought into Din’s Studio, for editing. The studio skill explains this folder.',
    title,
    imported: original,
    created: new Date().toISOString(),
    status: 'finishing',
  }));
  await addToProject(take);
  changed(take);
  return { take, file };
}

/** The clip is all there: read what's in it, give it a poster, and transcribe it. */
async function importEnd(take: unknown, discard: unknown): Promise<TakeInfo | null> {
  const folder = takeFolder(take);
  const json = await readTake(folder);
  if (!json || typeof json.imported !== 'string') throw new Error('Not a clip');
  importing.delete(folder);
  await closeWriters((w) => w.folder === folder);
  const file = clipFile(json.imported);
  const full = path.join(folder, file);
  if (discard === true || !fs.existsSync(full) || fs.statSync(full).size === 0) {
    await fsp.rm(folder, { recursive: true, force: true });
    await removeFromProject(folder);
    changed(folder);
    return null;
  }
  const info = await probe(full);
  if (!info.video && !info.audio) {
    await fsp.rm(folder, { recursive: true, force: true });
    await removeFromProject(folder);
    changed(folder);
    throw new Error(`${json.imported} isn’t a video or a sound file`);
  }
  const tool = ffmpeg();
  if (tool && info.video) {
    const at = info.duration > 2 ? 1 : 0;
    await run(tool, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', full, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', '-q:v', '4', path.join(folder, 'poster.jpg')]).catch(() => {});
  }
  const canTranscribe = info.audio && whisper() !== null && tool !== null;
  await updateTake(folder, (t) => ({
    ...t,
    status: 'ready',
    duration: info.duration,
    ...(info.width ? { canvas: { width: info.width, height: info.height } } : {}),
    tracks: {
      program: {
        file,
        start: 0,
        ...(info.width ? { width: info.width, height: info.height } : {}),
        ...(info.audio ? { audio: 'clip' } : {}),
      },
    },
    switches: [],
    markers: [],
    transcript: { file: 'transcript.json', status: canTranscribe ? 'working' : 'none' },
  }));
  changed(folder);
  if (canTranscribe) void transcribe(folder).catch(() => {});
  return takeInfo(folder);
}

/** Copy a file into a project as a clip: for the desktop's `din studio import`, which names files by path. */
async function importFile(owner: number, project: unknown, source: unknown): Promise<TakeInfo | null> {
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Not a file');
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw new Error(`${path.basename(source)} isn’t a file`);
  const { take, file } = await importBegin(owner, project, path.basename(source));
  try {
    await fsp.copyFile(source, path.join(take, file), fs.constants.COPYFILE_FICLONE);
  } catch (error) {
    await importEnd(take, true).catch(() => {});
    throw error;
  }
  return importEnd(take, false);
}

// ---------------------------------------------------------------------------
// Writing what the app records
// ---------------------------------------------------------------------------

/** What the app may write in a take: its tracks as they're recorded, and the poster. */
const WRITABLE = /^(\.[a-z]+\.webm|poster\.jpg)$/;

interface Writer {
  folder: string;
  file: string;
  handle: fsp.FileHandle;
  queue: Promise<unknown>;
  owner: number;
}

const writers = new Map<string, Writer>();

async function openWriter(owner: number, take: unknown, file: unknown): Promise<string> {
  const folder = takeFolder(take);
  if (typeof file !== 'string') throw new Error('Not a file Studio writes');
  // A clip's own file, only while it's being brought in, and only by who's bringing it.
  const clip = importing.get(folder) === owner && /^clip\.[a-z0-9]{1,5}$/.test(file);
  if (!WRITABLE.test(file) && !clip) throw new Error('Not a file Studio writes');
  const handle = await fsp.open(path.join(folder, file), 'w');
  const id = randomUUID();
  writers.set(id, { folder, file, handle, queue: Promise.resolve(), owner });
  return id;
}

function write(id: unknown, data: unknown): Promise<void> {
  const writer = typeof id === 'string' ? writers.get(id) : undefined;
  if (!writer) return Promise.reject(new Error('That file is closed'));
  if (!(data instanceof Uint8Array)) return Promise.reject(new Error('Not data'));
  const next = writer.queue.then(() => writer.handle.write(data));
  writer.queue = next.catch(() => {});
  return next.then(() => undefined);
}

async function closeWriter(id: string): Promise<void> {
  const writer = writers.get(id);
  if (!writer) return;
  writers.delete(id);
  await writer.queue;
  await writer.handle.close().catch(() => {});
}

async function closeWriters(match: (w: Writer) => boolean): Promise<void> {
  await Promise.all([...writers].filter(([, w]) => match(w)).map(([id]) => closeWriter(id)));
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

interface ScreenTrack {
  child: ChildProcess;
  exited: Promise<void>;
  /** Epoch milliseconds of its first frame. */
  start: number;
  width: number;
  height: number;
  audio: boolean;
  log: () => string;
}

interface Recording {
  folder: string;
  project: string;
  title: string;
  owner: number;
  startedAt: number;
  scene: StudioScene;
  aspect: StudioAspect;
  canvas: { width: number; height: number };
  screen: ScreenTrack | null;
}

let current: Recording | null = null;

function state(): CaptureState {
  return {
    recording: current ? { take: current.folder, title: current.title, project: current.project, startedAt: current.startedAt } : null,
    live: live ? liveStatus(live) : null,
  };
}

function publishState(): void {
  options?.sendToShell('capture:state', state());
}

/**
 * Start wf-recorder on the primary display, and wait for its first frame:
 * the screen track's place on the take's clock. FFmpeg says "Output #0" as
 * it writes the file's header, which is when the first frame came.
 */
function startScreen(file: string, area: Electron.Rectangle, audio: boolean, gpu: boolean): Promise<ScreenTrack | { error: string }> {
  return new Promise((resolve) => {
    const binary = findRecorder();
    if (!binary) {
      resolve({ error: 'wf-recorder isn’t installed' });
      return;
    }
    const spawned = Date.now();
    const child = spawn(binary, recorderArgs(area, file, audio ? 'system' : 'none', gpu), { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let settled = false;
    const exited = new Promise<void>((done) => {
      child.once('exit', () => done());
      child.once('error', () => done());
    });
    const started = (start: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ child, exited, start, width: area.width, height: area.height, audio, log: () => log });
    };
    const take = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8192);
      if (/Output #0|pts_time/.test(log)) started(Date.now());
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    // Still running and quiet: going by when it usually starts.
    const timer = setTimeout(() => started(spawned + 150), SCREEN_START_TIMEOUT_MS);
    void exited.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: lastError(log) });
    });
  });
}

async function begin(owner: number, request: TakeStart): Promise<{ take: string; title: string; project: string; screen: { start: number; width: number; height: number } | null }> {
  if (current) throw new Error('Studio is already recording');
  const scene: StudioScene = request.scene === 'screen' || request.scene === 'camera' ? request.scene : 'screen-camera';
  const aspect: StudioAspect = request.aspect === '9:16' || request.aspect === '1:1' ? request.aspect : '16:9';
  const canvas = {
    width: Math.max(16, Math.min(7680, Math.round(Number(request.canvas?.width) || 1920))),
    height: Math.max(16, Math.min(7680, Math.round(Number(request.canvas?.height) || 1080))),
  };
  // Into the project asked for (a take from before projects becomes one), else a new one.
  let project: string;
  // One that's gone (moved to the Trash meanwhile) gets a new one too.
  if (typeof request.project === 'string' && request.project && fs.existsSync(projectFolder(request.project))) project = (await openProject(request.project)).path;
  else project = (await createProject(undefined)).path;
  if (current) throw new Error('Studio is already recording');
  const { folder, title: numbered } = newTakeFolder(project);
  const title = typeof request.title === 'string' && request.title.trim() ? request.title.trim().slice(0, 200) : numbered;

  let screenTrack: ScreenTrack | null = null;
  if (request.screen && screenAvailable() && options) {
    const area = await options.primaryBounds();
    const file = path.join(folder, 'screen.mp4');
    const audio = request.screen.audio === true;
    let started = fs.existsSync(RENDER_NODE) ? await startScreen(file, area, audio, true) : { error: 'no GPU' };
    if ('error' in started) started = await startScreen(file, area, audio, false);
    if ('error' in started) console.error('[capture] the screen track didn’t start:', started.error);
    else screenTrack = started;
  }

  current = { folder, project, title, owner, startedAt: Date.now(), scene, aspect, canvas, screen: screenTrack };
  await updateTake(folder, () => ({
    format: TAKE_FORMAT,
    version: TAKE_VERSION,
    about: 'A recording made with Din’s Studio, for editing. The studio skill explains this folder.',
    title,
    created: new Date().toISOString(),
    status: 'recording',
    scene,
    aspect,
  }));
  await addToProject(folder);
  // A window that closes mid-take leaves what it recorded, finished.
  watchOwner(owner);
  publishState();
  changed(folder);
  return {
    take: folder,
    title,
    project,
    screen: screenTrack ? { start: screenTrack.start, width: screenTrack.width, height: screenTrack.height } : null,
  };
}

async function stopScreen(track: ScreenTrack | null): Promise<void> {
  if (!track) return;
  track.child.kill('SIGINT');
  const killer = setTimeout(() => track.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await track.exited;
  clearTimeout(killer);
}

/** Seconds on the take's clock. */
function clock(at: number, startedAt: number): number {
  return Math.round(((at - startedAt) / 1000) * 1000) / 1000;
}

function fraction(rect: unknown): Rect | null {
  if (!rect || typeof rect !== 'object') return null;
  const r = rect as Record<string, unknown>;
  const n = (v: unknown) => Math.round((Number.isFinite(Number(v)) ? Number(v) : 0) * 10_000) / 10_000;
  return { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
}

/**
 * Turn a track recorded as WebM into the file the take keeps: an MP4 (Ogg
 * for sound alone) with the same streams, put where players and editors can
 * seek in it. Without FFmpeg the WebM is kept as it is.
 */
async function finishTrack(folder: string, recorded: string, name: string, audioOnly: boolean): Promise<string | null> {
  const source = path.join(folder, recorded);
  if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
    fs.rmSync(source, { force: true });
    return null;
  }
  const tool = ffmpeg();
  if (tool) {
    const file = audioOnly ? `${name}.ogg` : `${name}.mp4`;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-i', source, '-map', '0', '-c', 'copy'];
    if (!audioOnly) args.push('-movflags', '+faststart');
    args.push(path.join(folder, file));
    try {
      await run(tool, args);
      fs.rmSync(source, { force: true });
      return file;
    } catch (error) {
      console.error(`[capture] couldn’t finish ${recorded}:`, error);
      fs.rmSync(path.join(folder, file), { force: true });
    }
  }
  const file = `${name}.webm`;
  fs.renameSync(source, path.join(folder, file));
  return file;
}

async function end(request: TakeEnd): Promise<TakeInfo | null> {
  const recording = current;
  if (!recording) throw new Error('Studio isn’t recording');
  current = null;
  publishState();
  const { folder } = recording;
  await stopScreen(recording.screen);
  await closeWriters((w) => w.folder === folder);

  if (request.discard) {
    await fsp.rm(folder, { recursive: true, force: true });
    await removeFromProject(folder);
    changed(folder);
    return null;
  }

  await updateTake(folder, (take) => ({ ...take, status: 'finishing' }));
  changed(folder);

  const startedAt = Number.isFinite(request.startedAt) ? request.startedAt : recording.startedAt;
  const tracks: Record<string, Record<string, unknown>> = {};
  const recorded = request.tracks ?? {};
  for (const name of ['program', 'camera', 'mic'] as const) {
    const track = recorded[name];
    if (!track || typeof track.file !== 'string' || !WRITABLE.test(track.file)) continue;
    const file = await finishTrack(folder, track.file, name, name === 'mic');
    if (!file) continue;
    tracks[name] = {
      file,
      start: clock(Number(track.start) || startedAt, startedAt),
      ...(track.width ? { width: track.width, height: track.height } : {}),
      ...(name === 'camera' ? { mirrored: track.mirrored === true } : {}),
      ...(typeof track.audio === 'string' ? { audio: track.audio } : {}),
    };
  }
  const screenTrack = recording.screen;
  if (screenTrack && fs.existsSync(path.join(folder, 'screen.mp4')) && fs.statSync(path.join(folder, 'screen.mp4')).size > 0) {
    tracks.screen = {
      file: 'screen.mp4',
      start: clock(screenTrack.start, startedAt),
      width: screenTrack.width,
      height: screenTrack.height,
      pointer: true,
      audio: screenTrack.audio ? 'computer' : null,
    };
  }

  const switches = (Array.isArray(request.switches) ? request.switches : []).slice(0, 10_000).map((s) => ({
    time: Math.max(0, clock(Number(s.at), startedAt)),
    scene: s.scene,
    camera: s.camera ? { ...fraction(s.camera), shape: String(s.camera.shape) } : null,
    screen: fraction(s.screen),
  }));
  const markers = (Array.isArray(request.markers) ? request.markers : []).slice(0, 10_000).map((m) => ({
    time: Math.max(0, clock(Number(m.at), startedAt)),
    kind: m.kind === 'retake' ? 'retake' : 'highlight',
  }));
  // Where the Assistant puts what it makes.
  await fsp.mkdir(path.join(folder, 'edits'), { recursive: true }).catch(() => {});
  const willTranscribe = !!tracks.mic && whisper() !== null && ffmpeg() !== null;
  await updateTake(folder, (take) => ({
    ...take,
    status: 'ready',
    duration: Math.round(Math.max(0, Number(request.durationMs) || 0)) / 1000,
    canvas: recording.canvas,
    tracks,
    switches,
    markers,
    transcript: { file: 'transcript.json', status: willTranscribe ? 'working' : 'none' },
  }));
  changed(folder);
  if (willTranscribe) void transcribe(folder).catch(() => {});
  return takeInfo(folder);
}

/** A window that was recording or streaming went away: finish what it left. */
const watchedOwners = new Set<number>();

function watchOwner(owner: number): void {
  if (watchedOwners.has(owner)) return;
  const contents = webContents.fromId(owner);
  if (!contents) return;
  watchedOwners.add(owner);
  const navigated = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) gone();
  };
  const gone = () => {
    if (!watchedOwners.delete(owner)) return;
    if (!contents.isDestroyed()) contents.off('did-start-navigation', navigated);
    abandon(owner);
  };
  contents.once('destroyed', gone);
  contents.on('did-start-navigation', navigated);
}

function abandon(owner: number): void {
  if (current?.owner === owner) {
    const recording = current;
    const recordedFile = (name: string) => (fs.existsSync(path.join(recording.folder, `.${name}.webm`)) ? `.${name}.webm` : '');
    const tracks: TakeEnd['tracks'] = {};
    for (const name of ['program', 'camera', 'mic'] as const) {
      const file = recordedFile(name);
      if (file) tracks[name] = { file, start: recording.startedAt };
    }
    void end({ startedAt: recording.startedAt, durationMs: Date.now() - recording.startedAt, tracks, switches: [], markers: [] })
      .then(() => updateTake(recording.folder, (take) => ({ ...take, status: 'interrupted' })))
      .then(() => changed(recording.folder))
      .catch((error: unknown) => console.error('[capture] finishing an abandoned take:', error));
  } else {
    void closeWriters((w) => w.owner === owner);
  }
  for (const [folder, by] of importing) {
    if (by === owner) void importEnd(folder, true).catch(() => {});
  }
  if (live?.owner === owner) void stopStream();
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

interface Word {
  start: number;
  end: number;
  text: string;
}

/** The language to listen for, from the system's locale, as dictation does. */
function language(): string {
  const code = app.getLocale().split(/[-_]/)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(code) ? code : 'auto';
}

/** Sentences, from words: a break at their end, or at a pause. */
function sentences(words: Word[]): Word[] {
  const out: Word[] = [];
  let open: Word | null = null;
  for (const [i, word] of words.entries()) {
    if (!open) open = { ...word };
    else {
      open.end = word.end;
      open.text += ` ${word.text}`;
    }
    const next = words[i + 1];
    if (!next || /[.!?…]["”’)]?$/.test(word.text) || next.start - word.end > 0.8) {
      out.push(open);
      open = null;
    }
  }
  return out;
}

const transcribing = new Map<string, Promise<void>>();

/** Every word spoken on the take's microphone, with its time on the take's clock: transcript.json. */
function transcribe(folder: string): Promise<void> {
  const running = transcribing.get(folder);
  if (running) return running;
  const job = (async () => {
    const tools = whisper();
    const tool = ffmpeg();
    if (!tools || !tool) {
      throw new Error(process.env.DIN_FEATURES && !tools
        ? 'Transcripts aren’t set up yet. Install Dictation & transcripts in Settings → Optional Features.'
        : 'Transcription isn’t available here');
    }
    const take = await readTake(folder);
    // A clip's own sound, which is all it has.
    const mic = take?.tracks?.mic ?? (typeof take?.imported === 'string' ? take.tracks?.program : undefined);
    if (!mic?.file) throw new Error(typeof take?.imported === 'string' ? 'This clip has no sound' : 'This take has no microphone');
    await updateTake(folder, (t) => ({ ...t, transcript: { file: 'transcript.json', status: 'working' } }));
    changed(folder);
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'din-studio-'));
    try {
      const wav = path.join(scratch, 'speech.wav');
      await run(tool, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(folder, mic.file), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], true);
      const base = path.join(scratch, 'speech');
      // One word to a segment (-ml 1, split on words), as JSON.
      await run(tools.cli, ['-m', tools.model, '-f', wav, '-l', language(), '-ml', '1', '-sow', '-sns', '-oj', '-of', base, '-np'], true);
      const parsed = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')) as {
        result?: { language?: string };
        transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
      };
      const offset = typeof mic.start === 'number' ? mic.start : 0;
      // Whisper makes up words past the end of what it heard; the take's length bounds them.
      const length = typeof take?.duration === 'number' && take.duration > 0 ? take.duration : Infinity;
      const words: Word[] = [];
      for (const item of parsed.transcription ?? []) {
        const text = (item.text ?? '').trim();
        if (!text || /^\[.*\]$/.test(text)) continue;
        const at = (ms: number | undefined) => Math.round((offset + (ms ?? 0) / 1000) * 1000) / 1000;
        const start = at(item.offsets?.from);
        if (start >= length) continue;
        words.push({ start, end: Math.min(at(item.offsets?.to), length), text });
      }
      const transcript = {
        about: 'Every word spoken, with when it starts and ends in seconds on the take’s clock (as take.json’s times).',
        language: parsed.result?.language ?? language(),
        text: words.map((w) => w.text).join(' '),
        sentences: sentences(words),
        words,
      };
      await fsp.writeFile(path.join(folder, 'transcript.json'), `${JSON.stringify(transcript, null, 1)}\n`);
      await updateTake(folder, (t) => ({ ...t, transcript: { file: 'transcript.json', status: 'done' } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateTake(folder, (t) => ({ ...t, transcript: { file: 'transcript.json', status: 'failed', error: message } }));
      throw error;
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
      changed(folder);
    }
  })();
  transcribing.set(folder, job);
  void job.finally(() => transcribing.delete(folder)).catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

interface StoredDestination {
  id: string;
  service: Destination['service'];
  name: string;
  server: string;
  /** `enc:` + safeStorage ciphertext (base64), or `plain:` where there's no keyring; empty for none. */
  key: string;
}

function destinationsFile(): string {
  return path.join(app.getPath('userData'), 'studio', 'destinations.json');
}

function seal(secret: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(secret).toString('base64')}`;
  return `plain:${Buffer.from(secret, 'utf8').toString('base64')}`;
}

function unseal(sealed: string): string {
  if (sealed.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'));
  if (sealed.startsWith('plain:')) return Buffer.from(sealed.slice(6), 'base64').toString('utf8');
  return '';
}

function loadDestinations(): StoredDestination[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(destinationsFile(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as StoredDestination[]).filter((d) => d && typeof d.id === 'string') : [];
  } catch {
    return [];
  }
}

function saveDestinations(list: StoredDestination[]): void {
  fs.mkdirSync(path.dirname(destinationsFile()), { recursive: true });
  fs.writeFileSync(destinationsFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

function publicDestination(d: StoredDestination): Destination {
  return { id: d.id, service: d.service, name: d.name, server: d.server, hasKey: d.key !== '' };
}

const SERVICES = new Set<Destination['service']>(['youtube', 'twitch', 'kick', 'custom']);

function saveDestination(input: DestinationInput): Destination {
  const service = SERVICES.has(input?.service) ? input.service : 'custom';
  const server = typeof input?.server === 'string' ? input.server.trim() : '';
  if (!/^rtmps?:\/\/[^\s/]+/i.test(server)) throw new Error('The server should start with rtmp:// or rtmps://');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : 'Custom';
  const list = loadDestinations();
  const existing = typeof input.id === 'string' ? list.find((d) => d.id === input.id) : undefined;
  const key = typeof input.key === 'string' && input.key.trim() ? seal(input.key.trim()) : existing?.key ?? '';
  const stored: StoredDestination = { id: existing?.id ?? randomUUID(), service, name, server, key };
  saveDestinations(existing ? list.map((d) => (d.id === stored.id ? stored : d)) : [...list, stored]);
  return publicDestination(stored);
}

interface Live {
  owner: number;
  destination: string;
  child: ChildProcess;
  phase: LiveStatus['phase'];
  startedAt: number;
  bitrate: number | null;
  log: string;
  exited: Promise<number | null>;
}

let live: Live | null = null;

function liveStatus(l: Live): LiveStatus {
  const backlog = l.child.stdin?.writableLength ?? 0;
  return {
    destination: l.destination,
    phase: l.phase,
    startedAt: l.startedAt,
    bitrate: l.bitrate,
    backlog,
    behind: backlog > STREAM_BACKLOG_WARN,
  };
}

/** What went wrong with a stream, in words for the person streaming. */
function streamError(log: string): string {
  if (/Connection refused|Cannot open connection|Failed to resolve|Name or service not known/i.test(log)) {
    return 'Couldn’t reach the streaming server. Check the server address and your connection.';
  }
  if (/Input\/output error|Broken pipe|Server error|NetStream\.Publish\.BadName|403|401/i.test(log)) {
    return 'The streaming server ended the stream. Check that the stream key is right and that the stream is set up on the service.';
  }
  return lastError(log);
}

function startStream(owner: number, id: unknown): LiveStatus {
  if (live) throw new Error('Already live');
  const tool = ffmpeg();
  if (!tool) throw new Error('Going live needs FFmpeg, which isn’t installed');
  const destination = loadDestinations().find((d) => d.id === id);
  if (!destination) throw new Error('No such destination');
  const key = destination.key ? unseal(destination.key) : '';
  const url = key ? `${destination.server.replace(/\/+$/, '')}/${key}` : destination.server;
  // The picture is already H.264: copied through. RTMP needs AAC sound.
  const child = spawn(
    tool,
    [
      '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '2',
      '-fflags', '+genpts', '-f', 'matroska', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-f', 'flv', '-flvflags', 'no_duration_filesize', url,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  const started: Live = {
    owner,
    destination: destination.name,
    child,
    phase: 'connecting',
    startedAt: Date.now(),
    bitrate: null,
    log: '',
    exited: new Promise((done) => {
      child.once('exit', (code) => done(code));
      child.once('error', () => done(null));
    }),
  };
  child.stdin?.on('error', () => {});
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    started.log = (started.log + text).slice(-8192);
    // "frame=  120 fps= 30 ... time=00:00:04.00 bitrate=6012.3kbits/s speed=1x"
    const stats = [...text.matchAll(/time=(\d+):(\d+):([\d.]+).*?bitrate=\s*([\d.]+)kbits/g)].at(-1);
    if (!stats) return;
    const seconds = Number(stats[1]) * 3600 + Number(stats[2]) * 60 + Number(stats[3]);
    started.bitrate = Math.round(Number(stats[4]));
    if (started.phase === 'connecting' && seconds > 0) {
      started.phase = 'live';
      started.startedAt = Date.now() - seconds * 1000;
    }
    publishState();
  });
  live = started;
  watchOwner(owner);
  void started.exited.then((code) => {
    if (live !== started) return;
    live = null;
    const asked = started.phase === 'ending';
    publishState();
    options?.sendToShell('capture:streamEnded', {
      destination: started.destination,
      durationMs: Date.now() - started.startedAt,
      error: asked && code === 0 ? null : streamError(started.log),
    });
  });
  publishState();
  return liveStatus(started);
}

function streamWrite(data: unknown): void {
  const l = live;
  if (!l || l.phase === 'ending' || !(data instanceof Uint8Array) || !l.child.stdin?.writable) return;
  if (l.child.stdin.writableLength > STREAM_BACKLOG_MAX) {
    l.log += '\nYour connection couldn’t keep up with the stream';
    void stopStream();
    return;
  }
  l.child.stdin.write(data);
}

async function stopStream(): Promise<void> {
  const l = live;
  if (!l || l.phase === 'ending') return;
  l.phase = 'ending';
  publishState();
  l.child.stdin?.end();
  const killer = setTimeout(() => l.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  const soft = setTimeout(() => l.child.kill('SIGINT'), 3000);
  await l.exited;
  clearTimeout(killer);
  clearTimeout(soft);
}

// ---------------------------------------------------------------------------
// Where the screen is
// ---------------------------------------------------------------------------

/** The primary display within the shell window, as fractions of it. */
async function screenRect(): Promise<Rect> {
  const win = options?.shellWindow();
  if (!win || !options) return { x: 0, y: 0, width: 1, height: 1 };
  const shell = win.getContentBounds();
  const display = await options.primaryBounds();
  if (!shell.width || !shell.height) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.max(0, (display.x - shell.x) / shell.width);
  const y = Math.max(0, (display.y - shell.y) / shell.height);
  return {
    x,
    y,
    width: Math.min(1 - x, display.width / shell.width),
    height: Math.min(1 - y, display.height / shell.height),
  };
}

let primary: Electron.Rectangle | null = null;

/**
 * Where the desktop last saw the pointer, in screen DIPs. On Wayland
 * Electron can't tell where the pointer is (getCursorScreenPoint stays at
 * 0,0), but the desktop sees it move everywhere Din draws, so while
 * something asks, main asks the desktop to say (src/lib/capturePointer.ts).
 */
let reported: { x: number; y: number } | null = null;
/** Until when the desktop has been asked to report it. */
let reportingUntil = 0;
/** How long one ask lasts; the desktop reports a while longer, so asks in a row overlap. */
const REPORT_MS = 2_000;

/** Where the pointer is on the primary display, as fractions of it (outside it: off 0..1). */
function pointer(): { x: number; y: number } {
  const now = Date.now();
  if (now >= reportingUntil) options?.sendToShell('capture:reportPointer');
  reportingUntil = now + REPORT_MS;
  const point = reported ?? screen.getCursorScreenPoint();
  const area = primary ?? screen.getPrimaryDisplay().bounds;
  return { x: (point.x - area.x) / area.width, y: (point.y - area.y) / area.height };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerCaptureHandlers(opts: Options): void {
  options = opts;
  const { assertShellSender } = opts;
  const refreshPrimary = () => void opts.primaryBounds().then((b) => (primary = b), () => {});
  refreshPrimary();
  screen.on('display-metrics-changed', refreshPrimary);
  screen.on('display-added', refreshPrimary);
  screen.on('display-removed', refreshPrimary);

  ipcMain.handle('capture:status', async (event): Promise<CaptureStatus> => {
    assertShellSender(event);
    return {
      folder: studioFolder(),
      screen: screenAvailable(),
      ffmpeg: ffmpeg() !== null,
      transcribe: whisper() !== null && ffmpeg() !== null,
      screenRect: await screenRect(),
      state: state(),
    };
  });

  ipcMain.handle('capture:pointer', (event) => {
    assertShellSender(event);
    return pointer();
  });

  // The pointer's arrow, and the primary display's height it's drawn against.
  ipcMain.handle('capture:pointerImage', async (event) => {
    assertShellSender(event);
    const arrow = await pointerArrow();
    const area = primary ?? screen.getPrimaryDisplay().bounds;
    return arrow ? { ...arrow, displayHeight: area.height } : null;
  });

  // The desktop's report of the pointer, in CSS pixels of its window.
  ipcMain.on('capture:pointerAt', (event, x: unknown, y: unknown) => {
    assertShellSender(event);
    const shell = opts.shellWindow();
    if (!shell || shell.isDestroyed() || typeof x !== 'number' || typeof y !== 'number') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const zoom = shell.webContents.getZoomFactor();
    const bounds = shell.getContentBounds();
    reported = { x: bounds.x + x * zoom, y: bounds.y + y * zoom };
  });

  ipcMain.handle('capture:takes', async (event, project: unknown) => {
    assertShellSender(event);
    return listTakes(typeof project === 'string' ? project : undefined);
  });

  ipcMain.handle('capture:projects', async (event) => {
    assertShellSender(event);
    return listProjects();
  });

  ipcMain.handle('capture:project', async (event, project: unknown) => {
    assertShellSender(event);
    return projectInfo(projectFolder(project));
  });

  ipcMain.handle('capture:createProject', async (event, title: unknown) => {
    assertShellSender(event);
    return createProject(title);
  });

  ipcMain.handle('capture:openProject', async (event, project: unknown) => {
    assertShellSender(event);
    return openProject(project);
  });

  ipcMain.handle('capture:updateProject', async (event, project: unknown, change: unknown) => {
    assertShellSender(event);
    return changeProject(project, (change && typeof change === 'object' ? change : {}) as ProjectChange);
  });

  ipcMain.handle('capture:importBegin', async (event, project: unknown, name: unknown) => {
    assertShellSender(event);
    return importBegin(event.sender.id, project, name);
  });

  ipcMain.handle('capture:importEnd', async (event, take: unknown, discard: unknown) => {
    assertShellSender(event);
    return importEnd(take, discard);
  });

  // By path: the desktop's alone (`din studio import`). Apps bring files in
  // through importBegin, writing what the user handed them; this isn't on
  // their bridge (din-apps.mts), or it would read any file by its path.
  ipcMain.handle('capture:importFile', async (event, project: unknown, file: unknown) => {
    assertShellSender(event);
    return importFile(event.sender.id, project, file);
  });

  ipcMain.handle('capture:take', async (event, take: unknown) => {
    assertShellSender(event);
    return takeInfo(takeFolder(take));
  });

  ipcMain.handle('capture:rename', async (event, take: unknown, title: unknown) => {
    assertShellSender(event);
    const folder = takeFolder(take);
    if (typeof title !== 'string' || !title.trim()) throw new Error('A take needs a name');
    await updateTake(folder, (t) => ({ ...t, title: title.trim().slice(0, 200) }));
    if (current?.folder === folder) {
      current.title = title.trim().slice(0, 200);
      publishState();
    }
    changed(folder);
  });

  ipcMain.handle('capture:begin', (event, request: unknown) => {
    assertShellSender(event);
    return begin(event.sender.id, (request && typeof request === 'object' ? request : {}) as TakeStart);
  });

  ipcMain.handle('capture:end', (event, request: unknown) => {
    assertShellSender(event);
    return end((request && typeof request === 'object' ? request : {}) as TakeEnd);
  });

  ipcMain.handle('capture:open', (event, take: unknown, file: unknown) => {
    assertShellSender(event);
    return openWriter(event.sender.id, take, file);
  });

  ipcMain.handle('capture:write', (event, id: unknown, data: unknown) => {
    assertShellSender(event);
    return write(id, data);
  });

  ipcMain.handle('capture:close', async (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id === 'string') await closeWriter(id);
  });

  ipcMain.handle('capture:transcribe', async (event, take: unknown) => {
    assertShellSender(event);
    await transcribe(takeFolder(take));
  });

  ipcMain.handle('capture:destinations', (event) => {
    assertShellSender(event);
    return loadDestinations().map(publicDestination);
  });

  ipcMain.handle('capture:saveDestination', (event, input: unknown) => {
    assertShellSender(event);
    return saveDestination((input ?? {}) as DestinationInput);
  });

  ipcMain.handle('capture:removeDestination', (event, id: unknown) => {
    assertShellSender(event);
    saveDestinations(loadDestinations().filter((d) => d.id !== id));
  });

  ipcMain.handle('capture:streamStart', (event, id: unknown) => {
    assertShellSender(event);
    return startStream(event.sender.id, id);
  });

  ipcMain.on('capture:streamWrite', (event, data: unknown) => {
    assertShellSender(event);
    streamWrite(data);
  });

  ipcMain.handle('capture:streamStop', async (event) => {
    assertShellSender(event);
    await stopStream();
  });

  // Every few seconds while live: how far behind the connection is.
  setInterval(() => {
    if (live) publishState();
  }, 2000).unref();
}

/** On the way out: finish the screen track and end a stream, so neither is left running. */
export function stopCapture(): void {
  current?.screen?.child.kill('SIGINT');
  live?.child.stdin?.end();
}

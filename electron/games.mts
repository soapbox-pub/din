// Games (din.system.games, for the Games app in src/apps/games/, and
// window.dinos.games for `din games`), behind the `games:*` channels.
//
// The games are in ~/roms, a folder per system as RetroArch lays them out
// (game-library.mts reads them, game-names.mts their names). Playing one
// runs RetroArch from DinOS's Games feature (os/configuration.nix, found
// through DIN_GAMES) with the system's core, full screen on Din's embedded
// display as an app of its own named for the game (native-apps.mts'
// launchAsApp), where a full-screen window's frames go straight to the
// screen. RetroArch is set up here, in ~/.local/share/din/games, and never
// reads or writes ~/.config/retroarch, so someone's own RetroArch is left
// as it is:
//
//   - Vulkan, PipeWire, SDL's controllers with RetroArch's autoconfig
//     profiles, so a controller works the moment it's plugged in.
//   - Where a game was left is saved when it quits and picked up when it
//     starts again (savestate_auto_save/load), with a picture of the moment
//     for the library. In-game saves are kept too. Both are per system.
//   - Little lag: two swapchain images, automatic frame delay, and a frame
//     of run-ahead on the cores that can (RUN_AHEAD_CORES); the frames go
//     straight to the screen (the compositor's session/direct.rs).
//   - Pixel art is scaled sharp (sharp-bilinear), never blurred or uneven.
//   - The window pauses the game when it isn't the one in front.
//   - Start+Select quits back to the library; Escape does on a keyboard;
//     the Home button (or L3+R3) opens RetroArch's menu.
//   - BIOS files a system needs are taken from its folder's "[BIOS] …" zip,
//     or from ~/roms/bios, into RetroArch's system folder.
//
// The app names a game by its id and a copy by one of its own paths, never
// a file or a program of its choosing: what runs is decided here. Runs as
// TypeScript directly via Node's native type stripping - erasable syntax
// only, like the rest of electron/.

import { execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, ipcMain, nativeImage, net } from 'electron';
import type { Game, GameSystem, GamesChange, GamesLibrary, GamesStatus, PlayOptions, RunningGame } from '../src/lib/games.ts';
import { ArtIndex, scanSystem, systemFolders, type ScannedGame, type ScannedSystem } from './game-library.mts';
import { regionPreference } from './game-names.mts';
import { CORE_OPTIONS, RUN_AHEAD_CORES, type SystemDef } from './game-systems.mts';
import { launchAsApp } from './native-apps.mts';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const ROOT = path.join(HOME, 'roms');
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'din', 'games');
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'din', 'games');
const STATE_FILE = path.join(DATA, 'library.json');
const RA = path.join(DATA, 'retroarch');
const SAVES = path.join(DATA, 'saves');
const STATES = path.join(DATA, 'states');
const SYSTEM_DIR = path.join(DATA, 'system');
/** How long a quitting game has to save where it was before it's killed. */
const QUIT_GRACE_MS = 8000;

interface Deps {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, ...args: unknown[]) => void;
}

let deps: Deps | null = null;

// ---------------------------------------------------------------------------
// The emulators
// ---------------------------------------------------------------------------

interface Tools {
  retroarch: string;
  /** Cores by name ("bsnes"), their .so files. */
  cores: Map<string, string>;
  assets: string | null;
  autoconfig: string | null;
  info: string | null;
  shaders: string | null;
}

function existing(p: string | null | undefined): string | null {
  return p && fs.existsSync(p) ? p : null;
}

function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const file = dir && path.join(dir, command);
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function coresIn(dirs: string[]): Map<string, string> {
  const cores = new Map<string, string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(.+)_libretro\.so$/.exec(name);
      if (m && !cores.has(m[1])) cores.set(m[1], path.join(dir, name));
    }
  }
  return cores;
}

let toolsCache: { at: number; tools: Tools | null } | null = null;

/** RetroArch and its cores: DinOS's Games feature, else what this computer has installed. */
function tools(): Tools | null {
  if (toolsCache && Date.now() - toolsCache.at < 5000) return toolsCache.tools;
  let found: Tools | null = null;
  const feature = process.env.DIN_GAMES;
  if (feature && fs.existsSync(path.join(feature, 'retroarch', 'bin', 'retroarch'))) {
    let parts: string[];
    try {
      parts = fs.readdirSync(feature);
    } catch {
      parts = [];
    }
    found = {
      retroarch: path.join(feature, 'retroarch', 'bin', 'retroarch'),
      cores: coresIn(parts.filter((p) => p.startsWith('core-')).map((p) => path.join(feature, p, 'lib', 'retroarch', 'cores'))),
      assets: existing(path.join(feature, 'assets', 'share', 'retroarch', 'assets')),
      autoconfig: existing(path.join(feature, 'autoconfig', 'share', 'libretro', 'autoconfig')),
      info: existing(path.join(feature, 'core-info', 'share', 'retroarch', 'cores')),
      shaders: existing(path.join(feature, 'shaders', 'share', 'libretro', 'shaders', 'shaders_slang')),
    };
  } else {
    const retroarch = which('retroarch');
    if (retroarch) {
      let real: string;
      try {
        real = fs.realpathSync(retroarch);
      } catch {
        real = retroarch;
      }
      const prefix = path.dirname(path.dirname(real));
      found = {
        retroarch,
        cores: coresIn([
          path.join(prefix, 'lib', 'retroarch', 'cores'),
          '/usr/lib/libretro',
          '/usr/lib/x86_64-linux-gnu/libretro',
          '/usr/lib64/libretro',
          path.join(HOME, '.config', 'retroarch', 'cores'),
        ]),
        assets: existing(path.join(prefix, 'share', 'retroarch', 'assets')) ?? existing('/usr/share/libretro/assets'),
        autoconfig: existing(path.join(prefix, 'share', 'libretro', 'autoconfig')) ?? existing('/usr/share/libretro/autoconfig'),
        info: existing(path.join(prefix, 'share', 'retroarch', 'cores')) ?? existing('/usr/share/libretro/info'),
        shaders: existing(path.join(prefix, 'share', 'libretro', 'shaders', 'shaders_slang')) ?? existing('/usr/share/libretro/shaders/shaders_slang'),
      };
    }
  }
  toolsCache = { at: Date.now(), tools: found };
  return found;
}

/** Why a system's games can't be played here, or null when they can. */
function unavailable(def: SystemDef, t: Tools | null, scanned: ScannedSystem | undefined): string | null {
  if (!def.core) return `Din can’t play ${def.name} games yet.`;
  if (!t) return process.env.DIN_FEATURES ? 'Install Games in Settings → Optional Features to play.' : 'Install RetroArch to play.';
  if (!t.cores.has(def.core)) return `The emulator for ${def.name} games isn’t installed.`;
  if (def.bios?.required && !biosSource(def, scanned) && !fs.existsSync(path.join(SYSTEM_DIR, def.bios.file))) {
    return `${def.name} games need its BIOS, ${def.bios.file}, in ${path.join(ROOT, 'bios')}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

interface Played {
  /** Last played, ms since the epoch. */
  last: number;
  /** Seconds played. */
  time: number;
  /** What RetroArch was given last, whose saved moment is the game's. */
  content?: string;
}

interface LibraryState {
  favorites: Record<string, true>;
  versions: Record<string, string>;
  played: Record<string, Played>;
}

let state: LibraryState | null = null;

function libraryState(): LibraryState {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<LibraryState>;
    state = { favorites: raw.favorites ?? {}, versions: raw.versions ?? {}, played: raw.played ?? {} };
  } catch {
    state = { favorites: {}, versions: {}, played: {} };
  }
  return state;
}

let saveTimer: NodeJS.Timeout | null = null;
function saveState(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = libraryState();
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

const scans = new Map<string, ScannedSystem>();
let preference: string[] | null = null;
const art = new ArtIndex(path.join(CACHE, 'art'), async (url) => {
  const response = await net.fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.text();
});

function regions(): string[] {
  preference ??= regionPreference(app.getLocale() || 'en-US');
  return preference;
}

let changedTimer: NodeJS.Timeout | null = null;
function changed(change: GamesChange): void {
  if (change.kind === 'running') {
    deps?.sendToShell('games:changed', change);
    return;
  }
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    deps?.sendToShell('games:changed', { kind: 'library' } satisfies GamesChange);
  }, 100);
}

/** Read whatever folders changed since they were last read (or all, with `rescan`). */
async function scan(rescan = false): Promise<ScannedSystem[]> {
  const folders = await systemFolders(ROOT);
  const result: ScannedSystem[] = [];
  const live = new Set<string>();
  for (const { def, folder } of folders) {
    live.add(folder);
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(folder)).mtimeMs;
    } catch {
      continue;
    }
    let scanned = scans.get(folder);
    if (rescan || !scanned || scanned.mtimeMs !== mtimeMs) {
      try {
        scanned = await scanSystem(def, folder, regions());
        scans.set(folder, scanned);
      } catch {
        continue;
      }
    }
    result.push(scanned);
    // Box art, looked up in the background: the library is told when it's in.
    if (def.thumbnails && !art.has(def.thumbnails)) {
      void art.ensure(def.thumbnails).then((fresh) => fresh && changed({ kind: 'library' }));
    }
  }
  for (const folder of scans.keys()) if (!live.has(folder)) scans.delete(folder);
  return result;
}

/** Where RetroArch keeps the moment a game was left at, for what it was given. */
function autoStatePath(content: string): string {
  const base = path.basename(content).replace(/\.[^.]+$/, '');
  return path.join(STATES, path.basename(path.dirname(content)), `${base}.state.auto`);
}

/** The copy of a game that plays: the one chosen, if it's still there, else the best. */
function chosenPath(game: ScannedGame): string {
  const chosen = libraryState().versions[game.id];
  return chosen && game.versions.some((v) => v.path === chosen) ? chosen : game.versions[0].path;
}

function stateFor(game: ScannedGame): string {
  const played = libraryState().played[game.id];
  return autoStatePath(played?.content ?? chosenPath(game));
}

async function library(rescan = false): Promise<GamesLibrary> {
  const scanned = await scan(rescan);
  const t = tools();
  const s = libraryState();
  const systems: GameSystem[] = [];
  const games: Game[] = [];
  const byId = new Map<string, GameSystem>();
  // Saved moments, a folder listing per system folder rather than a stat per game.
  const states = new Map<string, Set<string>>();
  const hasState = (file: string) => {
    const dir = path.dirname(file);
    let names = states.get(dir);
    if (!names) {
      try {
        names = new Set(fs.readdirSync(dir));
      } catch {
        names = new Set();
      }
      states.set(dir, names);
    }
    return names.has(path.basename(file));
  };
  const local = new Set(regions().slice(0, 4));
  for (const sys of scanned) {
    let system = byId.get(sys.def.id);
    if (!system) {
      const why = unavailable(sys.def, t, sys);
      system = { id: sys.def.id, name: sys.def.name, maker: sys.def.maker, year: sys.def.year, count: 0, playable: why === null, unavailable: why };
      byId.set(sys.def.id, system);
      systems.push(system);
    }
    system.count += sys.games.length;
    for (const game of sys.games) {
      const played = s.played[game.id];
      games.push({
        id: game.id,
        system: game.system,
        title: game.title,
        path: chosenPath(game),
        versions: game.versions.map((v) => ({ path: v.path, label: v.label })),
        art: art.art(sys.def, game, regions()),
        favorite: s.favorites[game.id] === true,
        lastPlayed: played?.last ?? null,
        playTime: Math.round(played?.time ?? 0),
        resumable: hasState(stateFor(game)),
        local: game.versions[0].parsed.regions.some((r) => local.has(r)),
      });
    }
  }
  return { root: ROOT, systems, games };
}

/** A game by id, from the folders as they are now. */
async function findGame(id: unknown): Promise<{ game: ScannedGame; scanned: ScannedSystem }> {
  if (typeof id !== 'string' || !/^[a-z0-9]+\/[a-z0-9]+$/.test(id)) throw new Error('No such game');
  for (const scanned of await scan()) {
    const game = scanned.games.find((g) => g.id === id);
    if (game) return { game, scanned };
  }
  throw new Error('That game isn’t in your games folder anymore.');
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

interface Running extends RunningGame {
  child: ChildProcess;
  exited: Promise<void>;
}

let running: Running | null = null;

function publicRunning(): RunningGame | null {
  if (!running) return null;
  const { id, title, system, startedAt } = running;
  return { id, title, system, startedAt };
}

function status(): GamesStatus {
  return { installed: tools() !== null, optionalFeature: Boolean(process.env.DIN_FEATURES), running: publicRunning() };
}

/** RetroArch's settings: written each time, so they're always Din's. */
function retroarchConfig(t: Tools, core: string, def: SystemDef): string {
  const runAhead = RUN_AHEAD_CORES.has(def.core ?? '');
  const values: Record<string, string | boolean | number> = {
    config_save_on_exit: false,
    // Full screen, through Vulkan, on the GPU.
    video_driver: 'vulkan',
    video_fullscreen: true,
    video_windowed_fullscreen: true,
    video_vsync: true,
    // As little between a button and the screen as can be: two buffers
    // rather than three (a frame of waiting fewer), and the frame run as late
    // before the refresh as it reliably finishes, starting at half a frame.
    video_max_swapchain_images: 2,
    video_frame_delay: 0,
    video_frame_delay_auto: true,
    // A frame ahead where the core can (RUN_AHEAD_CORES), without a word.
    preemptive_frames_enable: runAhead,
    run_ahead_enabled: false,
    run_ahead_frames: 1,
    run_ahead_hide_warnings: true,
    video_smooth: false,
    video_shader_enable: true,
    audio_driver: 'pipewire',
    // Controllers through SDL, set up by RetroArch's profiles of them.
    input_joypad_driver: 'sdl2',
    input_autodetect_enable: true,
    // Start+Select quits back to the library, L3+R3 opens the menu (so does
    // Home, in most controllers' profiles), Escape quits from a keyboard.
    input_quit_gamepad_combo: 4,
    input_menu_toggle_gamepad_combo: 2,
    input_exit_emulator: 'escape',
    quit_press_twice: false,
    // Where it was left, picked up again, with a picture for the library.
    savestate_auto_save: true,
    savestate_auto_load: true,
    savestate_thumbnail_enable: true,
    sort_savefiles_enable: false,
    sort_savestates_enable: false,
    sort_savefiles_by_content_enable: true,
    sort_savestates_by_content_enable: true,
    // Paused when it isn't the window in front.
    pause_nonactive: true,
    menu_driver: 'ozone',
    menu_pause_libretro: true,
    menu_show_core_updater: false,
    menu_show_online_updater: false,
    history_list_enable: false,
    core_info_cache_enable: false,
    gamemode_enable: false,
    notification_show_remap_load: false,
    notification_show_config_override_load: false,
    notification_show_set_initial_disk: false,
    global_core_options: true,
    // Everything RetroArch keeps, Din's, not ~/.config/retroarch's.
    system_directory: SYSTEM_DIR,
    savefile_directory: SAVES,
    savestate_directory: STATES,
    screenshot_directory: path.join(HOME, 'Pictures', 'Screenshots'),
    core_options_path: path.join(RA, 'core-options.cfg'),
    rgui_config_directory: path.join(RA, 'config'),
    input_remapping_directory: path.join(RA, 'remaps'),
    playlist_directory: path.join(RA, 'playlists'),
    content_history_dir: path.join(RA, 'playlists'),
    cheat_database_path: path.join(RA, 'cheats'),
    thumbnails_directory: path.join(RA, 'thumbnails'),
    cache_directory: path.join(CACHE, 'retroarch'),
    log_dir: path.join(CACHE, 'logs'),
    libretro_directory: path.dirname(core),
  };
  if (t.assets) values.assets_directory = t.assets;
  if (t.autoconfig) values.joypad_autoconfig_dir = t.autoconfig;
  if (t.info) values.libretro_info_path = t.info;
  if (t.shaders) values.video_shader_dir = t.shaders;
  return Object.entries(values)
    .map(([k, v]) => `${k} = "${typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v).replace(/"/g, '')}"`)
    .join('\n') + '\n';
}

/** Add the core options Din wants that the user hasn't set themselves. */
async function mergeCoreOptions(): Promise<void> {
  const file = path.join(RA, 'core-options.cfg');
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    text = '';
  }
  const set = new Set([...text.matchAll(/^\s*([^\s=#]+)\s*=/gm)].map((m) => m[1]));
  const missing = Object.entries(CORE_OPTIONS).filter(([k]) => !set.has(k));
  if (!missing.length) return;
  const add = missing.map(([k, v]) => `${k} = "${v}"`).join('\n');
  await fsp.writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add}\n`);
}

/** Where a system's BIOS can be had: a "[BIOS] …" file in its folder, or ~/roms/bios. */
function biosSource(def: SystemDef, scanned: ScannedSystem | undefined): string | null {
  if (!def.bios) return null;
  const inBios = path.join(ROOT, 'bios', def.bios.file);
  if (fs.existsSync(inBios)) return inBios;
  const match = def.bios.match;
  return scanned?.bios.find((f) => match.test(path.basename(f))) ?? null;
}

/** Put what the system folder needs in it: ~/roms/bios's files, linked, and the system's own BIOS. */
async function prepareSystemFolder(def: SystemDef, scanned: ScannedSystem): Promise<void> {
  await fsp.mkdir(SYSTEM_DIR, { recursive: true });
  try {
    for (const name of await fsp.readdir(path.join(ROOT, 'bios'))) {
      const target = path.join(SYSTEM_DIR, name);
      if (!fs.existsSync(target)) await fsp.symlink(path.join(ROOT, 'bios', name), target).catch(() => {});
    }
  } catch {
    // No ~/roms/bios.
  }
  if (!def.bios) return;
  const target = path.join(SYSTEM_DIR, def.bios.file);
  if (fs.existsSync(target)) return;
  const source = biosSource(def, scanned);
  if (!source) return;
  if (/\.zip$/i.test(source)) {
    // The zip's one file, whatever it's called inside, as the name the core wants.
    const { stdout } = await execFileAsync('unzip', ['-Z1', source]);
    const inner = stdout.split('\n').map((l) => l.trim()).find((l) => l && !l.endsWith('/'));
    if (!inner) return;
    const { stdout: data } = await execFileAsync('unzip', ['-p', source, inner], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    await fsp.writeFile(target, data);
  } else {
    await fsp.copyFile(source, target);
  }
}

/** A zipped disc image, unpacked for a core that would misread the zip. */
async function unpacked(def: SystemDef, file: string): Promise<string> {
  if (def.archives || !/\.(zip|7z)$/i.test(file)) return file;
  const { stdout } = await execFileAsync('unzip', ['-Z1', file]);
  const names = stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/'));
  const playable = names.filter((n) => def.extensions.includes(n.slice(n.lastIndexOf('.') + 1).toLowerCase()) && !/\.zip$/i.test(n));
  if (!playable.length) throw new Error('There’s no game in that zip Din can play.');
  // In a folder named for the system, so its saves are filed with the system's.
  const dir = path.join(CACHE, 'unpacked', createHash('sha1').update(file).digest('hex').slice(0, 12), def.id);
  const best = playable.find((n) => /\.(m3u|cue|gdi)$/i.test(n)) ?? playable[0];
  const target = path.join(dir, best);
  if (!fs.existsSync(target)) {
    await fsp.mkdir(dir, { recursive: true });
    await execFileAsync('unzip', ['-o', '-q', '-j', file, '-d', dir], { maxBuffer: 16 * 1024 * 1024 });
  }
  return path.join(dir, path.basename(best));
}

/** The game's box art, small enough for the Dock, or null. */
async function dockIcon(def: SystemDef, game: ScannedGame): Promise<string | null> {
  const url = art.art(def, game, regions())?.boxart;
  if (!url) return null;
  try {
    const response = await net.fetch(url);
    if (!response.ok) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const scale = 256 / Math.max(width, height);
    return image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toDataURL();
  } catch {
    return null;
  }
}

async function play(id: unknown, options: unknown): Promise<void> {
  const { game, scanned } = await findGame(id);
  const opts = (options ?? {}) as PlayOptions;
  const def = scanned.def;
  const t = tools();
  const why = unavailable(def, t, scanned);
  if (why || !t || !def.core) throw new Error(why ?? 'Din can’t play this game.');
  const core = t.cores.get(def.core)!;
  const version = typeof opts.version === 'string' ? game.versions.find((v) => v.path === opts.version) : undefined;
  if (opts.version !== undefined && !version) throw new Error('That isn’t a copy of this game.');
  const file = version?.path ?? chosenPath(game);

  await stop();
  // RetroArch unpacks zipped games into its cache folder, and fails to if it isn't there.
  await Promise.all([RA, SAVES, STATES, path.join(CACHE, 'retroarch'), path.join(CACHE, 'logs')].map((dir) => fsp.mkdir(dir, { recursive: true })));
  await Promise.all([prepareSystemFolder(def, scanned), mergeCoreOptions()]);
  const content = await unpacked(def, file);
  const config = path.join(RA, 'retroarch.cfg');
  await fsp.writeFile(config, retroarchConfig(t, core, def));
  // Verbose, so the log says how the last game ran: on quitting, how full
  // the audio buffer kept (and how near running dry: crackle) and how
  // evenly frames reached the screen.
  const argv = [t.retroarch, '--verbose', '--config', config, '-L', core];
  if (opts.fresh) {
    const fresh = path.join(RA, 'fresh.cfg');
    await fsp.writeFile(fresh, 'savestate_auto_load = "false"\n');
    argv.push('--appendconfig', fresh);
  }
  const sharp = t.shaders && path.join(t.shaders, 'pixel-art-scaling', 'sharp-bilinear-simple.slangp');
  if (def.pixelArt && sharp && fs.existsSync(sharp)) argv.push('--set-shader', sharp);
  argv.push(content);

  const icon = await dockIcon(def, game);
  const child = await launchAsApp({
    key: `game-${game.id.replace('/', '-')}`,
    name: game.title,
    icon,
    categories: ['Game'],
    argv,
    cwd: path.dirname(content),
    log: path.join(CACHE, 'logs', 'last-game.log'),
  });
  const startedAt = Date.now();
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const entry: Running = { id: game.id, title: game.title, system: def.id, startedAt, child, exited };
  running = entry;
  const s = libraryState();
  s.played[game.id] = { last: startedAt, time: s.played[game.id]?.time ?? 0, content };
  saveState();
  changed({ kind: 'running', running: publicRunning() });
  changed({ kind: 'library' });
  void exited.then(() => {
    const played = libraryState().played[game.id];
    if (played) played.time += (Date.now() - startedAt) / 1000;
    saveState();
    if (running === entry) {
      running = null;
      changed({ kind: 'running', running: null });
    }
    changed({ kind: 'library' });
  });
}

/** Quit the game being played: RetroArch saves where it was on SIGTERM. */
async function stop(): Promise<void> {
  const current = running;
  if (!current) return;
  try {
    current.child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), QUIT_GRACE_MS));
  if ((await Promise.race([current.exited.then(() => 'exited' as const), timeout])) === 'timeout') {
    try {
      current.child.kill('SIGKILL');
    } catch {
      // Gone after all.
    }
    await current.exited;
  }
}

async function resumeImage(id: unknown): Promise<string | null> {
  const { game } = await findGame(id);
  try {
    const png = await fsp.readFile(`${stateFor(game)}.png`);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

async function forgetResume(id: unknown): Promise<void> {
  const { game } = await findGame(id);
  if (running?.id === game.id) throw new Error('Quit the game first.');
  const file = stateFor(game);
  await Promise.all([fsp.rm(file, { force: true }), fsp.rm(`${file}.png`, { force: true })]);
  changed({ kind: 'library' });
}

async function setFavorite(id: unknown, favorite: unknown): Promise<void> {
  const { game } = await findGame(id);
  const s = libraryState();
  if (favorite === true) s.favorites[game.id] = true;
  else delete s.favorites[game.id];
  saveState();
  changed({ kind: 'library' });
}

async function setVersion(id: unknown, file: unknown): Promise<void> {
  const { game } = await findGame(id);
  if (typeof file !== 'string' || !game.versions.some((v) => v.path === file)) throw new Error('That isn’t a copy of this game.');
  const s = libraryState();
  if (file === game.versions[0].path) delete s.versions[game.id];
  else s.versions[game.id] = file;
  // Its saved moment is the copy's own.
  if (s.played[game.id]) delete s.played[game.id].content;
  saveState();
  changed({ kind: 'library' });
}

export function registerGamesHandlers(options: Deps): void {
  deps = options;
  const { assertShellSender } = options;
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertShellSender(event);
      return fn(...args);
    });
  };
  handle('games:status', () => status());
  handle('games:library', (opts) => library((opts as { rescan?: unknown } | undefined)?.rescan === true));
  handle('games:play', (id, opts) => play(id, opts));
  handle('games:stop', () => stop());
  handle('games:setFavorite', (id, favorite) => setFavorite(id, favorite));
  handle('games:setVersion', (id, file) => setVersion(id, file));
  handle('games:resumeImage', (id) => resumeImage(id));
  handle('games:forgetResume', (id) => forgetResume(id));
  // A game still running when Din quits keeps where it was.
  app.on('before-quit', () => {
    try {
      running?.child.kill('SIGTERM');
    } catch {
      // Gone.
    }
  });
}

// Din's embedded display: a private, headless X server for native Linux apps.
//
// Native apps used to be left to the host window manager, stacked above the
// shell, which made them strangers on the desktop: no Din chrome, no Dock
// grouping, no Alt+Tab, and nothing at all under DinOS's cage, which has no
// window manager. Instead, Din now runs its own X server (Xvfb) that only it
// can see, launches apps against it, and composites their windows into its
// own (native-display-worker.mts does the window management and compositing;
// src/lib/nativeDisplay.ts draws them).
//
// Apps that speak Wayland run on a Wayland compositor instead
// (native/din-compositor, started by the worker beside the X server; see
// wayland-bridge.mts), which renders on the GPU when there is one (frames
// reach this process as shared buffers; see native-gpu.mts) and paces apps
// by what Din actually shows. Xvfb stays for X-only apps, and for everything when
// the compositor isn't built.
//
// Why Xvfb for X apps rather than XEmbed into the host: it ships everywhere
// Xorg does, needs no GPU, supports every extension the compositor uses
// (Composite, DAMAGE, XTEST, XFIXES), and keeps apps entirely out of the
// host session - their windows can't escape Din's, and a misbehaving app
// can't touch the shell's own window tree. Audio needs nothing special: the
// apps are ordinary processes of this user and talk to PipeWire/PulseAudio
// directly, exactly as they would on any desktop.
//
// The server is private by construction: a fresh MIT-MAGIC-COOKIE-1 in a
// 0600 Xauthority file, no TCP listener. Anything that can read the cookie
// already runs as this user.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { app, ipcMain, MessageChannelMain, screen, utilityProcess } from 'electron';
import { connectGpuBuffers, dinFd } from './native-gpu.mts';
import { keyboardKeymap, onKeymapChange } from './keyboard.mts';

const WORKER = path.join(import.meta.dirname, 'native-display-worker.mts');

/** The embedded display's servers and how to reach them. */
export interface EmbeddedDisplay {
  /** "$DISPLAY" value, e.g. ":100". */
  display: string;
  /** Path of the Xauthority file holding the server's cookie. */
  xauthority: string;
  /** "$WAYLAND_DISPLAY" of the Wayland compositor, when it runs. */
  wayland: string | null;
  /**
   * "$DISPLAY" of the compositor's Xwayland, when it runs: X11 apps go there
   * instead, onto the compositor's GPU path. No cookie; see embeddedDisplayEnv.
   */
  xwayland: string | null;
}

/**
 * The Wayland compositor binary (native/din-compositor), or null to run X
 * alone: when it isn't built, or DIN_NATIVE_DISPLAY=x11 asks for X only
 * (handy for comparing the two).
 */
function compositorBinary(): string | null {
  if (process.env.DIN_NATIVE_DISPLAY === 'x11') return null;
  const candidates = [
    process.env.DIN_COMPOSITOR,
    path.join(import.meta.dirname, '..', 'native/din-compositor/target/release/din-compositor'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try the next
    }
  }
  return null;
}

let server: ChildProcess | null = null;
let worker: Electron.UtilityProcess | null = null;
let starting: Promise<EmbeddedDisplay | null> | null = null;
let current: EmbeddedDisplay | null = null;
/** The shell's WebContents, for GPU frames (set at registration). */
let shellContents: () => Electron.WebContents | null = () => null;

/** Resolve a binary against PATH. */
function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The first display number with neither a lock file nor a socket. */
function freeDisplayNumber(): number {
  for (let n = 100; n < 400; n += 1) {
    if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
      return n;
    }
  }
  throw new Error('No free X display number');
}

/** Write an Xauthority file with one wildcard-address cookie entry. */
function writeXauthority(file: string, displayNumber: number, cookie: Buffer): void {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length, 0);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff, 0); // FamilyWild: any address
  const entry = Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.from(String(displayNumber), 'latin1')),
    field(Buffer.from('MIT-MAGIC-COOKIE-1', 'latin1')),
    field(cookie),
  ]);
  fs.writeFileSync(file, entry, { mode: 0o600 });
}

/** Spawn Xvfb and resolve once it accepts connections. */
async function startServer(): Promise<EmbeddedDisplay | null> {
  const xvfb = which('Xvfb');
  if (!xvfb) return null;

  const displayNumber = freeDisplayNumber();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'din-display-'));
  const xauthority = path.join(dir, 'Xauthority');
  writeXauthority(xauthority, displayNumber, crypto.randomBytes(16));

  // The X screen is the shell's viewport (see the worker's coordinate notes):
  // a popup an app clamps to the screen then stays inside Din's.
  const { width, height } = screen.getPrimaryDisplay().size;
  const child = spawn(
    xvfb,
    [
      `:${displayNumber}`,
      '-screen', '0', `${width}x${height}x24`,
      '-auth', xauthority,
      '-nolisten', 'tcp',
      '-noreset',
      '-dpi', '96',
      '+extension', 'Composite',
      '+extension', 'DAMAGE',
      '+extension', 'XFIXES',
      '+extension', 'XTEST',
      '-displayfd', '3',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  );

  // Xvfb writes its display number to fd 3 once it's accepting clients.
  const up = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.stdio[3]?.once('data', () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!up) {
    child.kill();
    return null;
  }
  child.stderr?.resume();
  child.on('exit', () => {
    if (server === child) {
      server = null;
      current = null;
    }
  });
  server = child;
  return { display: `:${displayNumber}`, xauthority, wayland: null, xwayland: null };
}

/** Fork the window manager / compositor against the server. */
async function startWorker(display: EmbeddedDisplay): Promise<boolean> {
  const keymap = await keyboardKeymap();
  const child = utilityProcess.fork(WORKER, [], {
    serviceName: 'Din native display',
    stdio: 'inherit',
  });
  const ok = await new Promise<boolean>((resolve) => {
    child.on('message', (message: {
      type?: string;
      message?: string;
      wayland?: string | null;
      buffers?: string | null;
      xwayland?: string | null;
    }) => {
      if (message?.type === 'ready') {
        display.wayland = message.wayland ?? null;
        display.xwayland = message.xwayland ?? null;
        // Wayland windows rendered on the GPU come to this process as
        // buffers (native-gpu.mts), not through the worker.
        if (message.buffers && !connectGpuBuffers(message.buffers, shellContents)) {
          console.error('native-display: could not connect to the GPU buffer socket');
        }
        resolve(true);
      }
      if (message?.type === 'error') {
        console.error('native-display:', message.message);
        resolve(false);
      }
    });
    child.once('exit', () => resolve(false));
    // The compositor renders on the GPU only if this process can receive
    // its buffers, which takes the din-fd addon.
    child.postMessage({
      type: 'start',
      ...display,
      compositor: compositorBinary(),
      gpu: dinFd() !== null,
      keymap,
    });
  });
  if (!ok) return false;
  child.once('exit', () => {
    if (worker === child) worker = null;
  });
  worker = child;
  return true;
}

/**
 * The embedded display, started on first use. Null when it can't run here
 * (no Xvfb installed, or it failed to start) - native apps then report
 * unavailable.
 */
export function embeddedDisplay(): Promise<EmbeddedDisplay | null> {
  if (current && server && worker) return Promise.resolve(current);
  starting ??= (async () => {
    try {
      const display = await startServer();
      if (!display) return null;
      if (!(await startWorker(display))) {
        server?.kill();
        server = null;
        return null;
      }
      current = display;
      return display;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** The user's session environment, read once (see sessionEnvironment). */
let sessionEnv: Promise<Record<string, string>> | null = null;

/**
 * The login session's environment, as the systemd user manager holds it -
 * which is where GNOME, KDE and friends publish it for the apps they start.
 *
 * Din's own environment can't be trusted to be a full session's: it may be
 * started from a shell that dropped variables, a script, or a display
 * manager's minimal environment. Apps notice. Without
 * DBUS_SESSION_BUS_ADDRESS, Chromium-based apps (Signal, Element, Brave)
 * can't find the keyring and fall back to a different password store, so
 * they can't decrypt their own data - and Chromium answers a failed keyring
 * lookup by storing a fresh key, which risks replacing the real one.
 */
function sessionEnvironment(): Promise<Record<string, string>> {
  sessionEnv ??= new Promise((resolve) => {
    execFile('systemctl', ['--user', 'show-environment'], { timeout: 3_000 }, (error, stdout) => {
      const env: Record<string, string> = {};
      if (!error) {
        for (const line of stdout.split('\n')) {
          const eq = line.indexOf('=');
          // $'...' values are C-escaped (control characters, newlines);
          // nothing an app needs from the session looks like that.
          if (eq <= 0 || line.startsWith("$'", eq + 1)) continue;
          env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      }
      // The bus is at a well-known path even where systemd isn't asked.
      const runtimeDir = env.XDG_RUNTIME_DIR ?? process.env.XDG_RUNTIME_DIR;
      if (!env.DBUS_SESSION_BUS_ADDRESS && runtimeDir) {
        const bus = path.join(runtimeDir, 'bus');
        if (fs.existsSync(bus)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
      }
      resolve(env);
    });
  });
  return sessionEnv;
}

/**
 * The environment Din was started with, before Chromium edited it.
 *
 * Chromium rewrites its own process environment at startup, and every edit
 * would otherwise reach the apps Din launches: NO_AT_BRIDGE=1 switches their
 * accessibility off, CHROME_DESKTOP and GDK_BACKEND are Chromium's own, and
 * a missing bus address becomes DBUS_SESSION_BUS_ADDRESS=disabled:, which
 * leaves Chromium-based apps without their keyring. /proc keeps the original.
 */
function launchEnvironment(): NodeJS.ProcessEnv {
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of fs.readFileSync('/proc/self/environ', 'utf8').split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return { ...process.env };
  }
}

/**
 * The session bus the apps Din launches are on (see embeddedDisplayEnv), or
 * undefined where there is none.
 */
export async function sessionBusAddress(): Promise<string | undefined> {
  const address = { ...(await sessionEnvironment()), ...launchEnvironment() }.DBUS_SESSION_BUS_ADDRESS;
  return address && !address.startsWith('disabled:') ? address : undefined;
}

/**
 * Environment for a process that should appear inside Din: the one Din was
 * started with, with the user's session environment filling in whatever
 * that lacks, pointed at the embedded display.
 *
 * With the Wayland compositor running, toolkits are steered to it first and
 * to X second (GTK, Qt and SDL take a fallback list; Firefox and Electron go
 * by XDG_SESSION_TYPE), and X-only apps find DISPLAY. That's the compositor's
 * Xwayland when it has one, else the Xvfb server.
 * Without it, everything is pinned to X - including off any Wayland desktop
 * Din itself may be running on, which those apps would otherwise escape to.
 */
export async function embeddedDisplayEnv(display: EmbeddedDisplay): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...(await sessionEnvironment()),
    ...launchEnvironment(),
    DISPLAY: display.xwayland ?? display.display,
    XAUTHORITY: display.xauthority,
  };
  // Xwayland has no cookie (it admits only this user; see the compositor's
  // xwayland.rs), and a stale XAUTHORITY would only send clients looking.
  if (display.xwayland) delete env.XAUTHORITY;
  if (display.wayland) {
    Object.assign(env, {
      WAYLAND_DISPLAY: display.wayland,
      XDG_SESSION_TYPE: 'wayland',
      GDK_BACKEND: 'wayland,x11',
      QT_QPA_PLATFORM: 'wayland;xcb',
      SDL_VIDEODRIVER: 'wayland,x11',
      MOZ_ENABLE_WAYLAND: '1',
      ELECTRON_OZONE_PLATFORM_HINT: 'auto',
    });
  } else {
    Object.assign(env, {
      XDG_SESSION_TYPE: 'x11',
      GDK_BACKEND: 'x11',
      QT_QPA_PLATFORM: 'xcb',
      SDL_VIDEODRIVER: 'x11',
    });
    delete env.WAYLAND_DISPLAY;
  }
  return env;
}

/**
 * A fresh MessagePort to the worker (starting the display if needed),
 * replacing whichever port it had: there is only ever one shell to draw.
 */
export async function connectToWorker(): Promise<Electron.MessagePortMain | null> {
  const display = await embeddedDisplay();
  if (!display || !worker) return null;
  const { port1, port2 } = new MessageChannelMain();
  worker.postMessage({ type: 'port' }, [port1]);
  return port2;
}

/**
 * Register the shell-facing IPC: the renderer asks for a MessagePort to the
 * worker (again after every reload), and frames and input then flow on it
 * without touching this process.
 */
export function registerNativeDisplayHandlers(options: {
  assertShellSender: (event: Electron.IpcMainEvent) => void;
  shell: () => Electron.WebContents | null;
}): void {
  shellContents = options.shell;
  // Apps type with the user's layout (see keyboard.mts), and switch with it.
  onKeymapChange((keymap) => worker?.postMessage({ type: 'keymap', keymap }));
  ipcMain.on('native-display:connect', async (event) => {
    try {
      options.assertShellSender(event);
    } catch {
      return;
    }
    const port = await connectToWorker();
    if (!port) return;
    if (event.sender.isDestroyed()) port.close();
    else event.sender.postMessage('native-display:port', null, [port]);
  });

  app.on('will-quit', stopEmbeddedDisplay);
}

/** Tear down the worker and the server (apps on it exit with it). */
export function stopEmbeddedDisplay(): void {
  worker?.kill();
  worker = null;
  server?.kill();
  server = null;
  current = null;
}

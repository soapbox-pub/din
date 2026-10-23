// The assistant bridge (window.assistant, for the Assistant app, its menu-bar
// item, the Super+A prompt and Settings → Assistant): Din's connection to
// OpenCode, the coding agent, running as the user's background server.
//
// OpenCode v2 keeps one server per user (`opencode serve --service`) that
// every client shares: the TUI in a Terminal, `opencode run`, and Din. The
// first client to need it starts it, and it writes where it listens and a
// generated password to ~/.local/state/opencode/service.json. Din starts it
// at login while the assistant is on (the shell says so, from its config),
// so the agent is there to be asked from anywhere; a Terminal's `opencode`
// then finds it running and attaches.
//
// OpenCode itself is the user's install in ~/.opencode, which updates
// itself, rather than a copy pinned into DinOS: it moves faster than DinOS
// releases. Where it's missing, turning the assistant on runs OpenCode's v2
// installer. DIN_OPENCODE names another binary.
//
// The server's API is HTTP with Basic auth, and that password is as good as
// a shell as this user: the agent runs commands. It stays in this process.
// The shell sends requests here (paths under /api/ only) and gets the
// answers back; this side adds the credentials. That's no more than the
// shell already holds - window.pty is a shell - and nothing reaches the
// <webview>s, which have no preload for it. One event stream (/api/event)
// is held open here and passed to the shell, slimmed to what it acts on,
// reopened when the server restarts.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { sessionBusAddress } from './native-display.mts';

const INSTALL_DIR = path.join(os.homedir(), '.opencode/bin');
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'opencode');
const SERVICE_FILE = path.join(STATE_DIR, 'service.json');
const MODEL_FILE = path.join(STATE_DIR, 'model.json');
const INSTALLER_URL = 'https://opencode.ai/v2/install';

const COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
/** Request bodies the shell may send: prompts with pasted pictures fit. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const API_PATH = /^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;

/** Events whose data the shell reads; for the rest the session is enough. */
const DATA_EVENTS = /^(permission|form)\.|^session\.(created|deleted|updated|renamed|moved|archived|unarchived|execution\.|step\.failed)/;

export interface AssistantStatus {
  /** The shell wants it on. */
  enabled: boolean;
  /** Where OpenCode is, or null where it isn't installed. */
  binary: string | null;
  /** Its version ("2.1.3"), when known. */
  version: string | null;
  /** The server answers. */
  running: boolean;
  /** The event stream is open. */
  connected: boolean;
  /** The installer is running. */
  installing: boolean;
  /** The last thing that went wrong, for Settings to say. */
  error: string | null;
}

interface Service {
  url: string;
  password: string;
}

type Reply = { ok: true; status: number; data: unknown } | { ok: false; status: number; message: string };

let status: AssistantStatus = {
  enabled: false,
  binary: null,
  version: null,
  running: false,
  connected: false,
  installing: false,
  error: null,
};
let emitStatus: (status: AssistantStatus) => void = () => {};
let emitEvent: (event: unknown) => void = () => {};
let service: Service | null = null;
let starting: Promise<Service> | null = null;
let installing: Promise<void> | null = null;
/** Installing on its own is tried once; after a failure, Settings' button. */
let autoInstallTried = false;
let stream: AbortController | null = null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function update(patch: Partial<AssistantStatus>): void {
  const next = { ...status, ...patch };
  if (Object.keys(next).every((key) => next[key as keyof AssistantStatus] === status[key as keyof AssistantStatus])) return;
  status = next;
  emitStatus(status);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** OpenCode's binary: DIN_OPENCODE, else the user's install, else one on PATH. */
function findBinary(): string | null {
  const named = process.env.DIN_OPENCODE;
  if (named) return isExecutable(named) ? named : null;
  const installed = path.join(INSTALL_DIR, 'opencode');
  if (isExecutable(installed)) return installed;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'opencode');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * What OpenCode and the agent's commands run with: Din's own environment,
 * minus the displays. Under cage, a window opened on Din's display takes
 * its place, fullscreen; the server outlives the embedded display apps get,
 * so it gets neither. Chromium's own edits come out too (see
 * native-display.mts's launchEnvironment), and the session bus goes back.
 */
async function serverEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'WAYLAND_DISPLAY',
    'DISPLAY',
    'XAUTHORITY',
    'GDK_BACKEND',
    'NO_AT_BRIDGE',
    'CHROME_DESKTOP',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
  ]) {
    delete env[name];
  }
  const bus = await sessionBusAddress().catch(() => undefined);
  if (bus) env.DBUS_SESSION_BUS_ADDRESS = bus;
  else delete env.DBUS_SESSION_BUS_ADDRESS;
  env.PATH = [INSTALL_DIR, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

function run(file: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  return serverEnvironment().then(
    (env) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim().split('\n').pop() || error.message));
          else resolve(stdout);
        });
      }),
  );
}

async function readVersion(binary: string): Promise<string | null> {
  try {
    const out = await run(binary, ['--version'], 10_000);
    return /(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Only v2 has the server and API this speaks. */
function isSupported(version: string | null): boolean {
  return version !== null && Number(version.split('.')[0]) >= 2;
}

async function locate(): Promise<string | null> {
  const binary = findBinary();
  const version = binary ? await readVersion(binary) : null;
  update({ binary: binary && isSupported(version) ? binary : null, version });
  return status.binary;
}

/** Run OpenCode's v2 installer into ~/.opencode/bin. */
function install(): Promise<void> {
  installing ??= (async () => {
    update({ installing: true, error: null });
    try {
      const env = await serverEnvironment();
      await new Promise<void>((resolve, reject) => {
        // The installer edits shell profiles to put itself on PATH unless
        // asked not to; DinOS's own profile has it there already.
        const child = spawn('bash', ['-c', `curl -fsSL ${INSTALLER_URL} | bash -s -- --no-modify-path`], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        const keep = (chunk: Buffer) => {
          tail = (tail + chunk.toString()).slice(-2000);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          // eslint-disable-next-line no-control-regex
          else reject(new Error(tail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').pop() || `The installer failed (${code})`));
        });
      });
      if (!(await locate())) throw new Error('OpenCode was installed but can’t be found');
    } finally {
      update({ installing: false });
      installing = null;
    }
  })();
  return installing;
}

function readService(): Service | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SERVICE_FILE, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { url, password } = parsed as Record<string, unknown>;
    if (typeof url !== 'string' || typeof password !== 'string') return null;
    // Only ever a server on this machine.
    const host = new URL(url).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return null;
    return { url: url.replace(/\/$/, ''), password };
  } catch {
    return null;
  }
}

function authHeader(s: Service): string {
  return `Basic ${Buffer.from(`opencode:${s.password}`).toString('base64')}`;
}

async function answers(s: Service): Promise<boolean> {
  try {
    const response = await fetch(`${s.url}/api/info`, {
      headers: { authorization: authHeader(s) },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The running server: the one service.json names if it answers, else one
 * started now. Installs OpenCode first where it's missing.
 */
function ensureService(): Promise<Service> {
  starting ??= (async () => {
    try {
      const known = readService();
      if (known && (await answers(known))) {
        service = known;
        update({ running: true });
        if (!status.version) void locate();
        return known;
      }
      service = null;
      update({ running: false });
      let binary = status.binary ?? (await locate());
      if (!binary && !autoInstallTried) {
        autoInstallTried = true;
        await install();
        binary = status.binary;
      }
      if (!binary) throw new Error('OpenCode isn’t installed');
      await run(binary, ['service', 'start']);
      const started = readService();
      if (!started || !(await answers(started))) throw new Error('OpenCode’s server didn’t start');
      service = started;
      update({ running: true, error: null });
      return started;
    } catch (error) {
      update({ running: false, error: messageOf(error) });
      throw error;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

async function send(s: Service, method: string, apiPath: string, body: string | undefined): Promise<Reply> {
  const response = await fetch(`${s.url}${apiPath}`, {
    method,
    headers: {
      authorization: authHeader(s),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (response.ok) return { ok: true, status: response.status, data };
  const message =
    typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : `OpenCode answered ${response.status}`;
  return { ok: false, status: response.status, message };
}

async function request(method: string, apiPath: string, body: string | undefined): Promise<Reply> {
  let s: Service;
  try {
    s = service ?? (await ensureService());
  } catch (error) {
    return { ok: false, status: 0, message: messageOf(error) };
  }
  try {
    return await send(s, method, apiPath, body);
  } catch {
    // The server restarted (a new port and password) or went away: once more,
    // with whatever is running now.
    service = null;
    try {
      return await send(await ensureService(), method, apiPath, body);
    } catch (error) {
      return { ok: false, status: 0, message: messageOf(error) };
    }
  }
}

/** The parts of an event the shell acts on. */
function slim(event: Record<string, unknown>): unknown {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = typeof event.data === 'object' && event.data !== null ? (event.data as Record<string, unknown>) : {};
  const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined;
  return DATA_EVENTS.test(type) ? { type, sessionID, data } : { type, sessionID };
}

/** Hold the event stream open while the assistant is on. */
async function watch(controller: AbortController): Promise<void> {
  let delay = RECONNECT_MS;
  while (!controller.signal.aborted) {
    try {
      const s = await ensureService();
      const response = await fetch(`${s.url}/api/event`, {
        headers: { authorization: authHeader(s), accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`OpenCode answered ${response.status}`);
      delay = RECONNECT_MS;
      update({ connected: true, running: true });
      emitEvent({ type: 'din.connected' });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            emitEvent(slim(JSON.parse(data) as Record<string, unknown>));
          } catch {
            // Not JSON: nothing to pass on.
          }
        }
      }
    } catch {
      // Gone, or never there; try again below.
    }
    if (status.connected) {
      update({ connected: false });
      emitEvent({ type: 'din.disconnected' });
    }
    service = null;
    if (controller.signal.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    // A server that keeps failing to start is asked less and less often.
    delay = Math.min(delay * 2, MAX_RECONNECT_MS);
  }
}

function setEnabled(enabled: boolean): void {
  update({ enabled });
  if (enabled && !stream) {
    stream = new AbortController();
    void watch(stream);
  } else if (!enabled && stream) {
    stream.abort();
    stream = null;
    update({ connected: false });
  }
}

/** The models the TUI used last, newest first, so Din starts on the same one. */
function recentModels(): { providerID: string; modelID: string }[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')) as { recent?: unknown };
    if (!Array.isArray(parsed.recent)) return [];
    return parsed.recent
      .filter(
        (m): m is { providerID: string; modelID: string } =>
          typeof m === 'object' && m !== null && typeof m.providerID === 'string' && typeof m.modelID === 'string',
      )
      .slice(0, 10)
      .map(({ providerID, modelID }) => ({ providerID, modelID }));
  } catch {
    return [];
  }
}

export function registerAssistantHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;
  emitStatus = (next) => sendToShell('assistant:status', next);
  emitEvent = (event) => sendToShell('assistant:event', event);

  ipcMain.handle('assistant:status', async (event) => {
    assertShellSender(event);
    if (!status.binary && !status.installing) await locate();
    return status;
  });

  ipcMain.handle('assistant:setEnabled', (event, enabled: unknown) => {
    assertShellSender(event);
    setEnabled(enabled === true);
    return status;
  });

  ipcMain.handle('assistant:install', async (event) => {
    assertShellSender(event);
    try {
      await install();
      if (status.enabled) {
        // Start it now rather than at the stream's next try.
        stream?.abort();
        stream = new AbortController();
        void watch(stream);
      }
    } catch (error) {
      update({ error: messageOf(error) });
      throw error;
    }
  });

  ipcMain.handle('assistant:restart', async (event) => {
    assertShellSender(event);
    const binary = status.binary ?? (await locate());
    if (!binary) throw new Error('OpenCode isn’t installed');
    service = null;
    update({ running: false });
    await run(binary, ['service', 'restart']);
    await ensureService();
  });

  ipcMain.handle('assistant:recentModels', (event) => {
    assertShellSender(event);
    return recentModels();
  });

  ipcMain.handle('assistant:request', (event, method: unknown, apiPath: unknown, body: unknown) => {
    assertShellSender(event);
    if (typeof method !== 'string' || !METHODS.has(method)) {
      return { ok: false, status: 0, message: 'Unsupported method' } satisfies Reply;
    }
    if (typeof apiPath !== 'string' || !API_PATH.test(apiPath) || apiPath.includes('..')) {
      return { ok: false, status: 0, message: 'Not an OpenCode API path' } satisfies Reply;
    }
    let json: string | undefined;
    if (body !== undefined) {
      json = JSON.stringify(body);
      if (json.length > MAX_BODY_BYTES) return { ok: false, status: 0, message: 'Request too large' } satisfies Reply;
    }
    return request(method, apiPath, json);
  });
}

// The dictation bridge (window.dinos.dictation): speech to text, on this computer.
//
// The shell records the microphone itself (src/lib/dictation.ts) and hands
// 16 kHz mono PCM here; whisper.cpp's server turns it into text. DinOS's
// launcher names the server and its model in DIN_WHISPER_SERVER and
// DIN_WHISPER_MODEL (os/configuration.nix); elsewhere dictation reports
// itself unavailable unless both are set by hand.
//
// The server is started on first use and kept running, so the model (over
// half a gigabyte, on the GPU) loads once; after a few idle minutes it's
// stopped to give that memory back. It listens on loopback only, on a port
// picked at start.
//
// The text also goes in from here when the target is a web page (a browser
// tab or web app), whose keyboard focus the shell can't type into.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, ipcMain } from 'electron';

const SERVER = process.env.DIN_WHISPER_SERVER;
const MODEL = process.env.DIN_WHISPER_MODEL;

/** Stop the server after this long without a request. */
const IDLE_MS = 5 * 60_000;
/** How long the model may take to load. */
const START_TIMEOUT_MS = 60_000;
const SAMPLE_RATE = 16_000;
/** Ten minutes of audio; anything longer isn't dictation. */
const MAX_SAMPLES = SAMPLE_RATE * 600;

interface Server {
  child: ChildProcess;
  port: number;
  ready: Promise<void>;
}

let server: Server | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Requests run one at a time; whisper-server does too. */
let queue: Promise<unknown> = Promise.resolve();

function available(): boolean {
  return Boolean(SERVER && MODEL && fs.existsSync(SERVER) && fs.existsSync(MODEL));
}

/**
 * The language to listen for, from the system's locale. Telling whisper
 * saves a detection pass (about half the time of a short phrase) and keeps
 * short ones from being heard as another language.
 */
function language(): string {
  const code = app.getLocale().split(/[-_]/)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(code) ? code : 'auto';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('No free port'))));
    });
  });
}

async function waitForHealth(server: Server): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error('The speech recognizer stopped while starting');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The speech recognizer took too long to start');
}

async function startServer(): Promise<Server> {
  if (!SERVER || !MODEL) throw new Error('Dictation isn’t available here');
  const port = await freePort();
  const child = spawn(
    SERVER,
    ['--model', MODEL, '--host', '127.0.0.1', '--port', String(port), '--language', language(), '--no-timestamps'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const started: Server = { child, port, ready: Promise.resolve() };
  child.on('error', () => {});
  child.on('exit', (code, signal) => {
    if (server === started) server = null;
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[dictation] whisper-server exited (${signal ?? code}):\n${stderr.trim()}`);
    }
  });
  started.ready = waitForHealth(started).catch((error: unknown) => {
    child.kill('SIGTERM');
    throw error;
  });
  return started;
}

async function ensureServer(): Promise<Server> {
  if (!server) server = await startServer();
  const current = server;
  try {
    await current.ready;
  } catch (error) {
    if (server === current) server = null;
    throw error;
  }
  return current;
}

function stopServer(): void {
  server?.child.kill('SIGTERM');
  server = null;
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stopServer, IDLE_MS);
}

/** A 16-bit mono WAV file around raw samples. */
function wav(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.byteLength, true);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return bytes;
}

async function transcribe(samples: Int16Array): Promise<string> {
  const { port } = await ensureServer();
  const form = new FormData();
  form.append('file', new Blob([wav(samples)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const response = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`The speech recognizer failed (${response.status})`);
  const body = (await response.json()) as { text?: unknown; error?: unknown };
  if (typeof body.error === 'string') throw new Error(body.error);
  return typeof body.text === 'string' ? body.text : '';
}

export function registerDictationHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  guestFromId: (wcId: unknown) => Electron.WebContents | null;
}): void {
  const { assertShellSender, guestFromId } = options;

  ipcMain.handle('dictation:available', (event) => {
    assertShellSender(event);
    return available();
  });

  // Load the model while the user is still speaking.
  ipcMain.handle('dictation:prepare', async (event) => {
    assertShellSender(event);
    if (!available()) throw new Error('Dictation isn’t available here');
    touch();
    await ensureServer();
  });

  ipcMain.handle('dictation:transcribe', (event, pcm: unknown) => {
    assertShellSender(event);
    if (!available()) throw new Error('Dictation isn’t available here');
    if (!(pcm instanceof Uint8Array) || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_SAMPLES * 2) {
      throw new Error('Not audio');
    }
    // Copied: the IPC buffer may not be aligned for 16-bit reads.
    const samples = new Int16Array(new Uint8Array(pcm).buffer);
    touch();
    const run = queue.then(() => transcribe(samples));
    queue = run.catch(() => {});
    return run.then((text) => text.replace(/\s+/g, ' ').trim());
  });

  ipcMain.handle('dictation:insert-guest', (event, wcId: unknown, text: unknown) => {
    assertShellSender(event);
    const guest = guestFromId(wcId);
    if (!guest || typeof text !== 'string' || text.length > 100_000) return false;
    guest.insertText(text).catch(() => {});
    return true;
  });

  app.on('will-quit', stopServer);
}

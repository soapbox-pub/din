// The speech bridge (window.dinos.speech): text to speech, on this computer.
//
// Kokoro 1.0 reads text aloud through sherpa-onnx. The Speech optional
// feature brings sherpa-onnx's library (DIN_TTS_LIB) and the model's folder
// (DIN_TTS_MODEL); the system brings din-tts (DIN_TTS_HELPER, os/din-tts.c),
// which opens the library, loads the model once (most of a second) and then
// makes each sentence in a fraction of its length. It's started on first
// use and kept while Din speaks, then stopped after a while unused to give
// back its memory (the model is 300 MB). Elsewhere speech reports itself
// unavailable unless the three are set by hand.
//
// The desktop speaks (src/lib/speech.ts): it cuts what it reads into
// sentences and asks for each in turn, playing one while the next is made.
// Each request answers with a WAV file's bytes. Requests run one at a time,
// in order; cancel() drops those waiting (the one being made is short).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, ipcMain } from 'electron';

const HELPER = process.env.DIN_TTS_HELPER;
const LIBRARY = process.env.DIN_TTS_LIB;
const MODEL = process.env.DIN_TTS_MODEL;

/** Longer than a few sentences isn't one request: the desktop cuts text up. */
const MAX_TEXT = 4000;
/** However slow the computer, a request this long has gone wrong. */
const TIMEOUT_MS = 60_000;
/** Loading the model. */
const START_TIMEOUT_MS = 60_000;
/** The model's memory goes back after this long with nothing said. */
const IDLE_MS = 10 * 60_000;

/**
 * Kokoro 1.0's English voices, by speaker id in its voice table (sherpa-onnx's
 * kokoro-multi-lang-v1_0), the one most think its best first. Ids are
 * Kokoro's own names.
 */
export const VOICES = [
  { id: 'af_heart', sid: 3, name: 'Heart', lang: 'en-US' },
  { id: 'af_bella', sid: 2, name: 'Bella', lang: 'en-US' },
  { id: 'af_nicole', sid: 6, name: 'Nicole', lang: 'en-US' },
  { id: 'af_sarah', sid: 9, name: 'Sarah', lang: 'en-US' },
  { id: 'af_sky', sid: 10, name: 'Sky', lang: 'en-US' },
  { id: 'af_nova', sid: 7, name: 'Nova', lang: 'en-US' },
  { id: 'af_river', sid: 8, name: 'River', lang: 'en-US' },
  { id: 'af_jessica', sid: 4, name: 'Jessica', lang: 'en-US' },
  { id: 'af_alloy', sid: 0, name: 'Alloy', lang: 'en-US' },
  { id: 'af_aoede', sid: 1, name: 'Aoede', lang: 'en-US' },
  { id: 'af_kore', sid: 5, name: 'Kore', lang: 'en-US' },
  { id: 'am_michael', sid: 16, name: 'Michael', lang: 'en-US' },
  { id: 'am_adam', sid: 11, name: 'Adam', lang: 'en-US' },
  { id: 'am_echo', sid: 12, name: 'Echo', lang: 'en-US' },
  { id: 'am_eric', sid: 13, name: 'Eric', lang: 'en-US' },
  { id: 'am_fenrir', sid: 14, name: 'Fenrir', lang: 'en-US' },
  { id: 'am_liam', sid: 15, name: 'Liam', lang: 'en-US' },
  { id: 'am_onyx', sid: 17, name: 'Onyx', lang: 'en-US' },
  { id: 'am_puck', sid: 18, name: 'Puck', lang: 'en-US' },
  { id: 'bf_emma', sid: 21, name: 'Emma', lang: 'en-GB' },
  { id: 'bf_isabella', sid: 22, name: 'Isabella', lang: 'en-GB' },
  { id: 'bf_alice', sid: 20, name: 'Alice', lang: 'en-GB' },
  { id: 'bf_lily', sid: 23, name: 'Lily', lang: 'en-GB' },
  { id: 'bm_george', sid: 26, name: 'George', lang: 'en-GB' },
  { id: 'bm_lewis', sid: 27, name: 'Lewis', lang: 'en-GB' },
  { id: 'bm_daniel', sid: 24, name: 'Daniel', lang: 'en-GB' },
  { id: 'bm_fable', sid: 25, name: 'Fable', lang: 'en-GB' },
] as const;

function available(): boolean {
  return Boolean(
    HELPER &&
      LIBRARY &&
      MODEL &&
      fs.existsSync(HELPER) &&
      fs.existsSync(LIBRARY) &&
      fs.existsSync(path.join(MODEL, 'model.onnx')) &&
      fs.existsSync(path.join(MODEL, 'voices.bin')),
  );
}

/** A third of the cores, two to eight: it makes speech about five times faster than it's said. */
const THREADS = Math.max(2, Math.min(8, Math.floor(os.availableParallelism() / 3)));

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** din-tts, running: its output read as it comes, and the answers waited on in order. */
interface Helper {
  child: ChildProcess;
  ready: Promise<void>;
  /** Read `bytes` once they've come, or reject if it goes. */
  read(bytes: number): Promise<Buffer>;
}

let helper: Helper | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Bumped by cancel(): requests from before it don't start. */
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();

function startHelper(): Helper {
  if (!HELPER || !LIBRARY || !MODEL) throw new Error('Speech isn’t available here');
  const child = spawn(HELPER, [LIBRARY, MODEL, String(THREADS)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered: Buffer = Buffer.alloc(0);
  let gone: Error | null = null;
  const waiting: { bytes: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  const pump = () => {
    while (waiting.length && buffered.length >= waiting[0]!.bytes) {
      const w = waiting.shift()!;
      w.resolve(buffered.subarray(0, w.bytes));
      buffered = buffered.subarray(w.bytes);
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    pump();
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const started: Helper = {
    child,
    ready: Promise.resolve(),
    read: (bytes) =>
      gone
        ? Promise.reject(gone)
        : new Promise((resolve, reject) => {
            waiting.push({ bytes, resolve, reject });
            pump();
          }),
  };
  child.on('error', () => {});
  child.on('exit', (code, signal) => {
    gone = new Error('The voice stopped');
    for (const w of waiting.splice(0)) w.reject(gone);
    if (helper === started) helper = null;
    if (code !== 0 && signal !== 'SIGTERM') console.error(`[speech] din-tts exited (${signal ?? code}):\n${stderr.trim()}`);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), START_TIMEOUT_MS);
  started.ready = started.read(8).then((header) => {
    clearTimeout(timer);
    if (header.subarray(0, 4).toString() !== 'DTTS') throw new Error('The voice didn’t start');
  });
  started.ready.catch(() => child.kill('SIGTERM'));
  return started;
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stopHelper, IDLE_MS);
}

function stopHelper(): void {
  helper?.child.kill('SIGTERM');
  helper = null;
}

/** A 16-bit mono WAV file around raw samples. */
function wav(pcm: Buffer, rate: number): Uint8Array {
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

async function synthesize(text: string, sid: number, rate: number): Promise<Uint8Array> {
  helper ??= startHelper();
  const h = helper;
  await h.ready;
  h.child.stdin?.write(`${sid} ${rate.toFixed(3)} ${text}\n`);
  const timer = setTimeout(() => h.child.kill('SIGKILL'), TIMEOUT_MS);
  try {
    const head = await h.read(8);
    const n = head.readInt32LE(0);
    const sampleRate = head.readInt32LE(4);
    if (n < 0) throw new Error('The voice failed');
    return wav(await h.read(n * 2), sampleRate);
  } finally {
    clearTimeout(timer);
  }
}

export function registerSpeechHandlers(options: { assertShellSender: (event: Electron.IpcMainInvokeEvent) => void }): void {
  const { assertShellSender } = options;

  ipcMain.handle('speech:available', (event) => {
    assertShellSender(event);
    return available();
  });

  ipcMain.handle('speech:voices', (event) => {
    assertShellSender(event);
    return available() ? VOICES.map(({ id, name, lang }) => ({ id, name, lang })) : [];
  });

  // Load the model ahead of what's to be said (a call starting).
  ipcMain.handle('speech:prepare', async (event) => {
    assertShellSender(event);
    if (!available()) return;
    touch();
    helper ??= startHelper();
    await helper.ready.catch(() => {});
  });

  ipcMain.handle('speech:synthesize', (event, text: unknown, voice: unknown, rate: unknown) => {
    assertShellSender(event);
    if (!available()) throw new Error('Speech isn’t available here');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('Not text to speak');
    const sid = (VOICES.find((v) => v.id === voice) ?? VOICES[0]).sid;
    const speed = typeof rate === 'number' && Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
    const asked = generation;
    touch();
    const run = queue.then(() => {
      if (asked !== generation) throw new Cancelled();
      return synthesize(text.replace(/\s+/g, ' ').trim(), sid, speed);
    });
    queue = run.catch(() => {});
    return run;
  });

  ipcMain.handle('speech:cancel', (event) => {
    assertShellSender(event);
    generation++;
  });

  app.on('will-quit', stopHelper);
}

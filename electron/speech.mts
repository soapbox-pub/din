// The speech bridge (window.dinos.speech): text to speech, on this computer.
//
// sherpa-onnx's offline TTS reads text aloud in Kokoro's voices. DinOS's
// launcher names the program and the model's folder in DIN_TTS and
// DIN_TTS_MODEL (os/configuration.nix, the `speech` optional feature);
// elsewhere speech reports itself unavailable unless both are set by hand.
//
// The desktop speaks (src/lib/speech.ts): it cuts what it reads into
// sentences and asks for each in turn, playing one while the next is made,
// so the first words come in a second or two whatever the length. Each
// request runs the program once (the model loads in well under a second)
// and answers with a WAV file's bytes. Requests run one at a time, and
// cancel() stops the one running and drops those waiting.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ipcMain } from 'electron';

const PROGRAM = process.env.DIN_TTS;
const MODEL = process.env.DIN_TTS_MODEL;

/** Longer than a few sentences isn't one request: the desktop cuts text up. */
const MAX_TEXT = 4000;
/** However slow the computer, a request this long has gone wrong. */
const TIMEOUT_MS = 120_000;

/**
 * Kokoro v0.19's voices, by speaker id: American and British, women and
 * men. Ids are Kokoro's own names, which stay put if voices are added.
 */
export const VOICES = [
  { id: 'af', name: 'Kokoro', lang: 'en-US' },
  { id: 'af_bella', name: 'Bella', lang: 'en-US' },
  { id: 'af_nicole', name: 'Nicole', lang: 'en-US' },
  { id: 'af_sarah', name: 'Sarah', lang: 'en-US' },
  { id: 'af_sky', name: 'Sky', lang: 'en-US' },
  { id: 'am_adam', name: 'Adam', lang: 'en-US' },
  { id: 'am_michael', name: 'Michael', lang: 'en-US' },
  { id: 'bf_emma', name: 'Emma', lang: 'en-GB' },
  { id: 'bf_isabella', name: 'Isabella', lang: 'en-GB' },
  { id: 'bm_george', name: 'George', lang: 'en-GB' },
  { id: 'bm_lewis', name: 'Lewis', lang: 'en-GB' },
] as const;

function available(): boolean {
  return Boolean(PROGRAM && MODEL && fs.existsSync(PROGRAM) && fs.existsSync(path.join(MODEL, 'voices.bin')));
}

/** Half the cores, up to four: quick enough to stay ahead of the voice, and leaves room. */
const THREADS = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));

let running: ChildProcess | null = null;
/** Bumped by cancel(): requests from before it don't start. */
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

async function synthesize(text: string, voice: number, rate: number): Promise<Uint8Array> {
  if (!PROGRAM || !MODEL) throw new Error('Speech isn’t available here');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'din-speech-'));
  const out = path.join(dir, 'speech.wav');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        PROGRAM,
        [
          `--kokoro-model=${path.join(MODEL, 'model.int8.onnx')}`,
          `--kokoro-voices=${path.join(MODEL, 'voices.bin')}`,
          `--kokoro-tokens=${path.join(MODEL, 'tokens.txt')}`,
          `--kokoro-data-dir=${path.join(MODEL, 'espeak-ng-data')}`,
          `--kokoro-length-scale=${(1 / rate).toFixed(3)}`,
          `--num-threads=${THREADS}`,
          `--sid=${voice}`,
          `--output-filename=${out}`,
          // Never an option, whatever it starts with.
          ` ${text}`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      running = child;
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (running === child) running = null;
        if (signal === 'SIGTERM') reject(new Cancelled());
        else if (code === 0) resolve();
        else {
          console.error(`[speech] sherpa-onnx exited (${signal ?? code}):\n${stderr.trim()}`);
          reject(new Error('The voice failed'));
        }
      });
    });
    return new Uint8Array(await fs.promises.readFile(out));
  } finally {
    void fs.promises.rm(dir, { recursive: true, force: true });
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
    return available() ? VOICES.map((v) => ({ ...v })) : [];
  });

  ipcMain.handle('speech:synthesize', (event, text: unknown, voice: unknown, rate: unknown) => {
    assertShellSender(event);
    if (!available()) throw new Error('Speech isn’t available here');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('Not text to speak');
    const index = Math.max(0, VOICES.findIndex((v) => v.id === voice));
    const speed = typeof rate === 'number' && Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
    const asked = generation;
    const run = queue.then(() => {
      if (asked !== generation) throw new Cancelled();
      return synthesize(text.replace(/\s+/g, ' ').trim(), index, speed);
    });
    queue = run.catch(() => {});
    return run;
  });

  ipcMain.handle('speech:cancel', (event) => {
    assertShellSender(event);
    generation++;
    running?.kill('SIGTERM');
  });
}

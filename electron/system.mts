// The main process's way to run system tools: through system-worker.mts, in
// the services host, so that spawning them never blocks the main process
// (see that file for why).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { startService, type Service } from './services.mts';

/** A program on PATH, or null. */
export function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** A failed command, shaped like execFile's errors. */
export class CommandError extends Error {
  /** 'ENOENT' when the tool is missing, else the exit code (or null). */
  code: string | number | null;
  stderr: string;

  constructor(message: string, code: string | number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

interface Pending {
  resolve: (output: { stdout: string; stderr: string }) => void;
  reject: (error: CommandError) => void;
}

interface WorkerMessage {
  type: string;
  id?: number;
  name?: string;
  line?: string;
  stdout?: string;
  stderr?: string;
  error?: { code: string | number | null; message: string } | null;
}

let worker: Service | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const watchers = new Map<string, { file: string; args: string[]; onLine: (line: string) => void }>();

/** The worker, started on first use (and again if it ever dies). */
function systemWorker(): Service {
  if (worker) return worker;
  const service = startService<WorkerMessage>('system', {}, {
    onMessage: (message) => {
      if (message.type === 'result' && message.id !== undefined) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (!request) return;
        const stdout = message.stdout ?? '';
        const stderr = message.stderr ?? '';
        if (message.error) {
          request.reject(new CommandError(message.error.message, message.error.code, stderr));
        } else {
          request.resolve({ stdout, stderr });
        }
      } else if (message.type === 'event' && message.name) {
        watchers.get(message.name)?.onLine(message.line ?? '');
      }
    },
    onExit: () => {
      if (worker === service) worker = null;
      for (const request of pending.values()) {
        request.reject(new CommandError('system worker exited', null, ''));
      }
      pending.clear();
      // Monitors die with the worker; bring them back with a new one.
      if (watchers.size > 0) {
        setTimeout(() => {
          for (const [name, { file, args }] of watchers) {
            systemWorker().postMessage({ type: 'watch', name, file, args });
          }
        }, 1_000);
      }
    },
  });
  worker = service;
  return service;
}

/**
 * Run a command to completion; rejects with a CommandError on failure.
 * Aborting `signal` kills it (SIGTERM).
 */
export function runCommand(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new CommandError('aborted', null, ''));
      return;
    }
    const id = nextId++;
    const service = systemWorker();
    const kill = () => service.postMessage({ type: 'kill', id });
    signal?.addEventListener('abort', kill, { once: true });
    pending.set(id, {
      resolve: (output) => {
        signal?.removeEventListener('abort', kill);
        resolve(output);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', kill);
        reject(error);
      },
    });
    service.postMessage({
      type: 'run',
      id,
      file,
      args,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
  });
}

/**
 * Keep a monitoring command running (restarted if it exits) and call
 * `onLine` for each line it prints. Does nothing useful if the tool is
 * missing - callers keep a slow poll as the fallback.
 */
export function watchCommand(
  name: string,
  file: string,
  args: string[],
  onLine: (line: string) => void,
): void {
  watchers.set(name, { file, args, onLine });
  systemWorker().postMessage({ type: 'watch', name, file, args });
}

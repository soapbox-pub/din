// The main process's way to run system tools: through system-worker.mts, so
// that spawning them never blocks the main process (see that file for why).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import { utilityProcess } from 'electron';

const WORKER = path.join(import.meta.dirname, 'system-worker.mts');

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

let worker: Electron.UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const watchers = new Map<string, { file: string; args: string[]; onLine: (line: string) => void }>();

/** The worker, forked on first use (and again if it ever dies). */
function systemWorker(): Electron.UtilityProcess {
  if (worker) return worker;
  const child = utilityProcess.fork(WORKER, [], { serviceName: 'Din system tools', stdio: 'inherit' });
  child.on('message', (message: {
    type: string;
    id?: number;
    name?: string;
    line?: string;
    stdout?: string;
    stderr?: string;
    error?: { code: string | number | null; message: string } | null;
  }) => {
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
  });
  child.once('exit', () => {
    if (worker === child) worker = null;
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
  });
  worker = child;
  return child;
}

/** Run a command to completion; rejects with a CommandError on failure. */
export function runCommand(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    systemWorker().postMessage({
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

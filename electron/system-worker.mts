// Runs Din's system tools (nmcli, wpctl, brightnessctl, busctl, xrandr,
// pw-play, ...) on behalf of the main process, in the services host
// (services.mts).
//
// Spawning a child from Electron's main process blocks it for ~12 ms: Node
// forks to spawn, and forking a large, many-threaded process is slow. The
// main process is also where input is routed to the shell, so the menu
// bar's status polls (several commands every few seconds) froze window drags
// and dropped frames on a timer. Spawned from this small process instead,
// they cost little, and whatever they cost is off the input path.
//
// Two kinds of request: run a command to completion (execFile semantics),
// or keep a monitor running (`nmcli monitor`, `pactl subscribe`) and report
// each line of output, so status can follow events instead of polling.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type Request =
  | { type: 'run'; id: number; file: string; args: string[]; timeout: number; maxBuffer: number }
  | { type: 'watch'; name: string; file: string; args: string[] };

/** How long to wait before restarting a monitor that exited. */
const WATCH_RESTART_MS = 5_000;

let port: Electron.MessagePortMain | null = null;

function post(message: unknown): void {
  port?.postMessage(message);
}

function run(request: Extract<Request, { type: 'run' }>): void {
  execFile(
    request.file,
    request.args,
    { timeout: request.timeout, maxBuffer: request.maxBuffer },
    (error, stdout, stderr) => {
      post({
        type: 'result',
        id: request.id,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error
          ? { code: (error as NodeJS.ErrnoException).code ?? null, message: error.message }
          : null,
      });
    },
  );
}

/**
 * Runs a monitor so that it dies with this process. Utility processes are
 * killed outright when Din exits, with no chance to clean up, and the
 * monitors would outlive them. So each runs under a shell that holds a pipe
 * from this process (as fd 3: background jobs get /dev/null for stdin): the
 * kernel closes it however this process ends, `read` returns, and the
 * monitor is killed. If the monitor exits first, the shell exits with its
 * status (127: the tool isn't installed) and the watch restarts.
 */
const MONITOR_WRAPPER = [
  'exec 3<&0',
  '"$0" "$@" 3<&- & monitor=$!',
  '(read -r _ <&3; kill "$monitor" 2>/dev/null) >/dev/null & guard=$!',
  'exec 3<&-',
  'wait "$monitor"; status=$?',
  'kill "$guard" 2>/dev/null',
  'exit "$status"',
].join('; ');

function watch(request: Extract<Request, { type: 'watch' }>): void {
  const child = spawn('sh', ['-c', MONITOR_WRAPPER, request.file, ...request.args], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let missing = false;
  child.on('error', () => {
    missing = true;
  });
  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      post({ type: 'event', name: request.name, line });
    });
  }
  child.on('close', (code) => {
    // The tool isn't installed: nothing to watch, and no point retrying.
    if (code === 127) missing = true;
    if (!missing) setTimeout(() => watch(request), WATCH_RESTART_MS);
  });
}

export function start(channel: Electron.MessagePortMain): void {
  port = channel;
  channel.on('message', (event) => {
    const request = event.data as Request;
    if (request.type === 'run') run(request);
    else if (request.type === 'watch') watch(request);
  });
}

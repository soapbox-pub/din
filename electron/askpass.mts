// sudo's password, asked for in Din (window.dinos.askpass, for the desktop's
// AdminPromptHost).
//
// When sudo needs the password and has no terminal to read it from, as for
// the Assistant's commands, it runs its askpass helper, os/din-askpass.py
// (DinOS names it in sudo.conf). The helper connects to
// $XDG_RUNTIME_DIR/din-askpass.sock with its parent's pid, sudo's, and this
// module reads what sudo was asked to run, and who asked, from /proc for the
// desktop to show. The password typed is tried with sudo before it's
// answered, so a wrong one stays in the dialog and only the right one goes
// back to the helper. Cancel, the helper going away (its command was
// stopped), or two minutes without an answer send nothing back, and sudo
// fails as though nothing was typed.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app, ipcMain } from 'electron';

/** What the desktop shows (src/lib/askpass.ts). */
export interface AskpassRequest {
  requestId: number;
  /** Who's asking: "Assistant", or the program's name. */
  requester: string;
  /** The sudo command line, as typed. */
  command: string;
}

interface Pending {
  socket: net.Socket;
  timer: NodeJS.Timeout;
}

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  hasShell: () => boolean;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}

const MAX_REQUEST = 4096;
const MAX_PASSWORD = 4096;
const TIMEOUT_MS = 2 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
/** Programs that only pass a command on: the one that asked is above them. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'timeout', 'nohup']);

let options: Options | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function argv(pid: number): string[] {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((arg, i, all) => arg || i < all.length - 1);
  } catch {
    return [];
  }
}

function parentOf(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0;
  } catch {
    return 0;
  }
}

function nameOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

/** The first program above sudo that isn't a shell, or the Assistant anywhere above it. */
function requesterOf(sudo: number): string {
  let named = '';
  for (let pid = parentOf(sudo), steps = 0; pid > 1 && steps < 32; pid = parentOf(pid), steps++) {
    const name = nameOf(pid);
    if (name === 'opencode' || path.basename(argv(pid)[0] ?? '') === 'opencode') return 'Assistant';
    if (!named && name && !SHELLS.has(name)) named = name;
  }
  return named || 'A program';
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function reply(socket: net.Socket, password: string | null): void {
  socket.end(`${JSON.stringify(password === null ? {} : { password })}\n`);
}

function cancel(requestId: number): void {
  const request = pending.get(requestId);
  if (!request) return;
  pending.delete(requestId);
  clearTimeout(request.timer);
  if (!request.socket.destroyed) reply(request.socket, null);
  options?.sendToShell('askpass:cancel', { requestId });
}

function ask(socket: net.Socket, pid: unknown): void {
  const args = typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? argv(pid) : [];
  if (path.basename(args[0] ?? '') !== 'sudo' || !options?.hasShell()) {
    reply(socket, null);
    return;
  }
  const requestId = nextId++;
  const timer = setTimeout(() => cancel(requestId), TIMEOUT_MS);
  pending.set(requestId, { socket, timer });
  socket.on('close', () => cancel(requestId));
  const request: AskpassRequest = {
    requestId,
    requester: requesterOf(pid as number),
    // The sudo shim's -A is ours, not theirs.
    command: ['sudo', ...args.slice(1).filter((arg, i) => !(i === 0 && arg === '-A'))].map(quote).join(' '),
  };
  options.sendToShell('askpass:request', request);
}

/** Whether `password` is the one sudo takes. */
function check(password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-S', '-k', '-p', '', 'true'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), CHECK_TIMEOUT_MS);
    child.stdin.on('error', () => {});
    child.stdin.end(`${password}\n`);
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function accept(socket: net.Socket): void {
  let buffer = '';
  let started = false;
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk: string) => {
    if (started) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > MAX_REQUEST) socket.destroy();
      return;
    }
    started = true;
    let request: unknown;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      request = null;
    }
    ask(socket, typeof request === 'object' && request !== null ? (request as { pid?: unknown }).pid : null);
  });
}

/** Whether something answers on a socket path. */
function answers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

async function listen(): Promise<void> {
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir) return;
  const file = path.join(dir, 'din-askpass.sock');
  // Another Din (a dev build nested in DinOS) asks for it.
  if (await answers(file)) return;
  fs.rmSync(file, { force: true });
  const server = net.createServer(accept);
  server.on('error', (error) => console.error('askpass:', error));
  server.listen(file, () => fs.chmodSync(file, 0o600));
  app.on('will-quit', () => {
    server.close();
    fs.rmSync(file, { force: true });
  });
}

/** Answer sudo's askpass helper. Call once the app is ready. */
export function registerAskpass(opts: Options): void {
  options = opts;
  ipcMain.handle('askpass:answer', async (event, requestId: unknown, password: unknown) => {
    opts.assertShellSender(event);
    const request = typeof requestId === 'number' ? pending.get(requestId) : undefined;
    if (!request) return { ok: true };
    if (password === null) {
      cancel(requestId as number);
      return { ok: true };
    }
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD || /[\n\r\0]/.test(password)) {
      return { ok: false };
    }
    if (!(await check(password))) return { ok: false };
    // It may have been cancelled while the password was tried.
    if (pending.get(requestId as number) !== request) return { ok: true };
    pending.delete(requestId as number);
    clearTimeout(request.timer);
    reply(request.socket, password);
    return { ok: true };
  });
  void listen().catch((error: unknown) => console.error('askpass: listening:', error));
}

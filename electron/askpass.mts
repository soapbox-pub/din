// sudo's password, asked for in Din: in the Assistant's conversation when the
// agent's command asks (window.dinos.assistant / din.system.assistant's
// passwords and answerPassword), else from a notification that opens the
// desktop's dialog (window.dinos.askpass, AdminPromptHost). Nothing pops up
// and takes the keyboard on its own.
//
// When sudo needs the password and has no terminal to read it from, it runs
// its askpass helper, os/din-askpass.py (DinOS names it in sudo.conf). The
// helper connects to $XDG_RUNTIME_DIR/din-askpass.sock with its parent's pid,
// sudo's, and the OpenCode session its command runs in, if any
// ($OPENCODE_SESSION_ID, which sudo passes on). This module reads what sudo
// was asked to run, and who asked, from /proc for the user to see. The
// password typed is tried with sudo before it's answered, so a wrong one
// stays where it was typed and only the right one goes back to the helper.
// Cancel, the helper going away (its command was stopped), or ten minutes
// without an answer send nothing back, and sudo fails as though nothing was
// typed.
//
// The session id is the asker's word, so a program could put its request in
// a conversation; it gets no more than it would from the dialog.
//
// "Allow for this conversation" also has din-password (DIN_PASSWORD, as
// root) grant the conversation: its next sudos pass sudo's PAM stack without
// asking at all, while the OpenCode server that runs them does. The password
// isn't kept anywhere. Grants go when their conversation is deleted, and all
// of them when Din starts.
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

/** A password the Assistant's conversation is waiting on (src/lib/assistant.ts). */
export interface AssistantPasswordRequest {
  requestId: number;
  sessionID: string;
  command: string;
}

interface Pending {
  socket: net.Socket;
  /** sudo's. */
  pid: number;
  timer: NodeJS.Timeout;
  request: AskpassRequest;
  /** The conversation it's asked in, or null for the dialog. */
  sessionID: string | null;
}

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  hasShell: () => boolean;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}

const MAX_REQUEST = 4096;
const MAX_PASSWORD = 4096;
const TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const PASSWORD_HELPER = process.env.DIN_PASSWORD;
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

/** Tell the Assistant its password requests changed; it asks for the list again. */
function passwordsChanged(): void {
  options?.sendToShell('assistant:event', { type: 'din.passwords' });
}

function settle(requestId: number, password: string | null): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (!entry.socket.destroyed) reply(entry.socket, password);
  if (entry.sessionID) passwordsChanged();
  else options?.sendToShell('askpass:cancel', { requestId });
}

function ask(socket: net.Socket, pid: unknown, session: unknown): void {
  const args = typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? argv(pid) : [];
  if (path.basename(args[0] ?? '') !== 'sudo' || !options?.hasShell()) {
    reply(socket, null);
    return;
  }
  const requestId = nextId++;
  const request: AskpassRequest = {
    requestId,
    requester: requesterOf(pid as number),
    command: ['sudo', ...args.slice(1)].map(quote).join(' '),
  };
  const sessionID = typeof session === 'string' && SESSION_ID.test(session) ? session : null;
  pending.set(requestId, { socket, pid: pid as number, request, sessionID, timer: setTimeout(() => settle(requestId, null), TIMEOUT_MS) });
  socket.on('close', () => settle(requestId, null));
  if (sessionID) passwordsChanged();
  else options.sendToShell('askpass:request', request);
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

/** din-password's `sudo <command>`, `input` on its stdin. Resolves whether it succeeded. */
function passwordHelper(command: string, input: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!PASSWORD_HELPER) {
      resolve(false);
      return;
    }
    const child = spawn('sudo', ['-n', PASSWORD_HELPER, 'sudo', command], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Ask sudo again in a conversation (it was deleted), or in every one. */
export function revokeSudoGrant(sessionID?: string): void {
  if (sessionID !== undefined && !SESSION_ID.test(sessionID)) return;
  void passwordHelper('revoke', sessionID ? `${sessionID}\n` : '');
}

/**
 * Answer a request with the password, or null to cancel. `ok` is false for a
 * wrong password. `remember` grants its conversation, so sudo doesn't ask
 * there again.
 */
async function answer(entry: Pending | undefined, password: unknown, remember = false): Promise<{ ok: boolean }> {
  if (!entry) return { ok: true };
  const { requestId } = entry.request;
  if (password === null) {
    settle(requestId, null);
    return { ok: true };
  }
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD || /[\n\r\0]/.test(password)) {
    return { ok: false };
  }
  if (!(await check(password))) return { ok: false };
  if (remember && entry.sessionID) await passwordHelper('grant', `${password}\n${entry.pid}\n`);
  // It may have gone while the password was tried.
  if (pending.get(requestId) === entry) settle(requestId, password);
  return { ok: true };
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
    let request: { pid?: unknown; session?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(buffer.slice(0, newline));
      if (typeof parsed === 'object' && parsed !== null) request = parsed;
    } catch {
      // Answered as nothing, below.
    }
    ask(socket, request.pid, request.session);
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

function forAssistant(requestId: unknown): Pending | undefined {
  const entry = typeof requestId === 'number' ? pending.get(requestId) : undefined;
  return entry?.sessionID ? entry : undefined;
}

/** Answer sudo's askpass helper. Call once the app is ready. */
export function registerAskpass(opts: Options): void {
  options = opts;
  ipcMain.handle('askpass:answer', (event, requestId: unknown, password: unknown) => {
    opts.assertShellSender(event);
    const entry = typeof requestId === 'number' ? pending.get(requestId) : undefined;
    return answer(entry?.sessionID ? undefined : entry, password);
  });
  ipcMain.handle('assistant:passwords', (event): AssistantPasswordRequest[] => {
    opts.assertShellSender(event);
    return [...pending.values()].flatMap(({ request, sessionID }) =>
      sessionID ? [{ requestId: request.requestId, sessionID, command: request.command }] : [],
    );
  });
  ipcMain.handle('assistant:answerPassword', (event, requestId: unknown, password: unknown, remember: unknown) => {
    opts.assertShellSender(event);
    return answer(forAssistant(requestId), password, remember === true);
  });
  revokeSudoGrant();
  void listen().catch((error: unknown) => console.error('askpass: listening:', error));
}

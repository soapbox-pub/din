// sudo asking the user, in Din: in the Assistant's conversation when the
// agent's command asks (window.dinos.assistant / din.system.assistant's
// passwords, answerPassword and approve), else from a notification that opens
// the desktop's dialog (window.dinos.askpass, AdminPromptHost). Nothing pops
// up and takes the keyboard on its own.
//
// sudo asks for one of two things, both over
// $XDG_RUNTIME_DIR/din-askpass.sock with sudo's pid and the OpenCode session
// its command runs in, if any ($OPENCODE_SESSION_ID):
//
// - Approval. On DinOS sudo's PAM stack asks Din to approve the command
//   before it asks for the password (os/din-password.py's `sudo check`, as
//   root), wherever sudo runs, terminal or not, except at the prompt in Din's
//   Terminal app, which root lets through itself. The user clicks Allow or Deny;
//   nothing is typed. Root checks that this socket is Din's main process
//   before it asks, so only Din can approve. "Allow for this conversation"
//   has root grant the conversation as well. A request nobody answers, or
//   Din not running, falls through to the password.
// - The password, when sudo needs it and has no terminal to read it from:
//   its askpass helper, os/din-askpass.py (DinOS names it in sudo.conf). The
//   password typed is tried with sudo before it's answered, so a wrong one
//   stays where it was typed and only the right one goes back to the helper.
//   A command just denied without a terminal isn't asked for it at all, so
//   Deny means deny; in a terminal sudo goes on to ask there.
//
// This module reads what sudo was asked to run, and who asked, from /proc
// for the user to see, in words for a command of Din's own (describe). Cancel, the asker going away (its command was
// stopped), or ten minutes without an answer send nothing back, and sudo
// fails as though nothing was typed.
//
// The session id is the asker's word, so a program could put its request in
// a conversation; it gets no more than it would from the dialog. So is the
// rest: a program that asks for approval itself only gets the answer, which
// lets nothing run.
//
// "Allow for this conversation" with the password has din-password
// (DIN_PASSWORD, as root) grant the conversation: its next sudos pass sudo's
// PAM stack without asking at all, while the OpenCode server that runs them
// does. The password isn't kept anywhere. Grants go when their conversation
// is deleted, and all of them when Din starts.
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
  /** Allow or Deny, rather than the password. */
  approve: boolean;
  /**
   * Din itself ran sudo, because the user just asked it to (installing a
   * package, electron/system-packages.mts), so the dialog opens at once.
   */
  direct: boolean;
  /** What the command does, in words, for one of Din's own (described), or null. */
  action: string | null;
  /** What comes of it, in a sentence, with `action`. */
  detail: string | null;
}

/** A password or approval the Assistant's conversation is waiting on (src/lib/assistant.ts). */
export interface AssistantPasswordRequest {
  requestId: number;
  sessionID: string;
  command: string;
  approve: boolean;
  action: string | null;
  detail: string | null;
}

/** How a conversation's approval is answered. */
type Decision = 'once' | 'conversation' | 'reject';

interface Pending {
  socket: net.Socket;
  /** sudo's. */
  pid: number;
  timer: NodeJS.Timeout;
  request: AskpassRequest;
  /** The conversation it's asked in, or null for the dialog. */
  sessionID: string | null;
  /** sudo has a terminal to ask for the password on, after a Deny. */
  tty: boolean;
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
/** How long a denied sudo isn't asked for the password: it asks straight after. */
const DENIED_MS = 60_000;
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const PASSWORD_HELPER = process.env.DIN_PASSWORD;
const UPDATER = process.env.DIN_UPDATER;
/** Programs that only pass a command on: the one that asked is above them. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'timeout', 'nohup']);
const ANSWERS: Record<Decision, string> = { once: 'allow', conversation: 'allow-session', reject: 'deny' };

let options: Options | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
/** sudos just denied, by pid, with their start times. */
const denied = new Map<number, string>();

function argv(pid: number): string[] {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((arg, i, all) => arg || i < all.length - 1);
  } catch {
    return [];
  }
}

/** A process's /proc/<pid>/stat fields after its name: [state, ppid, ...]. */
function statOf(pid: number): string[] {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return [];
  }
}

function parentOf(pid: number): number {
  return Number(statOf(pid)[1]) || 0;
}

/** When a process started, to tell it from a later one with its pid. */
function startOf(pid: number): string {
  return statOf(pid)[19] ?? '';
}

function nameOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * The first program above sudo that isn't a shell (the Terminal, for one
 * typed there), or the Assistant anywhere above it.
 */
function requesterOf(sudo: number): string {
  let named = '';
  for (let pid = parentOf(sudo), steps = 0; pid > 1 && steps < 32; pid = parentOf(pid), steps++) {
    const name = nameOf(pid);
    const args = argv(pid);
    if (name === 'opencode' || path.basename(args[0] ?? '') === 'opencode') return 'Assistant';
    if (!named && args.some((arg) => path.basename(arg) === 'pty-host.py')) named = 'Terminal';
    if (!named && name && !SHELLS.has(name)) named = name;
  }
  return named || 'A program';
}

/**
 * A command of Din's own in words, where the program sudo runs is really
 * it: the running system's updater building the user's commits (`local`).
 */
function describe(args: string[]): { action: string; detail: string } | null {
  const at = args.findIndex((arg, i) => i > 0 && !arg.startsWith('-'));
  if (at < 0 || !UPDATER || args[at + 1] !== 'local' || args.length !== at + 3) return null;
  try {
    if (fs.realpathSync(args[at]) !== fs.realpathSync(UPDATER)) return null;
  } catch {
    return null;
  }
  return { action: 'update Din', detail: 'Your desktop session will restart. Applications will be closed.' };
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function reply(socket: net.Socket, message: Record<string, string>): void {
  socket.end(`${JSON.stringify(message)}\n`);
}

/** Tell the Assistant its password requests changed; it asks for the list again. */
function passwordsChanged(): void {
  options?.sendToShell('assistant:event', { type: 'din.passwords' });
}

/** Answer a request with `message`, or nothing for none. */
function settle(requestId: number, message: Record<string, string> = {}): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (!entry.socket.destroyed) reply(entry.socket, message);
  if (entry.sessionID) passwordsChanged();
  else options?.sendToShell('askpass:cancel', { requestId });
}

function ask(socket: net.Socket, pid: unknown, session: unknown, approve: boolean, tty: boolean): void {
  const args = typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? argv(pid) : [];
  if (path.basename(args[0] ?? '') !== 'sudo' || !options?.hasShell()) {
    reply(socket, {});
    return;
  }
  const sudo = pid as number;
  if (!approve && denied.get(sudo) === startOf(sudo)) {
    reply(socket, {});
    return;
  }
  const requestId = nextId++;
  const direct = parentOf(sudo) === process.pid;
  const described = describe(args);
  const request: AskpassRequest = {
    requestId,
    requester: direct ? 'Din' : requesterOf(sudo),
    command: ['sudo', ...args.slice(1).filter((arg) => !direct || arg !== '-A')].map(quote).join(' '),
    approve,
    direct,
    action: described?.action ?? null,
    detail: described?.detail ?? null,
  };
  const sessionID = typeof session === 'string' && SESSION_ID.test(session) ? session : null;
  pending.set(requestId, { socket, pid: sudo, request, sessionID, tty, timer: setTimeout(() => settle(requestId), TIMEOUT_MS) });
  socket.on('close', () => settle(requestId));
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
 * Answer a password request with the password, or null to cancel. `ok` is
 * false for a wrong password. `remember` grants its conversation, so sudo
 * doesn't ask there again.
 */
async function answer(entry: Pending | undefined, password: unknown, remember = false): Promise<{ ok: boolean }> {
  if (!entry || entry.request.approve) return { ok: true };
  const { requestId } = entry.request;
  if (password === null) {
    settle(requestId);
    return { ok: true };
  }
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD || /[\n\r\0]/.test(password)) {
    return { ok: false };
  }
  if (!(await check(password))) return { ok: false };
  if (remember && entry.sessionID) await passwordHelper('grant', `${password}\n${entry.pid}\n`);
  // It may have gone while the password was tried.
  if (pending.get(requestId) === entry) settle(requestId, { password });
  return { ok: true };
}

/** Answer an approval. A conversation's grant is only for one asked in a conversation. */
function approve(entry: Pending | undefined, decision: unknown): void {
  if (!entry?.request.approve || (decision !== 'once' && decision !== 'conversation' && decision !== 'reject')) return;
  if (decision === 'conversation' && !entry.sessionID) return;
  if (decision === 'reject' && !entry.tty) {
    const start = startOf(entry.pid);
    denied.set(entry.pid, start);
    setTimeout(() => {
      if (denied.get(entry.pid) === start) denied.delete(entry.pid);
    }, DENIED_MS).unref();
  }
  settle(entry.request.requestId, { answer: ANSWERS[decision] });
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
    let request: { pid?: unknown; session?: unknown; approve?: unknown; tty?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(buffer.slice(0, newline));
      if (typeof parsed === 'object' && parsed !== null) request = parsed;
    } catch {
      // Answered as nothing, below.
    }
    ask(socket, request.pid, request.session, request.approve === true, request.tty === true);
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

function forDialog(requestId: unknown): Pending | undefined {
  const entry = typeof requestId === 'number' ? pending.get(requestId) : undefined;
  return entry?.sessionID ? undefined : entry;
}

/** Answer sudo's askpass helper and approvals. Call once the app is ready. */
export function registerAskpass(opts: Options): void {
  options = opts;
  ipcMain.handle('askpass:answer', (event, requestId: unknown, password: unknown) => {
    opts.assertShellSender(event);
    return answer(forDialog(requestId), password);
  });
  ipcMain.handle('askpass:approve', (event, requestId: unknown, allow: unknown) => {
    opts.assertShellSender(event);
    if (typeof allow === 'boolean') approve(forDialog(requestId), allow ? 'once' : 'reject');
  });
  ipcMain.handle('assistant:passwords', (event): AssistantPasswordRequest[] => {
    opts.assertShellSender(event);
    return [...pending.values()].flatMap(({ request, sessionID }) =>
      sessionID
        ? [{ requestId: request.requestId, sessionID, command: request.command, approve: request.approve, action: request.action, detail: request.detail }]
        : [],
    );
  });
  ipcMain.handle('assistant:answerPassword', (event, requestId: unknown, password: unknown, remember: unknown) => {
    opts.assertShellSender(event);
    return answer(forAssistant(requestId), password, remember === true);
  });
  ipcMain.handle('assistant:approve', (event, requestId: unknown, decision: unknown) => {
    opts.assertShellSender(event);
    approve(forAssistant(requestId), decision);
  });
  revokeSudoGrant();
  void listen().catch((error: unknown) => console.error('askpass: listening:', error));
}

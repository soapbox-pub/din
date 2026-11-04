// polkit asking the user, in Din. A program that asks polkit for something
// that needs the computer's password (pkexec, systemctl, udisks…) gets it
// asked by the authentication agent registered for the user's session, and
// without one it's refused; pkexec's own fallback, asking on its terminal,
// fails under polkit 127 (polkit-org/polkit#686). Din's agent is
// os/din-polkit-agent.py, which DinOS and the desktop module name in
// DIN_POLKIT_AGENT, run as this process's child for as long as Din runs and
// spoken to in JSON lines (the script says how).
//
// Each request goes to the desktop's prompt (window.dinos.polkit,
// PolkitPromptHost) as a notification first, the way sudo's do
// (electron/askpass.mts), saying who asked, from /proc. The password typed
// goes to the agent, which hands it to polkit's own helper to check: a wrong
// one stays where it was typed, the right one lets polkit go on. Cancel,
// ten minutes without an answer, or the program giving up (polkitd cancels)
// end it, and polkit refuses.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { app, ipcMain } from 'electron';
import { requesterFrom } from './askpass.mts';

/** What the desktop shows (src/lib/polkit.ts). */
export interface PolkitRequest {
  requestId: number;
  /** Who's asking: "Terminal", "Assistant", or the program's name. */
  requester: string;
  /** polkit's words for what it's for: "Authentication is needed to run …". */
  message: string;
  /** The polkit action, as org.freedesktop.policykit.exec. */
  action: string;
  /** Whose password, when it isn't this user's own, or null. */
  user: string | null;
}

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  hasShell: () => boolean;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}

interface Pending {
  agent: ChildProcessWithoutNullStreams;
  /** The agent's id for it. */
  agentId: number;
  timer: NodeJS.Timeout;
  /** The answer being tried, waiting on the agent's word. */
  trying: ((ok: boolean) => void) | null;
}

const AGENT = process.env.DIN_POLKIT_AGENT;
const TIMEOUT_MS = 10 * 60_000;
const MAX_PASSWORD = 4096;
/** Starting over after the agent stops, at most this often. */
const RESTART_MS = 5_000;
const MAX_RESTARTS = 5;

let options: Options | null = null;
let current: ChildProcessWithoutNullStreams | null = null;
let restarts = 0;
let quitting = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function write(agent: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  if (!agent.stdin.destroyed) agent.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Forget a request, telling the desktop it went. */
function drop(requestId: number, ok = false): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.trying?.(ok);
  options?.sendToShell('polkit:cancel', { requestId });
}

function byAgentId(agent: ChildProcessWithoutNullStreams, agentId: unknown): number | null {
  for (const [requestId, entry] of pending) if (entry.agent === agent && entry.agentId === agentId) return requestId;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onMessage(agent: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  switch (message.type) {
    case 'ready':
      restarts = 0;
      return;
    case 'error':
      console.error('polkit agent:', message.message);
      return;
    case 'request': {
      const agentId = message.id;
      if (typeof agentId !== 'number') return;
      if (!options?.hasShell()) {
        write(agent, { type: 'answer', id: agentId, password: null });
        return;
      }
      const details = isRecord(message.details) ? message.details : {};
      const subject = Number(details['polkit.subject-pid']);
      const user = typeof message.user === 'string' ? message.user : '';
      const requestId = nextId++;
      const request: PolkitRequest = {
        requestId,
        requester: Number.isInteger(subject) && subject > 1 ? requesterFrom(subject) : 'A program',
        message: typeof message.message === 'string' ? message.message : '',
        action: typeof message.action === 'string' ? message.action : '',
        user: message.self === true || !user ? null : user,
      };
      pending.set(requestId, {
        agent,
        agentId,
        trying: null,
        timer: setTimeout(() => {
          write(agent, { type: 'answer', id: agentId, password: null });
          drop(requestId);
        }, TIMEOUT_MS),
      });
      options.sendToShell('polkit:request', request);
      return;
    }
    case 'result': {
      // A wrong password: the request stays, asked again.
      const requestId = byAgentId(agent, message.id);
      const entry = requestId === null ? undefined : pending.get(requestId);
      if (!entry) return;
      entry.trying?.(false);
      entry.trying = null;
      return;
    }
    case 'done': {
      const requestId = byAgentId(agent, message.id);
      if (requestId !== null) drop(requestId, true);
      return;
    }
  }
}

function start(): void {
  if (!AGENT || quitting) return;
  const agent = spawn(AGENT, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  current = agent;
  agent.stdin.on('error', () => {});
  agent.stderr.setEncoding('utf8');
  agent.stderr.on('data', (chunk: string) => console.error('polkit agent:', chunk.trimEnd()));
  readline.createInterface({ input: agent.stdout }).on('line', (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(message)) onMessage(agent, message);
  });
  agent.on('error', (error) => console.error('polkit agent:', error));
  agent.on('close', (code, signal) => {
    if (current === agent) current = null;
    for (const [requestId, entry] of pending) if (entry.agent === agent) drop(requestId);
    if (quitting) return;
    console.error(`polkit agent: stopped (${signal ?? code})`);
    if (restarts++ < MAX_RESTARTS) setTimeout(start, RESTART_MS).unref();
  });
}

/**
 * Answer a request with the password, or null to cancel. `ok` is false for
 * a wrong password, which polkit lets the user try again.
 */
function answer(requestId: unknown, password: unknown): Promise<{ ok: boolean }> {
  const entry = typeof requestId === 'number' ? pending.get(requestId) : undefined;
  if (!entry) return Promise.resolve({ ok: true });
  if (password === null) {
    write(entry.agent, { type: 'answer', id: entry.agentId, password: null });
    drop(requestId as number);
    return Promise.resolve({ ok: true });
  }
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD || /[\n\r\0]/.test(password) || entry.trying) {
    return Promise.resolve({ ok: false });
  }
  return new Promise((resolve) => {
    entry.trying = (ok) => resolve({ ok });
    write(entry.agent, { type: 'answer', id: entry.agentId, password });
  });
}

/** Be polkit's authentication agent for the user's session. Call once the app is ready. */
export function registerPolkitAgent(opts: Options): void {
  options = opts;
  ipcMain.handle('polkit:answer', (event, requestId: unknown, password: unknown) => {
    opts.assertShellSender(event);
    return answer(requestId, password);
  });
  app.on('will-quit', () => {
    quitting = true;
    current?.stdin.end();
  });
  start();
}

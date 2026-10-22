// The signer bridge (window.nostrd, for the shell): Din's connection to
// nostrd, the system's Nostr signer daemon.
//
// nostrd holds the account keys and signs over a local socket (NIP-5F, the
// same one Amber Desktop serves), so neither Din nor anything else running as
// the user ever has them. Din is one UI for it: the shell's signer for an
// nostrd account sends every signature here, and the account menu adds,
// removes, and switches accounts through nostrd's management methods.
//
// One connection, opened on first use and reopened when nostrd restarts. It
// subscribes to nostrd's events (locked, unlocked, accounts_changed,
// active_changed) and passes them on to the shell, along with `connected` and
// `disconnected`, so the shell can resync.
//
// DinOS names the socket in DIN_NOSTRD_SOCKET and Din always signs through
// it there. Elsewhere Din looks where NIP-5F clients do, and uses what it
// finds only if it manages accounts (Amber's socket signs but doesn't).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';

const CONFIGURED = process.env.DIN_NOSTRD_SOCKET;
const SOCKET = CONFIGURED || path.join(os.homedir(), '.local/share/nostr/signer.sock');

/** Long enough for an unlock, which runs scrypt. */
const CALL_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 2_000;

/** Methods the shell may call: nostrd's own, minus `subscribe`, which this side does. */
const METHOD = /^[a-z0-9_]+$/;

type Reply = { result: unknown } | { error: { code: number; message: string } };

interface Pending {
  resolve: (reply: Reply) => void;
  timer: NodeJS.Timeout;
}

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
let supported: string[] = [];
let nextId = 1;
const pending = new Map<string, Pending>();
let emit: (event: unknown) => void = () => {};
let reconnectTimer: NodeJS.Timeout | null = null;

function fail(code: number, message: string): Reply {
  return { error: { code, message } };
}

function connect(): Promise<net.Socket> {
  if (socket) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise<net.Socket>((resolve, reject) => {
    const conn = net.createConnection(SOCKET);
    let buffer = '';
    let handshaken = false;
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!handshaken) {
          handshaken = true;
          supported = Array.isArray(message.supported_methods)
            ? message.supported_methods.filter((m): m is string => typeof m === 'string')
            : [];
          conn.write(`${JSON.stringify({ client: 'din' })}\n`);
          if (supported.includes('subscribe')) {
            conn.write(`${JSON.stringify({ id: 'subscribe', method: 'subscribe', params: [] })}\n`);
          }
          socket = conn;
          connecting = null;
          resolve(conn);
          emit({ event: 'connected' });
          continue;
        }
        if (typeof message.event === 'string') {
          emit({ event: message.event });
          continue;
        }
        const id = typeof message.id === 'string' ? message.id : null;
        const waiter = id ? pending.get(id) : undefined;
        if (!id || !waiter) continue;
        pending.delete(id);
        clearTimeout(waiter.timer);
        const error = message.error as { code?: unknown; message?: unknown } | null | undefined;
        waiter.resolve(
          error
            ? fail(typeof error.code === 'number' ? error.code : 10, String(error.message ?? 'error'))
            : { result: message.result },
        );
      }
    });
    conn.on('error', (error) => {
      if (!handshaken) {
        connecting = null;
        reject(error);
      }
    });
    conn.on('close', () => {
      const wasOpen = socket === conn;
      if (wasOpen) socket = null;
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve(fail(10, 'the signer went away'));
        pending.delete(id);
      }
      if (wasOpen) {
        emit({ event: 'disconnected' });
        scheduleReconnect();
      }
    });
  });
  return connecting;
}

/** Come back after nostrd restarts, so the shell hears about it. */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => scheduleReconnect());
  }, RECONNECT_MS);
}

async function call(method: string, params: unknown[]): Promise<Reply> {
  let conn: net.Socket;
  try {
    conn = await connect();
  } catch {
    return fail(10, 'the signer is not running');
  }
  const id = String(nextId++);
  return new Promise<Reply>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(fail(10, 'the signer did not answer'));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    conn.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

export function registerNostrdHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;
  emit = (event) => sendToShell('nostrd:event', event);

  /**
   * Whether Din should keep its accounts in nostrd: always on DinOS, and
   * elsewhere when a signer that manages accounts is listening.
   */
  ipcMain.handle('nostrd:info', async (event) => {
    assertShellSender(event);
    let connected = false;
    try {
      await connect();
      connected = true;
    } catch {
      // Not running (yet); on DinOS the shell still treats it as the signer.
    }
    const managed = connected && supported.includes('import_account');
    return { use: Boolean(CONFIGURED) || managed, connected, managed };
  });

  ipcMain.handle('nostrd:call', (event, method: unknown, params: unknown) => {
    assertShellSender(event);
    if (typeof method !== 'string' || !METHOD.test(method) || method === 'subscribe') {
      return fail(2, 'method not supported');
    }
    if (params !== undefined && !Array.isArray(params)) return fail(3, 'params must be an array');
    return call(method, params ?? []);
  });
}

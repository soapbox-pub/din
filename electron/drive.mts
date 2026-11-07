// The Drive bridge (window.dinos.drive, for Settings → Drive and `din drive`):
// Din Drive, the encrypted drive on Nostr and Blossom that din-drive mounts
// at ~/Drive (os/configuration.nix's services.din-drive, a systemd user
// service). While it's mounted, the daemon answers JSON requests, one per
// line, on $XDG_RUNTIME_DIR/din-drive.sock; this asks it for its state and
// to manage the trash. Setting it up runs `din-drive init`, which finds the
// account's drive or creates one (signing through nostrd), then starts the
// service.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ipcMain } from 'electron';
import { CommandError, runCommand } from './system.mts';

const SOCKET = path.join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'din-drive.sock');

export interface DriveStatus {
  pubkey: string;
  drive_id: string;
  mountpoint: string;
  relays: string[];
  servers: string[];
  connected_relays: number;
  items: number;
  pending_uploads: number;
  pending_publish: number;
  trash: number;
  last_sync: number | null;
  last_error: string | null;
}

export interface DriveTrashItem {
  id: string;
  name: string;
  dir: boolean;
  size: number;
  trashed: number;
}

export interface DriveState {
  /** din-drive is on this computer. */
  available: boolean;
  /** The drive is mounted, and this is what it says about itself. */
  status: DriveStatus | null;
}

/** Whether a program is on PATH. */
function onPath(name: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** One request to the running drive; rejects when it isn't running. */
function request(method: string, params: unknown = null, timeout = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Din Drive didn’t answer'));
    }, timeout);
    socket.on('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as { result?: unknown; error?: string };
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply.result ?? null);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function driveState(): Promise<DriveState> {
  const available = onPath('din-drive');
  if (!available) return { available, status: null };
  try {
    return { available, status: (await request('status', null, 3_000)) as DriveStatus };
  } catch {
    return { available, status: null };
  }
}

function commandMessage(error: unknown): string {
  if (error instanceof CommandError) {
    const lines = error.stderr.trim().split('\n').filter(Boolean);
    const last = lines.at(-1)?.replace(/^din-drive:\s*/, '');
    if (last) return last;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Find or create the account's drive, then mount it; resolves once it answers. */
async function setUp(): Promise<DriveStatus> {
  try {
    await runCommand('din-drive', ['init'], { timeout: 60_000 });
    await runCommand('systemctl', ['--user', 'restart', 'din-drive.service'], { timeout: 15_000 });
  } catch (error) {
    throw new Error(commandMessage(error), { cause: error });
  }
  for (let i = 0; i < 60; i++) {
    try {
      return (await request('status', null, 2_000)) as DriveStatus;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Din Drive was set up but didn’t start. Try again in a moment.');
}

export function registerDriveHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('drive:state', async (event) => {
    assertShellSender(event);
    return driveState();
  });

  ipcMain.handle('drive:setup', async (event) => {
    assertShellSender(event);
    return setUp();
  });

  ipcMain.handle('drive:trash', async (event) => {
    assertShellSender(event);
    return (await request('trash')) as DriveTrashItem[];
  });

  ipcMain.handle('drive:restore', async (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id !== 'string' || !/^[0-9a-f]{1,64}$/.test(id)) throw new Error('invalid item');
    await request('restore', { id });
  });

  ipcMain.handle('drive:emptyTrash', async (event) => {
    assertShellSender(event);
    return (await request('empty_trash', null, 120_000)) as number;
  });
}

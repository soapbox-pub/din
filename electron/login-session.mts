// Din as a login session on another Linux (window.dinos.session's install,
// update and the rest): Settings → About runs scripts/session.mjs, the same
// script as `npm run session:install`, and shows what it prints.
//
// It's offered from `npm run dev`, where the checkout is right here, and
// from the session itself, which builds from the checkout it was installed
// from (the session folder's `source`). The script runs in Electron as Node,
// so it needs no Node of its own; sudo asks for the password in Din.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { sudoAskpass } from './system-packages.mts';

export type LoginSessionAction = 'install' | 'update' | 'rollback' | 'default' | 'restore' | 'uninstall';

const ACTIONS: LoginSessionAction[] = ['install', 'update', 'rollback', 'default', 'restore', 'uninstall'];

/** The session folder scripts/session.mjs keeps its builds in. */
const SESSION_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'din', 'session');

const STATUS_TIMEOUT_MS = 15_000;

/** scripts/session.mjs: this checkout's under `npm run dev`, the source checkout's in the session. */
function script(devUrl: string | undefined): string | null {
  let root: string | null = null;
  if (devUrl) root = path.resolve(import.meta.dirname, '..');
  else if (process.env.DIN_SESSION_RELEASE) {
    try {
      root = fs.readFileSync(path.join(SESSION_DIR, 'source'), 'utf8').trim();
    } catch {
      root = null;
    }
  }
  if (!root) return null;
  const file = path.join(root, 'scripts', 'session.mjs');
  return fs.existsSync(file) ? file : null;
}

function isAction(raw: unknown): raw is LoginSessionAction {
  return typeof raw === 'string' && (ACTIONS as string[]).includes(raw);
}

function runScript(file: string, args: string[], onLine?: (line: string) => void, timeout?: number): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const askpass = sudoAskpass();
  if (askpass) env.SUDO_ASKPASS = askpass;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: path.dirname(path.dirname(file)),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    let stdout = '';
    let tail = '';
    let partial = '';
    const take = (chunk: Buffer, keep: boolean) => {
      const text = chunk.toString();
      if (keep) stdout += text;
      tail = (tail + text).slice(-4000);
      if (!onLine) return;
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };
    child.stdout.on('data', (chunk: Buffer) => take(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => take(chunk, false));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (partial && onLine) onLine(partial);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const lines = tail.trim().split('\n');
      reject(
        new Error(
          /no password was provided|password is required|incorrect password/i.test(tail)
            ? 'No administrator password was given.'
            : lines.slice(-3).join('\n') || `scripts/session.mjs failed (${code})`,
        ),
      );
    });
  });
}

let running: Promise<void> | null = null;

export function registerLoginSessionHandlers(options: {
  devUrl: string | undefined;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { devUrl, assertShellSender, sendToShell } = options;

  // scripts/session.mjs's builds, and NixOS's desktop module
  // (os/desktop-module.nix), which has no builds of its own to manage.
  ipcMain.handle('session:isLoginSession', (event) => {
    assertShellSender(event);
    return !!process.env.DIN_SESSION_RELEASE || process.env.DIN_LOGIN_SESSION === '1';
  });

  ipcMain.handle('session:status', async (event) => {
    assertShellSender(event);
    const file = script(devUrl);
    if (!file) return { available: false };
    const status: unknown = JSON.parse(await runScript(file, ['status', '--json'], undefined, STATUS_TIMEOUT_MS));
    return { available: true, busy: running !== null, ...(status as object) };
  });

  ipcMain.handle('session:run', async (event, action: unknown, makeDefault: unknown) => {
    assertShellSender(event);
    if (!isAction(action)) throw new Error('Unknown action');
    if (running) throw new Error('Something else is being done to the session. Try again once it’s done.');
    const file = script(devUrl);
    if (!file) throw new Error('Din’s source isn’t here to build from.');
    const args = action === 'install' && makeDefault === true ? [action, '--default'] : [action];
    running = runScript(file, args, (line) => sendToShell('session:output', line))
      .then(() => undefined)
      .finally(() => {
        running = null;
      });
    await running;
  });
}

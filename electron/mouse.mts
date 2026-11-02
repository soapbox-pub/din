// The mouse: Settings → Mouse's scrolling direction and speed, tracking
// speed, secondary click, and a Magic Mouse's middle click and two-finger
// swipe (window.dinos.mouse).
//
// Under din-shell, which owns the mice, Din tells it the settings in
// $XDG_RUNTIME_DIR/din-shell-mouse, which it watches
// (native/din-compositor/src/session/mouse.rs). din-shell in turn tells Din
// what's Din's to act on, over $XDG_RUNTIME_DIR/din-shell-events, a line at
// a time: `back` and `forward` (a mouse's side buttons, or a Magic Mouse's
// swipe), which go Back and Forward in the Web Browser, and `workspace 1`
// or `workspace -1` (the swipe), which show the workspace beside. They reach
// the desktop as shell shortcuts (src/lib/shellShortcuts.ts).
//
// Elsewhere the settings do nothing: the desktop Din runs in has its own.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { app, ipcMain } from 'electron';

export interface MouseSettings {
  scrollDirection: 'auto' | 'natural' | 'traditional';
  /** -1 (slowest) to 1 (fastest), 0 as libinput has it. */
  trackingSpeed: number;
  /** 0.25 to 4, 1 as the mouse sends it. */
  scrollSpeed: number;
  secondaryClick: 'right' | 'left' | 'off';
  middleClick: boolean;
  swipe: 'pages' | 'workspaces' | 'off';
}

/** Whether Din is on din-shell, which names its Wayland socket so (session/mod.rs). */
const onShell = process.env.WAYLAND_DISPLAY === 'din-shell' && !!process.env.XDG_RUNTIME_DIR;

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Not one of ${choices.join(', ')}`);
  return value as T;
}

function between(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Not a number from ${min} to ${max}`);
  }
  return value;
}

function parse(raw: unknown): MouseSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  if (typeof s.middleClick !== 'boolean') throw new Error('middleClick is not a boolean');
  return {
    scrollDirection: oneOf(s.scrollDirection, ['auto', 'natural', 'traditional']),
    trackingSpeed: between(s.trackingSpeed, -1, 1),
    scrollSpeed: between(s.scrollSpeed, 0.25, 4),
    secondaryClick: oneOf(s.secondaryClick, ['right', 'left', 'off']),
    middleClick: s.middleClick,
    swipe: oneOf(s.swipe, ['pages', 'workspaces', 'off']),
  };
}

async function tellShell(settings: MouseSettings): Promise<void> {
  const file = path.join(process.env.XDG_RUNTIME_DIR!, 'din-shell-mouse');
  const temp = `${file}.${process.pid}`;
  const text = [
    `scroll-direction=${settings.scrollDirection}`,
    `tracking-speed=${settings.trackingSpeed}`,
    `scroll-speed=${settings.scrollSpeed}`,
    `secondary-click=${settings.secondaryClick}`,
    `middle-click=${settings.middleClick ? 1 : 0}`,
    `swipe=${settings.swipe}`,
  ].join('\n');
  // Renamed into place, so din-shell never reads half of it.
  await fs.writeFile(temp, `${text}\n`);
  await fs.rename(temp, file);
}

/** Listen for din-shell's events, and hand each to the desktop. */
function listenToShell(sendToShell: (channel: string, payload?: unknown) => void): void {
  const file = path.join(process.env.XDG_RUNTIME_DIR!, 'din-shell-events');
  const server = net.createServer((socket) => {
    let rest = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line === 'back' || line === 'forward') {
          sendToShell('shortcut', { action: 'history', back: line === 'back' });
        } else if (line === 'workspace 1' || line === 'workspace -1') {
          sendToShell('shortcut', { action: 'workspace-step', step: line === 'workspace 1' ? 1 : -1 });
        }
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', (error) => console.warn('mouse: not listening to din-shell:', error));
  // A Din before this one may have left the socket behind.
  void fs.rm(file, { force: true }).then(() => server.listen(file));
  app.on('will-quit', () => server.close());
}

export function registerMouseHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;
  if (onShell) listenToShell(sendToShell);

  ipcMain.handle('mouse:status', (event) => {
    assertShellSender(event);
    return { available: onShell };
  });

  ipcMain.handle('mouse:set', async (event, raw: unknown) => {
    assertShellSender(event);
    const settings = parse(raw);
    if (onShell) await tellShell(settings);
  });
}

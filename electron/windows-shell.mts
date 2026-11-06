// Din on Windows, and as Windows' shell in place of explorer.exe
// (scripts/windows-shell.mjs packages it; its install-shell.ps1 sets the
// per-user Winlogon Shell to `din.exe --din-shell`).
//
// There's no logind or systemd to ask: restart and shut down go through
// shutdown.exe, which any signed-in user may run. As the shell, Din is the
// session, so Log out signs out of Windows; quitting would leave the user on
// an empty black screen, since Winlogon restarts only Explorer.
//
// As the shell, Din's window is the desktop: windows-shell-helper.ps1 keeps it
// under every program's window, as Explorer's desktop is, and sets the work
// area so maximized programs leave Din's menu bar showing.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { screen, type BrowserWindow } from 'electron';
import { runCommand } from './system.mts';

export const isWindows = process.platform === 'win32';

/** Whether Din was started as the user's Windows shell. */
export function isWindowsShell(): boolean {
  return isWindows && (process.argv.includes('--din-shell') || process.env.DIN_WINDOWS_SHELL === '1');
}

async function shutdownExe(args: string[]): Promise<void> {
  await runCommand('shutdown.exe', args, { timeout: 15_000 });
}

export const windowsPower = {
  reboot: () => shutdownExe(['/r', '/t', '0']),
  powerOff: () => shutdownExe(['/s', '/t', '0']),
  logOff: () => shutdownExe(['/l']),
};

/** The menu bar's height (src/components/desktop/MenuBar.tsx), kept clear of maximized programs. */
const MENU_BAR_HEIGHT = 36;

/** The primary display's work area below the menu bar, in physical pixels: left, top, right, bottom. */
function workArea(win: BrowserWindow): number[] {
  const { bounds } = screen.getPrimaryDisplay();
  const area = screen.dipToScreenRect(win, {
    x: bounds.x,
    y: bounds.y + MENU_BAR_HEIGHT,
    width: bounds.width,
    height: bounds.height - MENU_BAR_HEIGHT,
  });
  return [area.x, area.y, area.x + area.width, area.y + area.height];
}

/** Make Din's window the desktop under Windows' programs, for as long as it's open. */
export function becomeWindowsDesktop(win: BrowserWindow): void {
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
  const [left, top, right, bottom] = workArea(win);
  const script = path.join(import.meta.dirname, 'windows-shell-helper.ps1');
  const helper: ChildProcess = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Window', String(hwnd), '-Left', String(left), '-Top', String(top), '-Right', String(right), '-Bottom', String(bottom)],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  helper.stderr?.on('data', (chunk: Buffer) => console.error('windows-shell-helper:', chunk.toString().trim()));
  helper.on('error', (error) => console.error('windows-shell-helper:', error.message));
  helper.on('exit', (code) => console.error(`windows-shell-helper exited (${code})`));

  const refit = () => {
    if (win.isDestroyed() || !helper.stdin?.writable) return;
    helper.stdin.write(`workarea ${workArea(win).join(' ')}\n`);
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', refit);
    screen.removeListener('display-added', refit);
    screen.removeListener('display-removed', refit);
    helper.stdin?.end();
  });
}

import { ipcMain, session } from 'electron';

/**
 * Getting what the desktop keeps in localStorage (the windows open, the
 * browser's tabs: src/lib/windowSession.ts) onto the disk.
 *
 * Chromium holds localStorage writes in memory and commits them later, at
 * least 5 s on and longer the more a page writes, and systemd stops Din with
 * no time to spare (din-shell goes in milliseconds). So a session saved a
 * while before a restart could still be in memory and lost, leaving the
 * windows that come back well behind the ones open. The desktop asks for a
 * flush after each save, and anything that's about to stop Din asks it to
 * save first (`saveBeforeStopping`).
 */

/** The most often the disk is written, however often the desktop saves. */
const FLUSH_INTERVAL_MS = 1_000;
/** How long the desktop gets to save before Din stops anyway. */
const SAVE_TIMEOUT_MS = 1_500;

let lastFlush = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Commit the desktop's storage now. */
function flushNow(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastFlush = Date.now();
  try {
    session.defaultSession.flushStorageData();
  } catch (error) {
    console.warn('[session-save] flushing storage failed:', error);
  }
}

/** Commit soon: now, or once FLUSH_INTERVAL_MS has passed since the last. */
function flushSoon(): void {
  if (flushTimer) return;
  const wait = lastFlush + FLUSH_INTERVAL_MS - Date.now();
  if (wait <= 0) flushNow();
  else flushTimer = setTimeout(flushNow, wait);
}

let ask: ((channel: string, payload?: unknown) => void) | null = null;
let nextRequest = 0;
const waiting = new Map<number, () => void>();

/**
 * Have the desktop save everything it keeps for the next start, and put it
 * on the disk, before Din is stopped (Restart Din, restarting or turning off
 * the computer). Resolves once saved, or after SAVE_TIMEOUT_MS regardless:
 * a desktop that's hung mustn't keep the computer from restarting.
 */
export async function saveBeforeStopping(): Promise<void> {
  if (ask) {
    const id = ++nextRequest;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, SAVE_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        waiting.delete(id);
        resolve();
      }
      waiting.set(id, done);
      ask?.('shell:saveNow', id);
    });
  }
  flushNow();
}

export function registerSessionSaveHandlers(options: {
  isShellSender: (event: Electron.IpcMainEvent) => boolean;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { isShellSender, sendToShell } = options;
  ask = sendToShell;

  ipcMain.on('shell:flushStorage', (event) => {
    if (isShellSender(event)) flushSoon();
  });

  ipcMain.on('shell:saved', (event, id: unknown) => {
    if (!isShellSender(event) || typeof id !== 'number') return;
    waiting.get(id)?.();
  });
}

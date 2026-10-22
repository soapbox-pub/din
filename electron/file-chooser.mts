// Native apps' Open and Save dialogs, in Din's file picker.
//
// The desktop portal sends file chooser requests to the backend in
// file-chooser-portal.mts (a utility process: see there for why). This side
// passes each one to the shell, which shows its file picker
// (FilePickerBridgeHost, the same one web pages' uploads use), and carries
// the user's answer back.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import { app, utilityProcess } from 'electron';
import { sessionBusAddress } from './native-display.mts';
import type { PortalAnswer, PortalMessage } from './file-chooser-portal.mts';

const SERVER = path.join(import.meta.dirname, 'file-chooser-portal.mts');

let server: Electron.UtilityProcess | null = null;
let options: {
  sendToShell: (channel: string, payload?: unknown) => void;
  /** An id for a picker request, unique among the shell's. */
  nextRequestId: () => number;
} | null = null;
/** Picker request id -> portal request id. */
const pending = new Map<number, number>();

async function startServer(): Promise<void> {
  const address = await sessionBusAddress();
  if (!address) return;
  const child = utilityProcess.fork(SERVER, [], {
    serviceName: 'Din file chooser',
    stdio: 'inherit',
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address },
  });
  server = child;
  child.on('message', (message: PortalMessage) => {
    if (!options) return;
    if (message.type === 'open') {
      const requestId = options.nextRequestId();
      pending.set(requestId, message.id);
      options.sendToShell('filepicker:request', { requestId, origin: '', options: message.request });
    } else if (message.type === 'close') {
      for (const [requestId, id] of pending) {
        if (id !== message.id) continue;
        pending.delete(requestId);
        options.sendToShell('filepicker:cancel', { requestId });
      }
    }
  });
  child.once('exit', () => {
    if (server !== child) return;
    server = null;
    pending.clear();
    setTimeout(() => void startServer(), 5_000);
  });
}

function reply(answer: PortalAnswer): void {
  server?.postMessage(answer);
}

/**
 * The shell's answer to a picker request. Returns false if it wasn't one of
 * the portal's.
 */
export function answerFileChooser(requestId: number, paths: string[] | null, filter: number | null): boolean {
  const id = pending.get(requestId);
  if (id === undefined) return false;
  pending.delete(requestId);
  reply({ type: 'answer', id, paths, filter });
  return true;
}

/**
 * The shell (re)loaded: pickers it was showing are gone, so the apps
 * waiting on them hear they were cancelled.
 */
export function cancelFileChoosers(): void {
  for (const id of pending.values()) reply({ type: 'answer', id, paths: null, filter: null });
  pending.clear();
}

/** Start the portal backend. */
export function registerFileChooserPortal(opts: NonNullable<typeof options>): void {
  options = opts;
  void startServer();
  app.on('will-quit', () => server?.kill());
}

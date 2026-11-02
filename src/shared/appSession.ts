/**
 * State an app's windows share while any of them is open, kept in a
 * SharedWorker of the app's origin (src/shared/appSessionWorker.ts), which
 * lives as long as one of its windows does: Files' undo history, a tab
 * torn off for the new window that adopts it. Structured-cloneable values;
 * not saved anywhere.
 */

type Reply = { id: number; value: unknown };

let port: MessagePort | null = null;
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

function connect(): MessagePort {
  if (port) return port;
  const worker = new SharedWorker(new URL('./appSessionWorker.ts', import.meta.url), { type: 'module', name: 'app-session' });
  port = worker.port;
  port.onmessage = ({ data }: MessageEvent<Reply>) => {
    pending.get(data.id)?.(data.value);
    pending.delete(data.id);
  };
  port.start();
  return port;
}

/** A value the app's windows keep, or undefined. */
export function sessionGet(key: string): Promise<unknown> {
  const p = connect();
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    p.postMessage({ type: 'get', id, key });
  });
}

/** Keep a value for the app's windows; undefined forgets it. */
export function sessionSet(key: string, value: unknown): void {
  connect().postMessage({ type: 'set', key, value });
}

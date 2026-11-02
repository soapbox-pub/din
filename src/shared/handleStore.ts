/**
 * File handles kept to open again after a restart (a Recent list), in the
 * page's IndexedDB as the web keeps them: Din's handles go in and come out
 * of a store like any other value (the runtime keeps their grants with the
 * desktop, src/sdk/standards.ts). Keys are strings the app keeps where it
 * likes. The runtime also puts handles kept from before (the old
 * `din.files.persist` tokens) here, under those tokens.
 */

const DB_NAME = 'din-handles';
const STORE = 'handles';

let opening: Promise<IDBDatabase> | null = null;

/** The database, made the first time. */
export function handleDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB wouldn’t open'));
  });
  opening.catch(() => (opening = null));
  return opening;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return handleDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
      }),
  );
}

/** Keep a handle; resolves with the key it's kept under. */
export async function storeHandle(handle: FileSystemHandle): Promise<string> {
  const key = crypto.randomUUID();
  await run('readwrite', (store) => store.put(handle, key));
  return key;
}

/**
 * A kept handle, with its grant back (which also brings its folder into
 * reach for an app with `file-folders`); null when it's not kept, the file
 * is gone, or the grant was revoked.
 */
export async function loadHandle(key: string): Promise<FileSystemHandle | null> {
  const handle = await run<unknown>('readonly', (store) => store.get(key)).catch(() => undefined);
  if (!handle || typeof (handle as FileSystemHandle).queryPermission !== 'function') return null;
  return (await (handle as FileSystemHandle).queryPermission()) === 'granted' ? (handle as FileSystemHandle) : null;
}

/** Forget a kept handle (a Recent entry removed). */
export function forgetHandle(key: string): void {
  void run('readwrite', (store) => store.delete(key)).catch(() => {});
}

/** Put values in under their keys, leaving any already there: the runtime's handles kept from before. */
export async function seedHandles(entries: [string, unknown][]): Promise<string[]> {
  const db = await handleDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [key, value] of entries) {
      const req = store.add(value, key);
      req.onerror = (e) => {
        // Already there: kept.
        e.preventDefault();
        e.stopPropagation();
      };
    }
    tx.oncomplete = () => resolve(entries.map(([key]) => key));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'));
  });
}

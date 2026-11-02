import type { Din } from '@/sdk';

/**
 * Publisher reaches the folders of files the user hands it: a document's
 * folder once it's opened or saved, a picture's when it's placed. A link
 * outside the document's folder would be out of reach after a restart, so
 * each one a saved document keeps gets a persisted handle here, by path,
 * with the documents (by handle key) that link it. Restoring the handle
 * brings its folder back; the last document to drop a link releases it.
 */

const KEY = 'din:publisher:links';

interface Kept {
  token: string;
  docs: string[];
}

function read(): Record<string, Kept> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, Kept>) : {};
  } catch {
    return {};
  }
}

const write = (all: Record<string, Kept>) => localStorage.setItem(KEY, JSON.stringify(all));

const within = (dir: string, path: string) => path.startsWith(`${dir.replace(/\/$/, '')}/`);

const reached = new Map<string, Promise<void>>();

/** Bring a linked file's folder into reach from its kept handle, once per window. */
export function reachLink(din: Din, path: string): Promise<void> {
  let p = reached.get(path);
  if (!p) {
    const kept = read()[path];
    p = kept ? din.files.restore(kept.token).then(() => {}, () => {}) : Promise.resolve();
    reached.set(path, p);
  }
  return p;
}

/**
 * After a document is saved: keep a handle for each file it links outside
 * its folder, and let go of those it no longer links.
 */
export async function keepLinks(din: Din, doc: string, docDir: string, paths: string[]): Promise<void> {
  const want = new Set(paths.filter((p) => p.startsWith('/') && !within(docDir, p)));
  const fresh = new Map<string, string>();
  for (const path of want) {
    if (read()[path]) continue;
    try {
      fresh.set(path, await din.files.persist(await din.files.fromPath(path)));
    } catch {
      // Gone, or out of reach: nothing to keep.
    }
  }
  // Read again: another window may have saved meanwhile.
  const all = read();
  for (const [path, token] of fresh) {
    if (all[path]) din.files.release(token);
    else all[path] = { token, docs: [] };
  }
  for (const [path, kept] of Object.entries(all)) {
    const has = kept.docs.includes(doc);
    if (want.has(path) && !has) kept.docs.push(doc);
    else if (!want.has(path) && has) kept.docs = kept.docs.filter((d) => d !== doc);
    if (!kept.docs.length) {
      din.files.release(kept.token);
      delete all[path];
      reached.delete(path);
    }
  }
  write(all);
}

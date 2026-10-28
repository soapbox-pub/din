/**
 * The cursor converter: whatever the user picked, as files, becomes XCursor
 * themes' worth of cursors.
 *
 * It runs in a sandboxed window of its own (electron/cursorConverter.mts),
 * with nothing but the bytes it's given and Chromium's image decoders: an
 * input crafted to break a parser here breaks a renderer with no access to
 * anything. The main process checks what comes back before it writes a
 * file (electron/cursorImport.mts).
 *
 * Reads: CursorXP (.CurXPTheme), CursorFX (.CursorFX), Mousecape (.cape),
 * Hyprcursor, Windows .cur/.ani packs, and XCursor themes; as a single file,
 * a folder, or a ZIP, tar or gzipped tar of them.
 */

import { Budget, DAMAGED, ImportError, LIMITS, TOO_BIG } from './bytes';
import { type Tree, baseOf, cleanPath, dirOf, isGzip, isTar, isZip, readArchive, readZip, resolve } from './archive';
import { curxpTheme } from './curxp';
import { cursorFXTheme, isCursorFX } from './cursorfx';
import { hyprcursorTheme } from './hyprcursor';
import type { Decoder } from './image';
import { mousecapeTheme } from './mousecape';
import type { ConvertedTheme } from './theme';
import { windowsTheme } from './windows';
import { xcursorRoots, xcursorTheme } from './xcursor';

export { ImportError } from './bytes';
export type { ConvertedTheme } from './theme';
export type { Decoder, Rgba } from './image';

/** One file or symlink of what's being imported. */
export interface SourceEntry {
  path: string;
  data?: Uint8Array;
  link?: string;
}

export interface ConvertRequest {
  /** The picked file or folder's name, for themes that don't name themselves. */
  name: string;
  entries: SourceEntry[];
}

/** File name extensions that say what a picked file is. */
const EXTENSIONS = /\.(curxptheme|cursorfx|cape|zip|tar(\.(gz|xz|bz2))?|tgz|txz|tbz2?|cur|ani|inf)$/i;

export async function convertCursors(request: ConvertRequest, decoder: Decoder): Promise<ConvertedTheme[]> {
  const budget = new Budget();
  const fallbackName = request.name.replace(EXTENSIONS, '').trim().slice(0, 80) || 'Imported cursors';

  let tree: Tree = new Map();
  if (request.entries.length > LIMITS.entries) throw new ImportError(TOO_BIG);
  for (const entry of request.entries) {
    const path = cleanPath(entry.path);
    if (!path) continue;
    // Checked by shape, not instanceof: the bytes may come from another realm.
    if (ArrayBuffer.isView(entry.data)) {
      const data = new Uint8Array(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
      budget.entry(data.length);
      tree.set(path, { data });
    } else if (typeof entry.link === 'string') {
      budget.entry(0);
      tree.set(path, { link: entry.link });
    }
  }

  // A single archive is what's in it (a .CurXPTheme is a ZIP too).
  if (tree.size === 1) {
    const [[, node]] = tree;
    if ('data' in node && (isZip(node.data) || isGzip(node.data) || isTar(node.data))) {
      const inner: Tree = new Map();
      await readArchive(node.data, inner, budget);
      tree = inner;
      if (!tree.size) throw new ImportError(DAMAGED);
    }
  }

  // CursorXP themes found inside another archive are opened too: themes are
  // often passed around zipped. Only one level deep.
  for (const [key] of [...tree]) {
    if (!/\.curxptheme$/i.test(key)) continue;
    const file = resolve(tree, key);
    if (file && isZip(file.data)) await readZip(file.data, tree, budget, `${key}.contents`);
  }

  const found: ConvertedTheme[] = [];
  let failure: unknown = null;
  const attempt = async (make: () => Promise<ConvertedTheme | null>) => {
    if (found.length >= LIMITS.themes) return;
    try {
      const theme = await make();
      if (theme) found.push(theme);
    } catch (error) {
      // Running out of budget ends the whole import; anything else only this theme.
      if (error instanceof ImportError && error.message === TOO_BIG) throw error;
      failure ??= error;
    }
  };

  const keys = [...tree.keys()].sort();
  const xcursor = xcursorRoots(tree);
  const windowsDirs = new Set<string>();
  for (const key of keys) {
    const base = baseOf(key).toLowerCase();
    const dir = dirOf(key);
    if (base === 'scheme.ini') {
      await attempt(() => curxpTheme(tree, key, budget, decoder, dir ? baseOf(dir).replace(/\.contents$/, '').replace(EXTENSIONS, '') : fallbackName));
    } else if (base.endsWith('.cursorfx')) {
      const file = resolve(tree, key);
      if (file && isCursorFX(file.data)) await attempt(() => cursorFXTheme(file.data, budget, baseOf(key).replace(EXTENSIONS, '')));
    } else if (base.endsWith('.cape')) {
      const file = resolve(tree, key);
      if (file) await attempt(() => mousecapeTheme(file.data, budget, decoder, baseOf(key).replace(EXTENSIONS, '')));
    } else if ((base === 'manifest.hl' || base === 'manifest.toml') && !xcursor.has(dir)) {
      // A theme shipping both kinds is taken as XCursor, which it was made at sizes for.
      await attempt(() => hyprcursorTheme(tree, key, budget, decoder, fallbackName));
    } else if (/\.(cur|ani)$/.test(base)) {
      windowsDirs.add(dir);
    }
  }
  for (const dir of windowsDirs) await attempt(() => windowsTheme(tree, dir, budget, decoder, fallbackName));
  for (const root of xcursor) await attempt(async () => xcursorTheme(tree, root, budget, fallbackName));

  // A lone file without a telling name: try it as each single-file format.
  if (!found.length && request.entries.length === 1 && tree.size === 1) {
    const [[key]] = tree;
    const file = resolve(tree, key);
    if (file && isCursorFX(file.data)) await attempt(() => cursorFXTheme(file.data, budget, fallbackName));
  }

  if (!found.length) {
    if (failure instanceof ImportError) throw failure;
    throw new ImportError('No cursor themes were found in it.');
  }
  return found;
}


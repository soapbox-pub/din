/**
 * XCursor themes as a source: a directory with a cursors/ directory of
 * XCursor files, and maybe an index.theme. Every file is decoded into
 * frames and written anew, so what din-shell, Chromium and libXcursor end up
 * reading is always a file Din made.
 */

import { Budget, DAMAGED, ImportError, LIMITS, TOO_BIG, need, text, u32le } from './bytes';
import { type Tree, baseOf, dirOf, join, resolve } from './archive';
import type { Frame } from './image';
import { CURSOR_NAME, HOLD_MS, type ConvertedTheme } from './theme';

const IMAGE = 0xfffd0002;

/** An XCursor file's frames, in file order; null if it isn't one. */
export function decodeXcursor(data: Uint8Array, budget: Budget): Frame[] | null {
  if (data.length < 16 || text(data.subarray(0, 4), 'latin1') !== 'Xcur') return null;
  const headerSize = u32le(data, 4);
  const count = u32le(data, 12);
  if (headerSize < 16 || count > 4096) throw new ImportError(DAMAGED);
  need(data, headerSize, count * 12);
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const entry = headerSize + i * 12;
    if (u32le(data, entry) !== IMAGE) continue;
    const position = u32le(data, entry + 8);
    const chunkHeader = u32le(data, position);
    if (chunkHeader < 36 || u32le(data, position + 4) !== IMAGE) throw new ImportError(DAMAGED);
    const size = u32le(data, position + 8);
    const width = u32le(data, position + 16);
    const height = u32le(data, position + 20);
    const hotX = u32le(data, position + 24);
    const hotY = u32le(data, position + 28);
    const delay = u32le(data, position + 32);
    if (width < 1 || height < 1 || width > LIMITS.frameDimension || height > LIMITS.frameDimension) {
      throw new ImportError(TOO_BIG);
    }
    if (size < 1 || size > LIMITS.frameDimension || hotX >= width || hotY >= height) throw new ImportError(DAMAGED);
    need(data, position + chunkHeader, width * height * 4);
    budget.frame(width * height * 4);
    frames.push({
      size,
      width,
      height,
      hotX,
      hotY,
      delay: Math.min(delay, HOLD_MS),
      pixels: data.slice(position + chunkHeader, position + chunkHeader + width * height * 4),
    });
  }
  if (frames.length > LIMITS.framesPerCursor * 8) throw new ImportError(TOO_BIG);
  return frames.length ? frames : null;
}

/** An index.theme's Name= and Inherits=. */
export function parseIndexTheme(data: Uint8Array | undefined): { name: string | null; inherits: string[] } {
  const source = data ? text(data) : '';
  const name = /^Name\s*=\s*(.+)$/m.exec(source)?.[1].trim() || null;
  const inherits = (/^Inherits\s*=\s*(.+)$/m.exec(source)?.[1] ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { name, inherits };
}

/** The roots of the XCursor themes in a tree: directories with a cursors/ directory. */
export function xcursorRoots(tree: Tree): Set<string> {
  const roots = new Set<string>();
  for (const key of tree.keys()) {
    const dir = dirOf(key);
    if (baseOf(dir) === 'cursors') roots.add(dirOf(dir));
  }
  return roots;
}

export function xcursorTheme(tree: Tree, root: string, budget: Budget, fallbackName: string): ConvertedTheme | null {
  const prefix = join(root, 'cursors') + '/';
  const cursors: { name: string; frames: Frame[] }[] = [];
  const links = new Map<string, string>();
  const decoded = new Map<string, string>();
  for (const key of tree.keys()) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (name.includes('/') || !CURSOR_NAME.test(name)) continue;
    const resolved = resolve(tree, key);
    if (!resolved) continue;
    // A link to another cursor of the theme stays a link.
    const known = decoded.get(resolved.path);
    if (known) {
      links.set(name, known);
      continue;
    }
    const frames = decodeXcursor(resolved.data, budget);
    if (!frames) continue;
    const target = resolved.path.slice(prefix.length);
    const own = resolved.path.startsWith(prefix) && CURSOR_NAME.test(target) && !target.includes('/') ? target : name;
    cursors.push({ name: own, frames });
    decoded.set(resolved.path, own);
    if (own !== name) links.set(name, own);
  }
  const names = new Set(cursors.map((c) => c.name));
  for (const [alias] of links) if (names.has(alias)) links.delete(alias);
  if (!names.has('left_ptr') && !links.has('left_ptr')) {
    const arrow = ['default', 'arrow', 'top_left_arrow'].find((n) => names.has(n) || links.has(n));
    if (!arrow) return null;
    links.set('left_ptr', links.get(arrow) ?? arrow);
  }

  const index = tree.get(join(root, 'index.theme'));
  const { name, inherits } = parseIndexTheme(index && 'data' in index ? index.data : undefined);
  return {
    name: name ?? (root ? baseOf(root) : fallbackName),
    inherits,
    cursors,
    links: [...links],
  };
}

/**
 * Windows cursors (.cur, .ani).
 *
 * A .cur is an icon directory: one image per size, each a PNG or a BMP
 * (colors, then a 1-bit transparency mask) with a hotspot. An .ani is a
 * RIFF file of .cur frames with a play sequence and per-step timing. A pack
 * is a folder or archive of them, usually with an install.inf saying which
 * file is which cursor.
 */

import { Budget, DAMAGED, ImportError, LIMITS, i32le, slice, text, u16le, u32le } from './bytes';
import { type Tree, baseOf, listDir, resolve } from './archive';
import { type Bitmap, type Decoder, type Frame, decodePng, isPng, makeFrame, premultiplyBgra } from './image';
import { type ConvertedTheme, WINDOWS_ROLES, themeFrom } from './theme';

/** One image of a .cur. */
interface WinImage {
  image: Bitmap;
  hotX: number;
  hotY: number;
}

/** A BMP-format icon image (a DIB with a doubled height and an AND mask). */
export function decodeDib(data: Uint8Array, budget: Budget): Bitmap {
  const headerSize = u32le(data, 0);
  const width = i32le(data, 4);
  const height = Math.abs(i32le(data, 8)) / 2;
  const bitCount = u16le(data, 14);
  const compression = u32le(data, 16);
  const colorsUsed = u32le(data, 32);
  if (!Number.isInteger(height) || width < 1 || height < 1) throw new ImportError(DAMAGED);
  if (width > LIMITS.frameDimension || height > LIMITS.frameDimension) throw new ImportError(DAMAGED);
  if (![1, 4, 8, 24, 32].includes(bitCount) || (compression !== 0 && compression !== 3)) throw new ImportError(DAMAGED);
  if (headerSize < 40 || colorsUsed > 256) throw new ImportError(DAMAGED);
  budget.image(width, height);

  const palette = headerSize + (compression === 3 && headerSize === 40 ? 12 : 0);
  const paletteSize = bitCount <= 8 ? colorsUsed || 1 << bitCount : 0;
  const colors = palette + paletteSize * 4;
  const colorStride = Math.floor((width * bitCount + 31) / 32) * 4;
  const maskStride = Math.floor((width + 31) / 32) * 4;
  const mask = colors + colorStride * height;
  slice(data, colors, colorStride * height);
  if (paletteSize) slice(data, palette, paletteSize * 4);
  const hasMask = mask + maskStride * height <= data.length;

  const out = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = colors + (height - 1 - y) * colorStride;
    const maskRow = mask + (height - 1 - y) * maskStride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let b: number;
      let g: number;
      let r: number;
      let a = 255;
      if (bitCount === 32) {
        [b, g, r, a] = [data[row + x * 4], data[row + x * 4 + 1], data[row + x * 4 + 2], data[row + x * 4 + 3]];
        if (a) anyAlpha = true;
      } else if (bitCount === 24) {
        [b, g, r] = [data[row + x * 3], data[row + x * 3 + 1], data[row + x * 3 + 2]];
      } else {
        const bit = x * bitCount;
        const index = (data[row + (bit >> 3)] >> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1);
        const entry = palette + Math.min(index, paletteSize - 1) * 4;
        [b, g, r] = [data[entry], data[entry + 1], data[entry + 2]];
      }
      const masked = hasMask && (data[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bitCount !== 32 && masked) {
        // Masked with a color means "invert the screen", which XCursor
        // can't do; black is what that usually looks like on light ground.
        if (b || g || r) [b, g, r, a] = [0, 0, 0, 255];
        else a = 0;
      }
      out[o] = b;
      out[o + 1] = g;
      out[o + 2] = r;
      out[o + 3] = a;
    }
  }
  // 32-bit images with no alpha at all rely on the mask instead.
  if (bitCount === 32 && !anyAlpha && hasMask) {
    for (let y = 0; y < height; y++) {
      const maskRow = mask + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        const masked = (data[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }
  return { width, height, pixels: premultiplyBgra(out) };
}

/** Every image of a .cur (or .ico) file. */
export async function decodeCur(data: Uint8Array, budget: Budget, decoder: Decoder): Promise<WinImage[]> {
  if (data.length < 6 || u16le(data, 0) !== 0) return [];
  const type = u16le(data, 2);
  const count = u16le(data, 4);
  if ((type !== 1 && type !== 2) || count > 64) return [];
  const images: WinImage[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const hotX = type === 2 ? u16le(data, entry + 4) : 0;
    const hotY = type === 2 ? u16le(data, entry + 6) : 0;
    const bytes = slice(data, u32le(data, entry + 12), u32le(data, entry + 8));
    const image = isPng(bytes) ? await decodePng(decoder, budget, bytes) : decodeDib(bytes, budget);
    if (image.width > LIMITS.frameDimension || image.height > LIMITS.frameDimension) continue;
    images.push({ image, hotX: Math.min(hotX, image.width - 1), hotY: Math.min(hotY, image.height - 1) });
  }
  return images;
}

const sizeOf = ({ image }: WinImage) => Math.max(image.width, image.height);

/** A .cur as frames: one still image per size. */
export async function curFrames(data: Uint8Array, budget: Budget, decoder: Decoder): Promise<Frame[]> {
  return (await decodeCur(data, budget, decoder)).map((w) =>
    makeFrame(budget, w.image, { size: sizeOf(w), hotX: w.hotX, hotY: w.hotY, delay: 0 }),
  );
}

/** An .ani as frames: its animation, at each size its first frame has. */
export async function aniFrames(data: Uint8Array, budget: Budget, decoder: Decoder): Promise<Frame[]> {
  if (data.length < 12 || text(data.subarray(0, 4), 'latin1') !== 'RIFF' || text(data.subarray(8, 12), 'latin1') !== 'ACON') {
    return [];
  }
  let steps = 0;
  let jiffies = 0;
  let rates: number[] | null = null;
  let sequence: number[] | null = null;
  const icons: Uint8Array[] = [];
  const end = Math.min(data.length, 8 + u32le(data, 4));
  const walk = (start: number, stop: number, depth: number) => {
    if (depth > LIMITS.depth) throw new ImportError(DAMAGED);
    let p = start;
    while (p + 8 <= stop) {
      const id = text(data.subarray(p, p + 4), 'latin1');
      const length = u32le(data, p + 4);
      const body = p + 8;
      if (body + length > stop) break;
      if (id === 'anih' && length >= 36) {
        steps = u32le(data, body + 8) || u32le(data, body + 4);
        jiffies = u32le(data, body + 28);
      } else if (id === 'rate' || id === 'seq ') {
        const values = Array.from({ length: Math.min(LIMITS.framesPerCursor * 4, Math.floor(length / 4)) }, (_, i) =>
          u32le(data, body + i * 4),
        );
        if (id === 'rate') rates = values;
        else sequence = values;
      } else if (id === 'LIST' && length >= 4) {
        walk(body + 4, body + length, depth + 1);
      } else if (id === 'icon' && icons.length < LIMITS.framesPerCursor) {
        icons.push(data.subarray(body, body + length));
      }
      p = body + length + (length & 1);
    }
  };
  walk(12, end, 0);

  const frames: WinImage[][] = [];
  for (const icon of icons) {
    const images = await decodeCur(icon, budget, decoder);
    if (!images.length) return [];
    frames.push(images);
  }
  if (!frames.length) return [];

  const order: number[] = (sequence as number[] | null) ?? frames.map((_, i) => i);
  const count = Math.min(LIMITS.framesPerCursor, steps || order.length, order.length);
  const rateList = rates as number[] | null;
  const delayOf = (step: number) => Math.min(60_000, Math.max(1, Math.round(((rateList?.[step] ?? jiffies) || 1) * (1000 / 60))));
  const result: Frame[] = [];
  for (const first of frames[0]) {
    const size = sizeOf(first);
    for (let step = 0; step < count; step++) {
      const images = frames[order[step]] ?? frames[0];
      const nearest = images.reduce((best, w) => (Math.abs(sizeOf(w) - size) < Math.abs(sizeOf(best) - size) ? w : best));
      result.push(makeFrame(budget, nearest.image, { size, hotX: nearest.hotX, hotY: nearest.hotY, delay: count > 1 ? delayOf(step) : 0 }));
    }
  }
  return result;
}

/** The fields of an .inf line, quotes taken off: `HKCU,"Control Panel\Cursors",Arrow,...`. */
function infFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      fields.push(current.trim());
      current = '';
    } else current += char;
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Which file each Windows role is, from an install.inf: its scheme (every
 * role's file in scheme order) or its per-role registry lines, with
 * %strings% filled in. Also the scheme's name, if it gives one.
 */
export function parseInf(source: string): { name: string | null; files: Map<string, string> } {
  const strings = new Map<string, string>();
  let section = '';
  const lines = source
    .split(/\r?\n/)
    .map((l) => l.replace(/;.*$/, '').trim())
    .filter(Boolean);
  for (const line of lines) {
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (section === 'strings' && eq > 0) {
      strings.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1'));
    }
  }
  // Substituted a few times over (strings name strings), never growing past a line's worth.
  const expand = (value: string) => {
    let result = value;
    for (let i = 0; i < 4 && result.includes('%'); i++) {
      result = result.replace(/%([^%]*)%/g, (_, key: string) => strings.get(key.toLowerCase()) ?? '').slice(0, 4096);
    }
    return result;
  };
  const fileName = (value: string) => expand(value).split(/[\\/]/).pop()?.trim() ?? '';

  let name: string | null = strings.get('scheme_name') ?? null;
  const files = new Map<string, string>();
  for (const line of lines) {
    if (line.startsWith('[')) continue;
    const fields = infFields(line);
    const key = (fields[1] ?? '').toLowerCase();
    if (key.endsWith('control panel\\cursors\\schemes') && fields[4]) {
      name ??= expand(fields[2] ?? '') || null;
      expand(fields[4])
        .split(',')
        .forEach((value, i) => {
          const file = fileName(value);
          if (file && WINDOWS_ROLES[i]) files.set(WINDOWS_ROLES[i].windows.toLowerCase(), file);
        });
    } else if (key.endsWith('control panel\\cursors') && fields[2] && fields[4]) {
      const file = fileName(fields[4]);
      if (file) files.set(expand(fields[2]).toLowerCase(), file);
    }
  }
  return { name, files };
}

/** File-name patterns for each Windows role, for packs without an install.inf. Most specific first. */
const NAME_GUESSES: [string, RegExp][] = [
  ['uparrow', /up.?arrow|alternate/],
  ['help', /help/],
  ['appstarting', /appstart|working|background|progress/],
  ['wait', /wait|busy/],
  ['crosshair', /cross|precision/],
  ['ibeam', /ibeam|beam|text/],
  ['nwpen', /handwrit|pen/],
  ['no', /^no$|unavailable|not.?allowed|forbidden/],
  ['sizens', /sizens|vert/],
  ['sizewe', /sizewe|horz|horiz/],
  ['sizenwse', /sizenwse|nwse|dgn1|diag.?1/],
  ['sizenesw', /sizenesw|nesw|dgn2|diag.?2/],
  ['sizeall', /sizeall|move/],
  ['hand', /hand|link/],
  ['arrow', /arrow|normal|default|pointer/],
];

/** A Windows pack: the .cur and .ani files directly in `dir`, and its install.inf if any. */
export async function windowsTheme(
  tree: Tree,
  dir: string,
  budget: Budget,
  decoder: Decoder,
  fallbackName: string,
): Promise<ConvertedTheme | null> {
  const cursors = new Map<string, string>();
  let inf: Uint8Array | null = null;
  for (const [lower, key] of listDir(tree, dir)) {
    if (/\.(cur|ani)$/.test(lower)) cursors.set(lower, key);
    else if (lower.endsWith('.inf')) inf ??= resolve(tree, key)?.data ?? null;
  }
  if (cursors.size === 0) return null;

  const fileFor = new Map<string, string>();
  let name: string | null = null;
  if (inf) {
    const parsed = parseInf(text(inf, 'latin1'));
    name = parsed.name;
    for (const [role, file] of parsed.files) {
      const key = cursors.get(file.toLowerCase());
      if (key) fileFor.set(role, key);
    }
  }
  if (!fileFor.has('arrow')) {
    const unclaimed = new Set(cursors.keys());
    for (const [role, pattern] of NAME_GUESSES) {
      if (fileFor.has(role)) continue;
      const match = [...unclaimed].find((file) => pattern.test(file.replace(/\.(cur|ani)$/, '')));
      if (!match) continue;
      unclaimed.delete(match);
      fileFor.set(role, cursors.get(match) as string);
    }
  }
  // A single cursor on its own is the pointer.
  if (cursors.size === 1 && fileFor.size === 0) fileFor.set('arrow', [...cursors.values()][0]);

  const specs = [];
  for (const role of WINDOWS_ROLES) {
    const key = fileFor.get(role.windows.toLowerCase());
    const file = key ? resolve(tree, key) : null;
    if (!key || !file) continue;
    const frames = key.toLowerCase().endsWith('.ani')
      ? await aniFrames(file.data, budget, decoder)
      : await curFrames(file.data, budget, decoder);
    specs.push({ name: role.name, aliases: role.aliases, frames });
  }
  return themeFrom(name || (dir ? baseOf(dir) : fallbackName), specs);
}

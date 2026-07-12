/**
 * Custom cursor theme parsing.
 *
 * First-pass support targets the `.CurXPTheme` format (as produced by
 * CursorXP / CursorFX-lite tools). A `.CurXPTheme` file is a plain ZIP
 * archive containing:
 *
 *   - `Scheme.ini`   — an INI describing each cursor role (frame count,
 *                      animation interval, hot-spot coordinates).
 *   - `<Role>.png`   — one PNG per cursor role. Animated cursors are stored
 *                      as a *horizontal sprite strip* of `Frames` equal-width
 *                      frames; static cursors are a single frame.
 *
 * We decode the archive entirely in the browser (no dependencies): ZIP local
 * headers are parsed by hand and DEFLATE payloads are inflated with the
 * native `DecompressionStream('deflate-raw')`. Every frame of each cursor is
 * cropped onto a canvas and exported as a PNG data URL. Because CSS `cursor:`
 * cannot animate, these frames are cycled at runtime by a JS-driven cursor
 * overlay (see CursorThemeApplier) rather than emitted as CSS.
 *
 * The format is intentionally abstracted behind {@link CursorTheme} so other
 * formats (`.ani`, `.cur`, CursorFX `.CursorFX`, …) can be added later by
 * producing the same shape.
 */

/** Largest cursor frame dimension we keep (keeps data URLs / overlay sane). */
const MAX_CURSOR_SIZE = 128;
/** Fallback frame interval (ms) when a theme omits one. */
const DEFAULT_INTERVAL_MS = 60;

/**
 * Maps `.CurXPTheme` cursor role names (the `Scheme.ini` section names) to CSS
 * `cursor` keywords. Roles with no sensible CSS equivalent are omitted.
 */
const CURXP_ROLE_TO_CSS: Record<string, CssCursorKeyword[]> = {
  Arrow: ['default'],
  Help: ['help'],
  AppStarting: ['progress'],
  Wait: ['wait'],
  Cross: ['crosshair'],
  IBeam: ['text'],
  NO: ['not-allowed'],
  SizeNS: ['ns-resize', 'n-resize', 's-resize', 'row-resize'],
  SizeWE: ['ew-resize', 'e-resize', 'w-resize', 'col-resize'],
  SizeNWSE: ['nwse-resize', 'nw-resize', 'se-resize'],
  SizeNESW: ['nesw-resize', 'ne-resize', 'sw-resize'],
  SizeAll: ['move', 'all-scroll'],
  Hand: ['pointer', 'grab', 'grabbing'],
  // Roles without a clean CSS mapping (Handwriting, UpArrow) are ignored.
};

/**
 * CSS cursor keywords we can override. This is the closed set of `cursor:`
 * values the overlay recognises.
 */
export type CssCursorKeyword =
  | 'default'
  | 'pointer'
  | 'text'
  | 'wait'
  | 'progress'
  | 'help'
  | 'crosshair'
  | 'not-allowed'
  | 'move'
  | 'all-scroll'
  | 'grab'
  | 'grabbing'
  | 'n-resize'
  | 's-resize'
  | 'e-resize'
  | 'w-resize'
  | 'ns-resize'
  | 'ew-resize'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'nw-resize'
  | 'se-resize'
  | 'ne-resize'
  | 'sw-resize'
  | 'row-resize'
  | 'col-resize';

/** A single resolved cursor, possibly animated across multiple frames. */
export interface CursorImage {
  /** PNG data URLs, one per animation frame (length ≥ 1). */
  frames: string[];
  /** Delay between frames in milliseconds. */
  intervalMs: number;
  /** Rendered frame width in CSS pixels. */
  width: number;
  /** Rendered frame height in CSS pixels. */
  height: number;
  /** Hot-spot X in rendered-frame pixels. */
  hotX: number;
  /** Hot-spot Y in rendered-frame pixels. */
  hotY: number;
}

/** A parsed, source-format-agnostic cursor theme. */
export interface CursorTheme {
  /** Human-readable theme name (best effort). */
  name: string;
  /** Source format identifier, e.g. `"curxptheme"`. */
  format: 'curxptheme';
  /**
   * Resolved cursors keyed by CSS cursor keyword. Multiple keywords may share
   * the same cursor (e.g. all resize variants).
   */
  cursors: Partial<Record<CssCursorKeyword, CursorImage>>;
}

// ---------------------------------------------------------------------------
// ZIP reading (store + deflate) using the native DecompressionStream.
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Inflate a raw DEFLATE payload using the browser's DecompressionStream. */
async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress cursor themes (no DecompressionStream).');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Minimal ZIP reader. Walks the local file header records at the start of the
 * archive (sufficient for the flat `.CurXPTheme` layout) and returns each
 * entry's raw bytes, inflating DEFLATE-compressed entries.
 */
async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  let offset = 0;

  const LOCAL_FILE_HEADER = 0x04034b50;

  while (offset + 4 <= bytes.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== LOCAL_FILE_HEADER) break; // reached central directory / end

    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed; // stored
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for "${name}".`);
    }

    // Only record real files (skip directory entries) and normalize slashes.
    if (!name.endsWith('/')) {
      entries.push({ name: name.replace(/\\/g, '/'), data });
    }

    offset = dataStart + compressedSize;

    // A data descriptor (bit 3 of general-purpose flags) would make sizes
    // unavailable in the header. `.CurXPTheme` files written by CursorXP do
    // not use it; guard against an infinite loop just in case.
    if (compressedSize === 0 && uncompressedSize === 0 && method !== 0) {
      throw new Error('Cursor theme uses streamed ZIP entries, which are unsupported.');
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// INI parsing
// ---------------------------------------------------------------------------

type IniData = Record<string, Record<string, string>>;

/** Parse a simple INI (case-sensitive section names, `key=value` lines). */
function parseIni(text: string): IniData {
  const result: IniData = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      result[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (result[section] ??= {})[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// PNG sprite frame extraction (browser canvas)
// ---------------------------------------------------------------------------

/** Decode PNG bytes into an ImageBitmap. */
async function decodePng(data: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([data as BlobPart], { type: 'image/png' });
  return createImageBitmap(blob);
}

/**
 * Slice a horizontal sprite strip into `frames` PNG data URLs. `frames` is the
 * total number of animation frames stored side by side; each is scaled down to
 * the cursor cap (preserving aspect + hot-spot).
 */
function extractFrames(
  bitmap: ImageBitmap,
  frames: number,
  intervalMs: number,
  hotX: number,
  hotY: number,
): CursorImage | null {
  const frameCount = Math.max(1, frames);
  const frameWidth = Math.max(1, Math.floor(bitmap.width / frameCount));
  const frameHeight = bitmap.height;

  // Scale down to the cursor cap while preserving the hot-spot.
  const scale = Math.min(1, MAX_CURSOR_SIZE / Math.max(frameWidth, frameHeight));
  const outW = Math.max(1, Math.round(frameWidth * scale));
  const outH = Math.max(1, Math.round(frameHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const dataUrls: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    ctx.clearRect(0, 0, outW, outH);
    // Source rect for frame i; clamp the last frame to the bitmap bounds.
    const sx = Math.min(i * frameWidth, Math.max(0, bitmap.width - frameWidth));
    ctx.drawImage(bitmap, sx, 0, frameWidth, frameHeight, 0, 0, outW, outH);
    dataUrls.push(canvas.toDataURL('image/png'));
  }

  return {
    frames: dataUrls,
    intervalMs: intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS,
    width: outW,
    height: outH,
    hotX: Math.round(Math.min(hotX, frameWidth - 1) * scale),
    hotY: Math.round(Math.min(hotY, frameHeight - 1) * scale),
  };
}

function toInt(value: string | undefined, fallback = 0): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse `.CurXPTheme` bytes into a {@link CursorTheme}.
 *
 * @param bytes    the raw archive contents
 * @param fileName used only to derive a fallback theme name
 * @throws if the bytes are not a readable `.CurXPTheme` archive.
 */
export async function parseCurXPTheme(
  bytes: Uint8Array,
  fileName = 'Custom cursor',
): Promise<CursorTheme> {
  const entries = await readZip(bytes);
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));

  const schemeEntry = byName.get('scheme.ini');
  if (!schemeEntry) {
    throw new Error('Not a valid .CurXPTheme file (missing Scheme.ini).');
  }

  const ini = parseIni(new TextDecoder().decode(schemeEntry.data));

  const cursors: CursorTheme['cursors'] = {};

  for (const [role, cssKeywords] of Object.entries(CURXP_ROLE_TO_CSS)) {
    const section = ini[role];
    if (!section) continue;

    const pngEntry = byName.get(`${role.toLowerCase()}.png`);
    if (!pngEntry) continue;

    const frames = toInt(section['Frames'], 1);
    const interval = toInt(section['Interval'], DEFAULT_INTERVAL_MS);
    const hotX = toInt(section['Hot spot x'], 0);
    const hotY = toInt(section['Hot spot y'], 0);

    let bitmap: ImageBitmap;
    try {
      bitmap = await decodePng(pngEntry.data);
    } catch {
      continue; // skip unreadable images rather than failing the whole theme
    }

    const image = extractFrames(bitmap, frames, interval, hotX, hotY);
    bitmap.close();
    if (!image) continue;

    for (const keyword of cssKeywords) {
      cursors[keyword] = image;
    }
  }

  if (Object.keys(cursors).length === 0) {
    throw new Error('No usable cursors were found in this theme.');
  }

  const name =
    ini['Description']?.['Created by']?.trim() ||
    fileName.replace(/\.CurXPTheme$/i, '') ||
    'Custom cursor';

  return { name, format: 'curxptheme', cursors };
}

/** Total number of animation frames across all cursors in a theme. */
export function cursorThemeFrameCount(theme: CursorTheme): number {
  return Object.values(theme.cursors).reduce(
    (sum, cursor) => sum + (cursor?.frames.length ?? 0),
    0,
  );
}

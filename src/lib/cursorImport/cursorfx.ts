/**
 * CursorFX (.CursorFX), Stardock's successor to CursorXP.
 *
 * A small header (version, header size, the size of what follows once
 * inflated, ...; the info size is the header's last word), then one zlib
 * stream holding the theme's info (UTF-16 strings) and its records. Each
 * pointer record has a header (which of 20 cursors it is, normal or
 * pressed, frame count, image size, interval, animation type, hotspot), an
 * optional frame script (UTF-16), and its frames side by side as straight
 * BGRA, bottom row first. Pressed images have no XCursor equivalent and are
 * skipped.
 *
 * Effects (type 4) and trails (type 8) aren't cursors: they become an
 * effect package (`ConvertedEffects`) that Din's cursor effects play. Their
 * records are laid out like a pointer's, without the pointer's index and
 * status, and stand alone in "effects packages" and "trails packages" or
 * come with a theme's cursors. After the common type, header size and record
 * size, the words are:
 *
 *   effect: unknown (2), event, frame count, strip width, height, interval,
 *           animation, unknown, hot spot x, y, header + script size, image
 *           size, header size, script size
 *   trail:  unknown (3), mode, frame count, strip width, height, interval,
 *           animation, unknown, hot spot x, y, header + script size, image
 *           size, header size, script size, trails per second, 8 unused
 *
 * An effect's event is an index into CursorFX's list: left, middle and right
 * button, each down, up and double-click (0 is left down). A trail's mode
 * is 0 for always, 1 while a button is down, 2 while none is. Both play
 * their frames once, wherever the hot spot lands, then go. Worked out from
 * the packages CursorFX 4 ships (Blue pings, Smoke trail, Gyroscopic, ...).
 *
 * The pointer layout follows the description published with cfx2xc
 * (github.com/coolwanglu/cfx2xc, CursorFXFileFormat.md).
 */

import { Budget, DAMAGED, ImportError, LIMITS, TOO_BIG, clamp, inflate, slice, text, u32le } from './bytes';
import { type Bitmap, contentBox, crop, makeFrame, premultiplyBgra, splitStrip } from './image';
import { type ConvertedEffects, type EffectSprite, type TrailMode, EFFECT_EVENTS } from './effects';
import { type ConvertedTheme, type CursorSpec, HOLD_MS, themeFrom } from './theme';

const POINTER = 2;
const EFFECT = 4;
const TRAIL = 8;
const NORMAL = 1;
const RECORD_HEADER = 12 + 16 * 4;
const EFFECT_HEADER = 12 + 14 * 4;
const TRAIL_HEADER = 12 + 15 * 4;
const TRAIL_MODES: TrailMode[] = ['always', 'down', 'up'];

/** CursorFX's 20 cursors, by index. */
const SLOTS: { name: string; aliases: string[] }[] = [
  { name: 'left_ptr', aliases: ['default', 'arrow', 'top_left_arrow', 'left_arrow'] },
  { name: 'help', aliases: ['question_arrow', 'whats_this', 'left_ptr_help'] },
  { name: 'progress', aliases: ['left_ptr_watch', 'half-busy'] },
  { name: 'wait', aliases: ['watch'] },
  { name: 'crosshair', aliases: ['cross', 'tcross', 'cross_reverse', 'diamond_cross'] },
  { name: 'text', aliases: ['xterm', 'ibeam'] },
  { name: 'pencil', aliases: [] },
  { name: 'not-allowed', aliases: ['crossed_circle', 'forbidden', 'circle', 'no-drop', 'dnd-no-drop'] },
  {
    name: 'n-resize',
    aliases: ['top_side', 'ns-resize', 'size_ver', 'sb_v_double_arrow', 'v_double_arrow', 'double_arrow', 'row-resize', 'split_v'],
  },
  { name: 's-resize', aliases: ['bottom_side'] },
  {
    name: 'w-resize',
    aliases: ['left_side', 'ew-resize', 'size_hor', 'sb_h_double_arrow', 'h_double_arrow', 'col-resize', 'split_h'],
  },
  { name: 'e-resize', aliases: ['right_side'] },
  { name: 'nw-resize', aliases: ['top_left_corner', 'nwse-resize', 'size_fdiag', 'bd_double_arrow'] },
  { name: 'se-resize', aliases: ['bottom_right_corner'] },
  { name: 'ne-resize', aliases: ['top_right_corner', 'nesw-resize', 'size_bdiag', 'fd_double_arrow'] },
  { name: 'sw-resize', aliases: ['bottom_left_corner'] },
  { name: 'move', aliases: ['fleur', 'size_all', 'all-scroll'] },
  { name: 'up_arrow', aliases: ['center_ptr', 'sb_up_arrow'] },
  { name: 'pointer', aliases: ['hand2', 'hand1', 'hand', 'pointing_hand'] },
  { name: 'copy', aliases: ['dnd-copy'] },
];

export function isCursorFX(data: Uint8Array): boolean {
  if (data.length < 24) return false;
  const headerSize = u32le(data, 4);
  return headerSize >= 20 && headerSize <= 4096 && data[headerSize] === 0x78;
}

/**
 * The play order and delays of a frame script, or null if it can't be read.
 * Lines are `first[-last][,interval]` (frames counted from 1), and
 * `repeat N` … `end repeat` around some of them.
 */
export function runScript(script: string, frameCount: number, interval: number): { index: number; delay: number }[] | null {
  const lines = script
    .split(/[;\r\n]+/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const steps: { index: number; delay: number }[] = [];
  let last = interval;
  let position = 0;
  const run = (depth: number): boolean => {
    if (depth > LIMITS.depth) return false;
    while (position < lines.length) {
      const line = lines[position++];
      const repeat = /^repeat\s+(\d+)$/.exec(line);
      if (repeat) {
        const start = position;
        const times = Math.min(Number(repeat[1]), LIMITS.framesPerCursor);
        let end = start;
        for (let i = 0; i < Math.max(1, times); i++) {
          position = start;
          if (!run(depth + 1)) return false;
          end = position;
          if (steps.length >= LIMITS.framesPerCursor) break;
        }
        position = end;
        continue;
      }
      if (line === 'end repeat' || line === 'endrepeat') return depth > 0;
      const match = /^(\d+)(?:\s*-\s*(\d+))?(?:\s*,\s*(\d+))?$/.exec(line);
      if (!match) return false;
      const first = Number(match[1]);
      const lastFrame = match[2] === undefined ? first : Number(match[2]);
      if (match[3] !== undefined) last = Number(match[3]);
      if (first < 1 || lastFrame < 1 || first > frameCount || lastFrame > frameCount) return false;
      const step = lastFrame >= first ? 1 : -1;
      for (let i = first; ; i += step) {
        if (steps.length >= LIMITS.framesPerCursor) return true;
        steps.push({ index: i - 1, delay: last });
        if (i === lastFrame) break;
      }
    }
    return depth === 0;
  };
  return run(0) && steps.length ? steps : null;
}

/** The default play order for an animation type: 0 plays once, 2 loops, 3 goes back and forth. */
function defaultOrder(frameCount: number, interval: number, type: number): { index: number; delay: number }[] {
  const steps = Array.from({ length: frameCount }, (_, index) => ({ index, delay: interval }));
  if (type === 3) steps.push(...steps.slice(1, -1).reverse().map((s) => ({ ...s })));
  else if (type === 0) steps[steps.length - 1] = { ...steps[steps.length - 1], delay: HOLD_MS };
  return steps.slice(0, LIMITS.framesPerCursor);
}

/** An effect's or a trail's frames, straight RGBA, and the order they play in once. */
function readSprite(record: Uint8Array, field: (i: number) => number, budget: Budget): EffectSprite | null {
  const frameCount = field(2);
  const stripWidth = field(3);
  const height = field(4);
  const interval = field(5);
  const animation = field(6);
  const hotX = field(8);
  const hotY = field(9);
  const headerAndScript = field(10);
  const imageSize = field(11);
  const recordHeader = field(12);
  const scriptSize = field(13);
  if (frameCount < 1 || frameCount > LIMITS.framesPerCursor || recordHeader + scriptSize !== headerAndScript) {
    throw new ImportError(DAMAGED);
  }
  budget.image(stripWidth, height);
  if (imageSize !== stripWidth * height * 4 || headerAndScript + imageSize > record.length || stripWidth % frameCount) {
    throw new ImportError(DAMAGED);
  }
  const width = stripWidth / frameCount;
  // Bigger than Din draws a frame: left out, not the whole import.
  if (width > LIMITS.frameDimension || height > LIMITS.frameDimension) return null;
  budget.frame(imageSize);

  // Bottom row first, BGRA: turned the right way up, as RGBA.
  const raw = slice(record, headerAndScript, imageSize);
  const pixels = new Uint8Array(imageSize);
  const row = stripWidth * 4;
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row;
    const to = y * row;
    for (let x = 0; x < row; x += 4) {
      pixels[to + x] = raw[from + x + 2];
      pixels[to + x + 1] = raw[from + x + 1];
      pixels[to + x + 2] = raw[from + x];
      pixels[to + x + 3] = raw[from + x + 3];
    }
  }

  const script = scriptSize ? text(slice(record, recordHeader, scriptSize - (scriptSize % 2)), 'utf-16le').replace(/\0/g, '') : '';
  const delay = Math.min(HOLD_MS, Math.max(1, interval));
  let steps = script ? runScript(script, frameCount, interval) : null;
  if (!steps) {
    steps = Array.from({ length: frameCount }, (_, index) => ({ index, delay }));
    if (animation === 3) steps.push(...steps.slice(0, -1).reverse().map((s) => ({ ...s })));
  }
  return {
    width,
    height,
    hotX: clamp(hotX, 0, width - 1),
    hotY: clamp(hotY, 0, height - 1),
    frameCount,
    pixels,
    steps: steps.slice(0, LIMITS.framesPerCursor).map((s) => ({ index: s.index, delay: Math.min(HOLD_MS, Math.max(1, s.delay)) })),
  };
}

/** A .CursorFX file's theme, if it has cursors, and its effect package, if it has effects or a trail. */
export async function readCursorFX(
  data: Uint8Array,
  budget: Budget,
  fallbackName: string,
): Promise<{ theme: ConvertedTheme | null; effects: ConvertedEffects | null }> {
  const headerSize = u32le(data, 4);
  const dataSize = u32le(data, 8);
  if (headerSize < 20 || headerSize > 4096) throw new ImportError(DAMAGED);
  const infoSize = u32le(data, headerSize - 4);
  // The header says how big the stream inflates to: it must fit the budget,
  // and the stream must stop there.
  if (dataSize > LIMITS.expandedBytes) throw new ImportError(TOO_BIG);
  budget.expanded(dataSize);
  const body = await inflate(data.subarray(headerSize), 'deflate', dataSize);
  if (body.length !== dataSize || infoSize > body.length) throw new ImportError(DAMAGED);

  const info = text(body.subarray(0, infoSize - (infoSize % 2)), 'utf-16le').split('\0');
  const name = info[0]?.trim() || fallbackName;

  const specs: CursorSpec[] = [];
  const effects: ConvertedEffects = { name, effects: [], trail: null };
  let p = infoSize;
  while (p < body.length) {
    const type = u32le(body, p);
    const recordSize = u32le(body, p + 8);
    if (recordSize < 12 || p + recordSize > body.length) throw new ImportError(DAMAGED);
    const record = body.subarray(p, p + recordSize);
    p += recordSize;
    const field = (i: number) => u32le(record, 12 + i * 4);

    if (type === EFFECT && recordSize >= EFFECT_HEADER) {
      const event = field(1);
      if (event >= EFFECT_EVENTS.length || effects.effects.some((e) => e.event === event)) continue;
      const sprite = readSprite(record, field, budget);
      if (sprite) effects.effects.push({ ...sprite, event });
      continue;
    }
    if (type === TRAIL && recordSize >= TRAIL_HEADER) {
      const mode = TRAIL_MODES[field(1)];
      if (!mode || effects.trail) continue;
      const sprite = readSprite(record, field, budget);
      if (sprite) effects.trail = { ...sprite, mode, rate: clamp(field(14), 1, 100) };
      continue;
    }
    if (type !== POINTER || recordSize < RECORD_HEADER) continue;

    const index = field(1);
    const status = field(2);
    const frameCount = field(4);
    const width = field(5);
    const height = field(6);
    const interval = field(7);
    const animation = field(8);
    const hotX = field(10);
    const hotY = field(11);
    const headerAndScript = field(12);
    const imageSize = field(13);
    const recordHeader = field(14);
    const scriptSize = field(15);
    if (status !== NORMAL || !SLOTS[index] || specs.some((s) => s.name === SLOTS[index].name)) continue;
    if (frameCount < 1 || frameCount > LIMITS.framesPerCursor || recordHeader + scriptSize !== headerAndScript) {
      throw new ImportError(DAMAGED);
    }
    budget.image(width, height);
    if (imageSize !== width * height * 4 || headerAndScript + imageSize > recordSize) throw new ImportError(DAMAGED);

    // Bottom row first, straight alpha: turned the right way up and premultiplied.
    const raw = slice(record, headerAndScript, imageSize);
    const pixels = new Uint8Array(imageSize);
    for (let y = 0; y < height; y++) pixels.set(raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    const strip: Bitmap = { width, height, pixels: premultiplyBgra(pixels) };
    const frames = splitStrip(strip, frameCount, true);
    const hx = clamp(hotX, 0, frames[0].width - 1);
    const hy = clamp(hotY, 0, frames[0].height - 1);

    // CursorFX frames have wide transparent margins; cut them away.
    const box = contentBox(frames, hx, hy);
    const trimmed = frames.map((f) => crop(f, box.x, box.y, box.width, box.height));
    const size = Math.max(box.width, box.height);
    const made = trimmed.map((f) => makeFrame(budget, f, { size, hotX: hx - box.x, hotY: hy - box.y, delay: 0 }));

    const script = scriptSize ? text(slice(record, recordHeader, scriptSize - (scriptSize % 2)), 'utf-16le').replace(/\0/g, '') : '';
    const steps =
      frameCount === 1
        ? [{ index: 0, delay: 0 }]
        : ((script && runScript(script, frameCount, interval)) || defaultOrder(frameCount, interval, animation));
    specs.push({
      ...SLOTS[index],
      frames: steps.map(({ index: i, delay }) => ({
        ...made[i],
        delay: frameCount === 1 ? 0 : Math.min(HOLD_MS, Math.max(1, delay)),
      })),
    });
  }
  return {
    theme: specs.length ? themeFrom(name, specs) : null,
    effects: effects.effects.length || effects.trail ? effects : null,
  };
}

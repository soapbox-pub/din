/**
 * CursorFX (.CursorFX), Stardock's successor to CursorXP.
 *
 * A small header (version, header size, the size of what follows once
 * inflated, ...; the info size is the header's last word), then one zlib
 * stream holding the theme's info (UTF-16 strings) and its records. Each
 * pointer record has a header (which of 20 cursors it is, normal or
 * pressed, frame count, image size, interval, animation type, hotspot), an
 * optional frame script (UTF-16), and its frames side by side as straight
 * BGRA, bottom row first. Pressed images, trails and effects have no XCursor
 * equivalent and are skipped.
 *
 * The layout follows the description published with cfx2xc
 * (github.com/coolwanglu/cfx2xc, CursorFXFileFormat.md).
 */

import { Budget, DAMAGED, ImportError, LIMITS, TOO_BIG, clamp, inflate, slice, text, u32le } from './bytes';
import { type Bitmap, contentBox, crop, makeFrame, premultiplyBgra, splitStrip } from './image';
import { type ConvertedTheme, type CursorSpec, HOLD_MS, themeFrom } from './theme';

const POINTER = 2;
const NORMAL = 1;
const RECORD_HEADER = 12 + 16 * 4;

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

export async function cursorFXTheme(data: Uint8Array, budget: Budget, fallbackName: string): Promise<ConvertedTheme | null> {
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
  let p = infoSize;
  while (p < body.length) {
    const type = u32le(body, p);
    const recordSize = u32le(body, p + 8);
    if (recordSize < 12 || p + recordSize > body.length) throw new ImportError(DAMAGED);
    const record = body.subarray(p, p + recordSize);
    p += recordSize;
    if (type !== POINTER || recordSize < RECORD_HEADER) continue;

    const field = (i: number) => u32le(record, 12 + i * 4);
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
  return themeFrom(name, specs);
}

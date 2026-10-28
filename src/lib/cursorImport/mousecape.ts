/**
 * Mousecape (.cape), macOS: an XML plist of cursors by macOS identifier,
 * each with its frame count and duration, hotspot and size in points, and
 * representations of it at one or more scales (PNG, or TIFF in older capes),
 * frames stacked top to bottom. Each cursor is made at the sizes Settings
 * offers, from the representation nearest each.
 */

import { Budget, DAMAGED, ImportError, LIMITS, clamp, text } from './bytes';
import { type Bitmap, type Decoder, type Frame, crop, decodePng, isPng, makeFrame, scale } from './image';
import { type PlistValue, parsePlist } from './plist';
import { type ConvertedTheme, type CursorSpec, STANDARD_SIZES, animate, themeFrom } from './theme';
import { decodeTiff, isTiff } from './tiff';

/**
 * XCursor names and the macOS cursors that can be them, best first. The
 * window-edge resize cursors come before the plain ones for the *-resize
 * names, which is what windows use; the plain ones for column and row.
 */
const CURSORS: { name: string; aliases: string[]; ids: string[] }[] = [
  { name: 'left_ptr', aliases: ['default', 'arrow', 'top_left_arrow', 'left_arrow'], ids: ['coregraphics.Arrow'] },
  { name: 'text', aliases: ['xterm', 'ibeam'], ids: ['coregraphics.IBeam', 'coregraphics.IBeamXOR'] },
  { name: 'vertical-text', aliases: [], ids: ['cursor.26'] },
  { name: 'pointer', aliases: ['hand2', 'hand1', 'hand', 'pointing_hand'], ids: ['cursor.13'] },
  { name: 'grab', aliases: ['openhand'], ids: ['cursor.12'] },
  { name: 'grabbing', aliases: ['closedhand', 'dnd-move'], ids: ['cursor.11'] },
  { name: 'progress', aliases: ['left_ptr_watch', 'half-busy'], ids: ['cursor.4'] },
  { name: 'wait', aliases: ['watch'], ids: ['coregraphics.Wait', 'cursor.4'] },
  { name: 'help', aliases: ['question_arrow', 'whats_this', 'left_ptr_help'], ids: ['cursor.40'] },
  { name: 'context-menu', aliases: [], ids: ['cursor.24', 'coregraphics.ArrowCtx'] },
  { name: 'alias', aliases: ['link', 'dnd-link'], ids: ['coregraphics.Alias', 'cursor.2'] },
  { name: 'copy', aliases: ['dnd-copy'], ids: ['coregraphics.Copy', 'cursor.5'] },
  { name: 'move', aliases: ['fleur', 'size_all', 'all-scroll'], ids: ['coregraphics.Move'] },
  { name: 'not-allowed', aliases: ['crossed_circle', 'forbidden', 'circle', 'no-drop', 'dnd-no-drop'], ids: ['cursor.3'] },
  { name: 'crosshair', aliases: ['cross', 'tcross', 'cross_reverse', 'diamond_cross'], ids: ['cursor.7', 'cursor.8'] },
  { name: 'cell', aliases: ['plus'], ids: ['cursor.41'] },
  { name: 'zoom-in', aliases: [], ids: ['cursor.42'] },
  { name: 'zoom-out', aliases: [], ids: ['cursor.43'] },
  { name: 'ns-resize', aliases: ['size_ver', 'sb_v_double_arrow', 'v_double_arrow', 'double_arrow'], ids: ['cursor.32', 'cursor.23'] },
  { name: 'ew-resize', aliases: ['size_hor', 'sb_h_double_arrow', 'h_double_arrow'], ids: ['cursor.28', 'cursor.19'] },
  { name: 'nwse-resize', aliases: ['size_fdiag', 'bd_double_arrow'], ids: ['cursor.34'] },
  { name: 'nesw-resize', aliases: ['size_bdiag', 'fd_double_arrow'], ids: ['cursor.30'] },
  { name: 'row-resize', aliases: ['split_v'], ids: ['cursor.23', 'cursor.32'] },
  { name: 'col-resize', aliases: ['split_h'], ids: ['cursor.19', 'cursor.28'] },
  { name: 'n-resize', aliases: ['top_side'], ids: ['cursor.31', 'cursor.21'] },
  { name: 's-resize', aliases: ['bottom_side'], ids: ['cursor.36', 'cursor.22'] },
  { name: 'e-resize', aliases: ['right_side'], ids: ['cursor.27', 'cursor.18'] },
  { name: 'w-resize', aliases: ['left_side'], ids: ['cursor.38', 'cursor.17'] },
  { name: 'nw-resize', aliases: ['top_left_corner'], ids: ['cursor.33'] },
  { name: 'ne-resize', aliases: ['top_right_corner'], ids: ['cursor.29'] },
  { name: 'se-resize', aliases: ['bottom_right_corner'], ids: ['cursor.35'] },
  { name: 'sw-resize', aliases: ['bottom_left_corner'], ids: ['cursor.37'] },
];

/** Representations per cursor that are looked at. */
const MAX_REPRESENTATIONS = 8;

type Dict = { [key: string]: PlistValue };

function isDict(value: PlistValue | undefined): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

const numberOf = (value: PlistValue | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

async function decodeRepresentation(data: Uint8Array, budget: Budget, decoder: Decoder): Promise<Bitmap> {
  if (isPng(data)) return decodePng(decoder, budget, data);
  if (isTiff(data)) return decodeTiff(data, budget);
  throw new ImportError(DAMAGED);
}

/** One cursor of a cape, made at every standard size. */
async function capeCursor(cursor: Dict, budget: Budget, decoder: Decoder): Promise<Frame[]> {
  const frameCount = clamp(Math.round(numberOf(cursor.FrameCount, 1)), 1, LIMITS.framesPerCursor);
  const duration = numberOf(cursor.FrameDuration, 0.1) * 1000;
  const pointsWide = numberOf(cursor.PointsWide, 0);
  const pointsHigh = numberOf(cursor.PointsHigh, 0);
  if (!(pointsWide > 0 && pointsHigh > 0 && pointsWide <= 512 && pointsHigh <= 512)) throw new ImportError(DAMAGED);
  const hotX = clamp(numberOf(cursor.HotSpotX, 0), 0, pointsWide);
  const hotY = clamp(numberOf(cursor.HotSpotY, 0), 0, pointsHigh);
  const representations = Array.isArray(cursor.Representations) ? cursor.Representations : [];

  // Each representation's frames, and how many pixels it has per point.
  const scales: { frames: Bitmap[]; perPoint: number }[] = [];
  for (const data of representations.slice(0, MAX_REPRESENTATIONS)) {
    if (!(data instanceof Uint8Array)) continue;
    const image = await decodeRepresentation(data, budget, decoder);
    const frameHeight = Math.floor(image.height / frameCount);
    if (frameHeight < 1) continue;
    const frames = Array.from({ length: frameCount }, (_, i) => crop(image, 0, i * frameHeight, image.width, frameHeight));
    scales.push({ frames, perPoint: image.width / pointsWide });
  }
  if (!scales.length) return [];
  scales.sort((a, b) => a.perPoint - b.perPoint);

  // macOS's own cursors sit in 32-point boxes, so XCursor size `size` is
  // `size` / 32 pixels a point, whatever this cursor's box: one drawn in a
  // bigger box keeps its proportion to the rest. Each size is made from the
  // smallest representation at least that detailed.
  const result: Frame[] = [];
  for (const size of STANDARD_SIZES) {
    const perPoint = size / 32;
    const source = scales.find((s) => s.perPoint >= perPoint - 1e-6) ?? scales[scales.length - 1];
    const factor = perPoint / source.perPoint;
    const made = source.frames.map((frame) => {
      const width = Math.max(1, Math.round(frame.width * factor));
      const height = Math.max(1, Math.round(frame.height * factor));
      budget.image(width, height);
      return makeFrame(budget, scale(frame, width, height), {
        size,
        hotX: hotX * perPoint,
        hotY: hotY * perPoint,
        delay: 0,
      });
    });
    result.push(...animate(made, duration, 'loop'));
  }
  return result;
}

export async function mousecapeTheme(data: Uint8Array, budget: Budget, decoder: Decoder, fallbackName: string): Promise<ConvertedTheme | null> {
  if (text(data.subarray(0, 8), 'latin1') === 'bplist00') {
    throw new ImportError('Binary .cape files can’t be imported yet. Export the cape from Mousecape again.');
  }
  const root = parsePlist(text(data));
  if (!isDict(root) || !isDict(root.Cursors)) throw new ImportError(DAMAGED);
  const cursors = root.Cursors;
  const byId = (id: string) => {
    const cursor = cursors[`com.apple.${id}`];
    return isDict(cursor) ? cursor : null;
  };

  const made = new Map<string, Frame[]>();
  const specs: CursorSpec[] = [];
  for (const { name, aliases, ids } of CURSORS) {
    const id = ids.find((i) => byId(i));
    if (!id) continue;
    let frames = made.get(id);
    if (!frames) {
      frames = await capeCursor(byId(id) as Dict, budget, decoder);
      made.set(id, frames);
    }
    specs.push({ name, aliases, frames });
  }
  const name = typeof root.CapeName === 'string' && root.CapeName.trim() ? root.CapeName.trim() : fallbackName;
  return themeFrom(name, specs);
}

/**
 * The converter's output, whatever it read: themes of named cursors (each
 * one's frames, at every size it has) and the other names they answer to.
 * Electron's main process checks this and writes it out as an XCursor theme
 * (electron/cursorImport.mts).
 */

import { LIMITS } from './bytes';
import type { Frame } from './image';

export interface ConvertedCursor {
  name: string;
  frames: Frame[];
}

export interface ConvertedTheme {
  name: string;
  /** Themes to take missing cursors from. */
  inherits: string[];
  cursors: ConvertedCursor[];
  /** [alias, the cursor name it stands for]. */
  links: [string, string][];
}

/** One cursor of a format, by its XCursor name and the other names it answers to. */
export interface CursorSpec {
  name: string;
  aliases: readonly string[];
  frames: Frame[];
}

/** A cursor's file name in a theme. */
export const CURSOR_NAME = /^(?!\.)[A-Za-z0-9_.+-]{1,64}$/;

/** The names an arrow goes by, in case a theme has no `left_ptr` of its own. */
const ARROW_NAMES = ['left_ptr', 'default', 'arrow', 'top_left_arrow'];

/**
 * A theme from cursors, first come first served: a name already taken (by a
 * cursor or an alias) isn't taken again. Null without an arrow.
 */
export function themeFrom(name: string, specs: CursorSpec[], inherits: string[] = []): ConvertedTheme | null {
  const cursors = new Map<string, Frame[]>();
  const links = new Map<string, string>();
  // The same frames under a second name are a link to the first.
  const owners = new Map<Frame[], string>();
  for (const spec of specs) {
    if (!spec.frames.length || !CURSOR_NAME.test(spec.name) || cursors.has(spec.name) || links.has(spec.name)) continue;
    const owner = owners.get(spec.frames);
    if (owner) {
      links.set(spec.name, owner);
      continue;
    }
    cursors.set(spec.name, spec.frames);
    owners.set(spec.frames, spec.name);
  }
  for (const spec of specs) {
    const owner = owners.get(spec.frames);
    // Only specs that got their name (as a cursor or a link to one) bring aliases.
    if (!owner || (cursors.get(spec.name) !== spec.frames && links.get(spec.name) !== owner)) continue;
    for (const alias of spec.aliases) {
      if (CURSOR_NAME.test(alias) && !cursors.has(alias) && !links.has(alias)) links.set(alias, owner);
    }
  }
  if (!cursors.has('left_ptr') && !links.has('left_ptr')) {
    const arrow = ARROW_NAMES.find((n) => cursors.has(n) || links.has(n));
    if (!arrow) return null;
    links.set('left_ptr', links.get(arrow) ?? arrow);
  }
  return {
    name,
    inherits,
    cursors: [...cursors].map(([cursorName, frames]) => ({ name: cursorName, frames })),
    links: [...links],
  };
}

/** How long a play-once animation holds its last frame: for good, in practice. */
export const HOLD_MS = 3_600_000;

/** Frame delays (and order) for an animation that loops, goes back and forth, or plays once. */
export function animate<T extends Omit<Frame, 'delay'>>(
  frames: T[],
  interval: number,
  style: 'loop' | 'alternate' | 'once',
): Frame[] {
  if (frames.length === 1) return [{ ...frames[0], delay: 0 }];
  const delay = Math.min(HOLD_MS, Math.max(1, Math.round(interval)));
  const order = frames.map((_, i) => i);
  if (style === 'alternate' && frames.length > 2) order.push(...order.slice(1, -1).reverse());
  return order.slice(0, LIMITS.framesPerCursor).map((index, i, all) => ({
    ...frames[index],
    delay: style === 'once' && i === all.length - 1 ? HOLD_MS : delay,
  }));
}

/**
 * The cursors Windows themes have, by their CursorXP and Windows registry
 * names, in the order of a Windows scheme; each one's XCursor name, and the
 * other names it answers to.
 */
export const WINDOWS_ROLES: { curxp: string; windows: string; name: string; aliases: string[] }[] = [
  { curxp: 'Arrow', windows: 'Arrow', name: 'left_ptr', aliases: ['default', 'arrow', 'top_left_arrow', 'left_arrow'] },
  { curxp: 'Help', windows: 'Help', name: 'help', aliases: ['question_arrow', 'whats_this', 'left_ptr_help'] },
  { curxp: 'AppStarting', windows: 'AppStarting', name: 'progress', aliases: ['left_ptr_watch', 'half-busy'] },
  { curxp: 'Wait', windows: 'Wait', name: 'wait', aliases: ['watch'] },
  { curxp: 'Cross', windows: 'Crosshair', name: 'crosshair', aliases: ['cross', 'tcross', 'cross_reverse', 'diamond_cross'] },
  { curxp: 'IBeam', windows: 'IBeam', name: 'text', aliases: ['xterm', 'ibeam'] },
  { curxp: 'Handwriting', windows: 'NWPen', name: 'pencil', aliases: [] },
  { curxp: 'NO', windows: 'No', name: 'not-allowed', aliases: ['crossed_circle', 'forbidden', 'circle', 'no-drop', 'dnd-no-drop'] },
  {
    curxp: 'SizeNS',
    windows: 'SizeNS',
    name: 'ns-resize',
    aliases: ['size_ver', 'sb_v_double_arrow', 'v_double_arrow', 'double_arrow', 'n-resize', 's-resize', 'top_side', 'bottom_side', 'row-resize', 'split_v'],
  },
  {
    curxp: 'SizeWE',
    windows: 'SizeWE',
    name: 'ew-resize',
    aliases: ['size_hor', 'sb_h_double_arrow', 'h_double_arrow', 'e-resize', 'w-resize', 'left_side', 'right_side', 'col-resize', 'split_h'],
  },
  {
    curxp: 'SizeNWSE',
    windows: 'SizeNWSE',
    name: 'nwse-resize',
    aliases: ['size_fdiag', 'bd_double_arrow', 'nw-resize', 'se-resize', 'top_left_corner', 'bottom_right_corner'],
  },
  {
    curxp: 'SizeNESW',
    windows: 'SizeNESW',
    name: 'nesw-resize',
    aliases: ['size_bdiag', 'fd_double_arrow', 'ne-resize', 'sw-resize', 'top_right_corner', 'bottom_left_corner'],
  },
  { curxp: 'SizeAll', windows: 'SizeAll', name: 'move', aliases: ['fleur', 'size_all', 'all-scroll'] },
  { curxp: 'UpArrow', windows: 'UpArrow', name: 'up_arrow', aliases: ['center_ptr', 'sb_up_arrow'] },
  { curxp: 'Hand', windows: 'Hand', name: 'pointer', aliases: ['hand2', 'hand1', 'hand', 'pointing_hand'] },
];

/** The sizes Settings offers; formats with scalable or many-sized art are made at these. */
export const STANDARD_SIZES = [24, 32, 40, 48, 64, 96];

/**
 * Keyboard window management, after Omarchy's Hyprland bindings
 * (default/hypr/bindings/tiling.lua): every binding is Super plus a key,
 * matched by physical key (`KeyboardEvent.code`) so Super+Shift+1 is still
 * "1" whatever Shift makes of it on the layout.
 *
 * Keys pressed in the shell (or a native app) reach DesktopHotkeys; keys
 * pressed inside a web page are claimed by the Electron host and forwarded
 * as the 'wm' shell shortcut (electron/main.mts, WM_KEY_CODES - keep the two
 * key sets in step).
 */

export type Direction = 'left' | 'right' | 'up' | 'down';

export type WmCommand =
  | { type: 'focus'; dir: Direction }
  | { type: 'swap'; dir: Direction }
  | { type: 'move-to-monitor'; dir: Direction }
  | { type: 'workspace'; n: number }
  | { type: 'move-to-workspace'; n: number; follow: boolean }
  | { type: 'workspace-step'; step: 1 | -1 }
  | { type: 'workspace-previous' }
  | { type: 'close' }
  | { type: 'toggle-float' }
  | { type: 'toggle-tiling' }
  | { type: 'fullscreen' }
  | { type: 'toggle-split' }
  | { type: 'minimize' }
  | { type: 'resize'; dx: number; dy: number }
  | { type: 'terminal' }
  | { type: 'help' }
  | { type: 'show-mouse' }
  | { type: 'clear-fire-paint' };

/** A key press with Super held, as the bindings see it. */
export interface WmKey {
  /** `KeyboardEvent.code`, e.g. 'Digit1', 'ArrowLeft', 'KeyW'. */
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** How far Super+- / Super+= resize a tile, in pixels. */
const RESIZE_STEP = 100;

/** The command a Super+key press runs, or null if it isn't bound. */
export function wmCommandFor({ code, shift, ctrl, alt }: WmKey): WmCommand | null {
  const dir = ARROWS[code];
  if (dir) {
    if (!shift && !ctrl && !alt) return { type: 'focus', dir };
    if (shift && !ctrl && !alt) return { type: 'swap', dir };
    if (shift && ctrl && !alt) return { type: 'move-to-monitor', dir };
    return null;
  }
  const digit = /^Digit(\d)$/.exec(code);
  if (digit && !ctrl) {
    const n = digit[1] === '0' ? 10 : Number(digit[1]);
    if (!shift && !alt) return { type: 'workspace', n };
    if (shift) return { type: 'move-to-workspace', n, follow: !alt };
    return null;
  }
  if (code === 'Tab' && !alt) {
    if (ctrl && !shift) return { type: 'workspace-previous' };
    if (!ctrl) return { type: 'workspace-step', step: shift ? -1 : 1 };
    return null;
  }
  if (code === 'Minus' || code === 'Equal') {
    if (ctrl || alt) return null;
    const step = code === 'Minus' ? -RESIZE_STEP : RESIZE_STEP;
    return shift ? { type: 'resize', dx: 0, dy: step } : { type: 'resize', dx: step, dy: 0 };
  }
  if (ctrl || alt) return null;
  if (shift) {
    if (code === 'KeyT') return { type: 'toggle-tiling' };
    // Compiz's Show Mouse and Fire Paint (src/lib/cursorEffects), when they're on.
    if (code === 'KeyK') return { type: 'show-mouse' };
    if (code === 'KeyC') return { type: 'clear-fire-paint' };
    return null;
  }
  switch (code) {
    case 'KeyW':
    case 'KeyQ':
      return { type: 'close' };
    case 'KeyT':
      return { type: 'toggle-float' };
    case 'KeyF':
      return { type: 'fullscreen' };
    case 'KeyJ':
      return { type: 'toggle-split' };
    case 'KeyM':
      return { type: 'minimize' };
    case 'KeyK':
      return { type: 'help' };
    case 'Enter':
      return { type: 'terminal' };
    default:
      return null;
  }
}

/** The bindings as Settings lists them: keys to press, what they do. */
export const WM_BINDING_HELP: { group: string; bindings: { keys: string[]; label: string }[] }[] = [
  {
    group: 'Tiling',
    bindings: [
      { keys: ['Super', 'Shift', 'T'], label: 'Turn tiling on or off' },
      { keys: ['Super', 'T'], label: 'Float or tile the window (turns tiling on)' },
      { keys: ['Super', 'J'], label: 'Split the other way' },
      { keys: ['Super', '−'], label: 'Make the window narrower (Shift: shorter)' },
      { keys: ['Super', '='], label: 'Make the window wider (Shift: taller)' },
    ],
  },
  {
    group: 'Windows',
    bindings: [
      { keys: ['Super', '←↑↓→'], label: 'Focus the window in that direction' },
      { keys: ['Super', 'Shift', '←↑↓→'], label: 'Swap with the window in that direction' },
      { keys: ['Super', 'Shift', 'Ctrl', '←↑↓→'], label: 'Move the window to the monitor in that direction' },
      { keys: ['Super', 'F'], label: 'Full screen' },
      { keys: ['Super', 'M'], label: 'Minimize' },
      { keys: ['Super', 'W'], label: 'Close (or Super+Q)' },
      { keys: ['Super', 'Drag'], label: 'Move a window by grabbing it anywhere' },
    ],
  },
  {
    group: 'Workspaces',
    bindings: [
      { keys: ['Super', '1 … 0'], label: 'Go to workspace 1 to 10' },
      { keys: ['Super', 'Shift', '1 … 0'], label: 'Move the window to a workspace and follow it' },
      { keys: ['Super', 'Shift', 'Alt', '1 … 0'], label: 'Move the window to a workspace, staying here' },
      { keys: ['Super', 'Tab'], label: 'Next workspace (Shift: previous)' },
      { keys: ['Super', 'Ctrl', 'Tab'], label: 'Back to the last workspace' },
    ],
  },
  {
    group: 'Desktop',
    bindings: [
      { keys: ['Super', 'Enter'], label: 'Open a terminal' },
      { keys: ['Super', 'Space'], label: 'Search apps' },
      { keys: ['Super', 'K'], label: 'Show these shortcuts' },
    ],
  },
  {
    group: 'Cursor effects (when turned on in Settings → Cursors)',
    bindings: [
      { keys: ['Super', 'Shift', 'K'], label: 'Show where the pointer is (or shake the mouse)' },
      { keys: ['Super', 'Shift', 'Drag'], label: 'Paint with fire' },
      { keys: ['Super', 'Shift', 'C'], label: 'Put out the fire' },
      { keys: ['Super', 'Ctrl', 'Move'], label: 'Stir the water' },
    ],
  },
];

/**
 * Keyboard window management, after Omarchy's Hyprland bindings
 * (default/hypr/bindings/tiling.lua): every binding is Super plus a key,
 * matched by physical key (`KeyboardEvent.code`) so Super+Shift+1 is still
 * "1" whatever Shift makes of it on the layout.
 *
 * WM_GROUPS has every action with the keys it comes with. Settings →
 * Windows and `din shortcuts` save overrides by action ID.
 *
 * A shortcut is written as its modifiers besides Super, then the key's
 * code: 'KeyT', 'Shift+KeyT', 'Shift+Ctrl+Alt+ArrowLeft'.
 *
 * Keys pressed in the shell (or a native app) reach DesktopHotkeys; keys
 * pressed inside a web page are claimed by the Electron host and forwarded
 * as the 'wm' shell shortcut (electron/main.mts).
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
  | { type: 'apps-menu' }
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

/** Something a shortcut does. */
export interface WmAction {
  /** What `din shortcuts` and AppConfig's `wmBindings` call it. */
  id: string;
  label: string;
  /** The shortcuts it comes with. */
  keys: string[];
  command: WmCommand;
}

/** Actions that differ only in a direction or a number, listed as one until opened. */
interface WmFamily {
  label: string;
  /** How its keys read while they're all as they came: ['Super', 'Shift', '←↑↓→']. */
  keys: string[];
  actions: WmAction[];
}

interface WmGroup {
  group: string;
  rows: (WmAction | WmFamily)[];
}

/** The keys of the actions that aren't as they came, by action id (none: no shortcut). */
export type WmOverrides = Record<string, string[]>;

/** How far Super+- / Super+= resize a tile, in pixels. */
const RESIZE_STEP = 100;

const DIRECTIONS: { dir: Direction; code: string; where: string }[] = [
  { dir: 'left', code: 'ArrowLeft', where: 'to the left' },
  { dir: 'right', code: 'ArrowRight', where: 'to the right' },
  { dir: 'up', code: 'ArrowUp', where: 'above' },
  { dir: 'down', code: 'ArrowDown', where: 'below' },
];

const WORKSPACES = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, code: `Digit${(i + 1) % 10}` }));

export const WM_GROUPS: WmGroup[] = [
  {
    group: 'Tiling',
    rows: [
      { id: 'toggle-tiling', label: 'Turn tiling on or off', keys: ['Shift+KeyT'], command: { type: 'toggle-tiling' } },
      { id: 'toggle-float', label: 'Float or tile the window (turns tiling on)', keys: ['KeyT'], command: { type: 'toggle-float' } },
      { id: 'toggle-split', label: 'Split the other way', keys: ['KeyJ'], command: { type: 'toggle-split' } },
      { id: 'narrower', label: 'Make the window narrower', keys: ['Minus'], command: { type: 'resize', dx: -RESIZE_STEP, dy: 0 } },
      { id: 'wider', label: 'Make the window wider', keys: ['Equal'], command: { type: 'resize', dx: RESIZE_STEP, dy: 0 } },
      { id: 'shorter', label: 'Make the window shorter', keys: ['Shift+Minus'], command: { type: 'resize', dx: 0, dy: -RESIZE_STEP } },
      { id: 'taller', label: 'Make the window taller', keys: ['Shift+Equal'], command: { type: 'resize', dx: 0, dy: RESIZE_STEP } },
    ],
  },
  {
    group: 'Windows',
    rows: [
      {
        label: 'Focus the window in that direction',
        keys: ['Super', '←↑↓→'],
        actions: DIRECTIONS.map(({ dir, code, where }) => ({
          id: `focus-${dir}`, label: `Focus the window ${where}`, keys: [code], command: { type: 'focus', dir },
        })),
      },
      {
        label: 'Swap with the window in that direction',
        keys: ['Super', 'Shift', '←↑↓→'],
        actions: DIRECTIONS.map(({ dir, code, where }) => ({
          id: `swap-${dir}`, label: `Swap with the window ${where}`, keys: [`Shift+${code}`], command: { type: 'swap', dir },
        })),
      },
      {
        label: 'Move the window to the monitor in that direction',
        keys: ['Super', 'Shift', 'Ctrl', '←↑↓→'],
        actions: DIRECTIONS.map(({ dir, code, where }) => ({
          id: `move-to-monitor-${dir}`, label: `Move the window to the monitor ${where}`, keys: [`Shift+Ctrl+${code}`], command: { type: 'move-to-monitor', dir },
        })),
      },
      { id: 'fullscreen', label: 'Full screen', keys: ['KeyF'], command: { type: 'fullscreen' } },
      { id: 'minimize', label: 'Minimize', keys: ['KeyM'], command: { type: 'minimize' } },
      { id: 'close', label: 'Close', keys: ['KeyW', 'KeyQ'], command: { type: 'close' } },
    ],
  },
  {
    group: 'Workspaces',
    rows: [
      {
        label: 'Go to workspace 1 to 10',
        keys: ['Super', '1 … 0'],
        actions: WORKSPACES.map(({ n, code }) => ({
          id: `workspace-${n}`, label: `Go to workspace ${n}`, keys: [code], command: { type: 'workspace', n },
        })),
      },
      {
        label: 'Move the window to a workspace and follow it',
        keys: ['Super', 'Shift', '1 … 0'],
        actions: WORKSPACES.map(({ n, code }) => ({
          id: `move-to-workspace-${n}`, label: `Move the window to workspace ${n} and follow it`, keys: [`Shift+${code}`], command: { type: 'move-to-workspace', n, follow: true },
        })),
      },
      {
        label: 'Move the window to a workspace, staying here',
        keys: ['Super', 'Shift', 'Alt', '1 … 0'],
        actions: WORKSPACES.map(({ n, code }) => ({
          id: `send-to-workspace-${n}`, label: `Move the window to workspace ${n}, staying here`, keys: [`Shift+Alt+${code}`], command: { type: 'move-to-workspace', n, follow: false },
        })),
      },
      { id: 'workspace-next', label: 'Next workspace', keys: ['Tab'], command: { type: 'workspace-step', step: 1 } },
      { id: 'workspace-previous', label: 'Previous workspace', keys: ['Shift+Tab'], command: { type: 'workspace-step', step: -1 } },
      { id: 'workspace-last', label: 'Back to the last workspace', keys: ['Ctrl+Tab'], command: { type: 'workspace-previous' } },
    ],
  },
  {
    group: 'Desktop',
    rows: [
      { id: 'apps-menu', label: 'Search apps', keys: ['Space'], command: { type: 'apps-menu' } },
    ],
  },
];

export function isWmFamily(row: WmAction | WmFamily): row is WmFamily {
  return 'actions' in row;
}

/** Every editable action, in the order Settings lists them. */
export const WM_ACTIONS: WmAction[] = WM_GROUPS.flatMap((g) => g.rows.flatMap((row) => (isWmFamily(row) ? row.actions : [row])));

const ACTIONS_BY_ID = new Map(WM_ACTIONS.map((a) => [a.id, a]));

export function wmAction(id: string): WmAction | undefined {
  return ACTIONS_BY_ID.get(id);
}

/** Shortcuts that aren't these actions', which can't be changed: what Settings lists below them. */
export const WM_FIXED_HELP: { group: string; bindings: { keys: string[]; label: string }[] }[] = [
  {
    group: 'Mouse',
    bindings: [
      { keys: ['Super', 'Drag'], label: 'Move a window by grabbing it anywhere' },
      { keys: ['Super', 'Shift', 'Drag'], label: 'Paint with fire (when turned on in Settings → Cursors)' },
      { keys: ['Super', 'Ctrl', 'Move'], label: 'Stir the water (when turned on in Settings → Cursors)' },
    ],
  },
  {
    group: 'Other desktop shortcuts',
    bindings: [
      { keys: ['Super', 'Enter'], label: 'Open a terminal' },
      { keys: ['Super', 'K'], label: 'Show these shortcuts' },
      { keys: ['Super', 'A'], label: 'Ask the assistant (hold it to speak)' },
      { keys: ['Super', 'H'], label: 'Dictate, or finish dictating' },
      { keys: ['Super', 'Shift', 'K'], label: 'Show where the pointer is' },
      { keys: ['Super', 'Shift', 'C'], label: 'Put out the fire' },
    ],
  },
  {
    group: 'Keyboard navigation',
    bindings: [
      { keys: ['Ctrl', 'F2'], label: 'Go to the menu bar (the taskbar’s Start button)' },
      { keys: ['Ctrl', 'F3'], label: 'Go to the Dock or the taskbar’s apps' },
      { keys: ['Ctrl', 'F8'], label: 'Go to the status icons' },
      { keys: ['Ctrl', 'F6'], label: 'Go to the next part of the desktop (Shift: previous)' },
      { keys: ['←', '→'], label: 'Move along the menu bar, Dock or taskbar' },
      { keys: ['Esc'], label: 'Back to the window' },
    ],
  },
  {
    group: 'Zoom (when turned on in Settings → Accessibility)',
    bindings: [
      { keys: ['Super', 'Alt', '8'], label: 'Zoom the screen in, or back out' },
      { keys: ['Super', 'Alt', '='], label: 'Zoom further in' },
      { keys: ['Super', 'Alt', '−'], label: 'Zoom further out' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Shortcuts, as text
// ---------------------------------------------------------------------------

const MODIFIERS = ['Shift', 'Ctrl', 'Alt'] as const;
/** The keys a shortcut can be on, by `KeyboardEvent.code`. */
const CODE = 'Key[A-Z]|Digit\\d|F\\d{1,2}|Arrow(?:Left|Right|Up|Down)|Numpad[A-Za-z0-9]+|Enter|Tab|Space|Minus|Equal|Comma|Period|Slash|Backslash|IntlBackslash|Semicolon|Quote|BracketLeft|BracketRight|Backquote|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Pause';
const KEY_CODE = new RegExp(`^(?:${CODE})$`);
const SHORTCUT = new RegExp(`^(?:Shift\\+)?(?:Ctrl\\+)?(?:Alt\\+)?(?:${CODE})$`);

/** How a key's code reads on a keycap. */
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Minus: '−', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: '\'',
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Escape: 'Esc',
};

/** What people type for a key that isn't its code: `din shortcuts bind close Super+Shift+Left`. */
const KEY_ALIASES: Record<string, string> = {
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown',
  '-': 'Minus', '−': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash',
  ';': 'Semicolon', '\'': 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote',
  return: 'Enter', esc: 'Escape', del: 'Delete', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  equals: 'Equal', bracketleft: 'BracketLeft', bracketright: 'BracketRight', intlbackslash: 'IntlBackslash',
};

/** The shortcut a key press is, or null for a modifier on its own or a key shortcuts can't be on. */
export function wmShortcutOf({ code, shift, ctrl, alt }: WmKey): string | null {
  if (!KEY_CODE.test(code)) return null;
  return `${shift ? 'Shift+' : ''}${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${code}`;
}

/** A shortcut's keycaps: 'Shift+KeyT' is ['Super', 'Shift', 'T']. */
export function wmShortcutKeys(shortcut: string): string[] {
  const parts = shortcut.split('+');
  const code = parts.pop() ?? '';
  const key = KEY_NAMES[code] ?? (/^(?:Key|Digit)(.)$/.exec(code)?.[1] ?? code);
  return ['Super', ...parts, key];
}

/** A shortcut as it's said: 'Super+Shift+T'. */
export function formatWmShortcut(shortcut: string): string {
  return wmShortcutKeys(shortcut).join('+');
}

/**
 * The shortcut someone wrote ('Super+Shift+T', 'shift+left', 'Super+KeyT'),
 * or null if it isn't one. Super goes without saying.
 */
export function parseWmShortcut(text: string): string | null {
  // A + that's the key itself would split to nothing; = is that key, unshifted.
  const tokens = text.trim().split('+').map((t) => t.trim());
  const last = tokens.pop();
  if (!last) return null;
  const held = new Set<string>();
  for (const token of tokens) {
    const t = token.toLowerCase();
    if (t === 'super' || t === 'meta' || t === 'win' || t === 'mod' || t === 'cmd') continue;
    const modifier = t === 'control' ? 'Ctrl' : MODIFIERS.find((m) => m.toLowerCase() === t);
    if (!modifier || held.has(modifier)) return null;
    held.add(modifier);
  }
  let code: string;
  const lower = last.toLowerCase();
  if (KEY_ALIASES[lower]) code = KEY_ALIASES[lower];
  else if (/^[a-z]$/.test(lower)) code = `Key${lower.toUpperCase()}`;
  else if (/^\d$/.test(last)) code = `Digit${last}`;
  else code = last.replace(/^[a-z]/, (c) => c.toUpperCase());
  return wmShortcutOf({ code, shift: held.has('Shift'), ctrl: held.has('Ctrl'), alt: held.has('Alt') });
}

const FIXED_COMMANDS = new Map<string, WmCommand>([
  ['Enter', { type: 'terminal' }],
  ['KeyK', { type: 'help' }],
  ['Shift+KeyK', { type: 'show-mouse' }],
  ['Shift+KeyC', { type: 'clear-fire-paint' }],
]);

const RESERVED = new Set(['KeyA', 'KeyH', 'Alt+Digit8', 'Alt+Equal', 'Alt+Minus']);

export function wmShortcutError(shortcut: string, id: string, overrides?: WmOverrides): string | null {
  if (!SHORTCUT.test(shortcut)) return 'That key cannot be used in a shortcut.';
  const key = formatWmShortcut(shortcut);
  if (RESERVED.has(shortcut) || FIXED_COMMANDS.has(shortcut)) return `${key} is reserved by Din.`;
  const owner = resolve(overrides).owners.get(shortcut);
  return owner && owner.id !== id ? `${key} is already used for “${owner.label}”.` : null;
}

export function wmResetError(action: WmAction, overrides?: WmOverrides): string | null {
  for (const key of action.keys) {
    const problem = wmShortcutError(key, action.id, overrides);
    if (problem) return problem;
  }
  return null;
}

// ---------------------------------------------------------------------------
// What's bound to what
// ---------------------------------------------------------------------------

const NO_OVERRIDES: WmOverrides = {};

interface Resolved {
  /** Every action's shortcuts. */
  bindings: Record<string, string[]>;
  owners: Map<string, WmAction>;
  commands: Map<string, WmCommand>;
}

const resolved = new WeakMap<WmOverrides, Resolved>();

/**
 * A shortcut does one thing. An action that was given keys keeps them (the
 * first listed, should two have been given the same); the rest keep the
 * keys they came with, less any that were given to another.
 */
function resolve(overrides: WmOverrides = NO_OVERRIDES): Resolved {
  const cached = resolved.get(overrides);
  if (cached) return cached;
  const bindings: Record<string, string[]> = {};
  const owners = new Map<string, WmAction>();
  const commands = new Map(FIXED_COMMANDS);
  const claim = (action: WmAction, keys: string[]) => {
    const mine: string[] = [];
    bindings[action.id] = mine;
    for (const key of keys) {
      if (!SHORTCUT.test(key) || RESERVED.has(key) || commands.has(key)) continue;
      owners.set(key, action);
      commands.set(key, action.command);
      mine.push(key);
    }
  };
  const changed = (action: WmAction) => Array.isArray(overrides[action.id]);
  for (const action of WM_ACTIONS) if (changed(action)) claim(action, overrides[action.id]);
  for (const action of WM_ACTIONS) if (!changed(action)) claim(action, action.keys);
  const result = { bindings, owners, commands };
  resolved.set(overrides, result);
  return result;
}

/** Every action's shortcuts, by action id. */
export function wmBindings(overrides?: WmOverrides): Readonly<Record<string, string[]>> {
  return resolve(overrides).bindings;
}

/** The command a Super+key press runs, or null if it isn't bound. */
export function wmCommandFor(key: WmKey, overrides?: WmOverrides): WmCommand | null {
  const shortcut = wmShortcutOf(key);
  return (shortcut && resolve(overrides).commands.get(shortcut)) || null;
}

/** The active chords to intercept in web pages. */
export function wmShortcuts(overrides?: WmOverrides): string[] {
  return [...resolve(overrides).commands.keys()];
}

/** Drop what says no more than the defaults do. */
function tidy(overrides: WmOverrides): WmOverrides {
  for (const [id, keys] of Object.entries(overrides)) {
    const action = wmAction(id);
    if (!action || (keys.length === action.keys.length && keys.every((k, i) => k === action.keys[i]))) delete overrides[id];
  }
  return overrides;
}

/**
 * Give an action a shortcut, in place of its defaults or previous shortcut.
 * Callers check for conflicts with wmShortcutError first.
 */
export function bindWmShortcut(overrides: WmOverrides | undefined, id: string, shortcut: string): WmOverrides {
  return tidy({ ...overrides, [id]: [shortcut] });
}

/** Leave an action with no shortcut. */
export function unbindWmAction(overrides: WmOverrides | undefined, id: string): WmOverrides {
  return tidy({ ...overrides, [id]: [] });
}

export function resetWmAction(overrides: WmOverrides | undefined, id: string): WmOverrides {
  const next: WmOverrides = { ...overrides };
  delete next[id];
  return next;
}

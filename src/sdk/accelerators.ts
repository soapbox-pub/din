/**
 * Menu accelerators ("Ctrl+S", "Ctrl+Shift+Z", "F9", "Delete") against key
 * events. Ctrl and Meta are one modifier, as Din's own shortcuts treat them.
 */

const KEY_NAMES: Record<string, string> = {
  del: 'delete',
  esc: 'escape',
  return: 'enter',
  space: ' ',
  plus: '+',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

interface Parsed {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const cache = new Map<string, Parsed>();

function parse(accelerator: string): Parsed {
  let parsed = cache.get(accelerator);
  if (parsed) return parsed;
  const parts = accelerator.split('+').map((p) => p.trim().toLowerCase());
  // "Ctrl++" splits into ['ctrl', '', '']: the key is '+'.
  const key = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
  parsed = {
    ctrl: parts.includes('ctrl') || parts.includes('cmd') || parts.includes('meta') || parts.includes('cmdorctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
    key: KEY_NAMES[key] ?? key,
  };
  cache.set(accelerator, parsed);
  return parsed;
}

/** Whether a key event is this accelerator. */
export function acceleratorMatches(accelerator: string, e: KeyboardEvent): boolean {
  const a = parse(accelerator);
  if (a.ctrl !== (e.ctrlKey || e.metaKey) || a.alt !== e.altKey) return false;
  const key = e.key.toLowerCase();
  // Shifted punctuation reports the shifted character, so Shift only has to
  // match for letters and named keys.
  if (a.key.length === 1 && !/[a-z0-9]/.test(a.key)) return key === a.key;
  return a.shift === e.shiftKey && key === a.key;
}

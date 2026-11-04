// GTK apps' look, where Din is the desktop: its light/dark mode and its
// colors, so a native app's window looks like the rest of Din.
//
// - The mode is GSettings' color-scheme, which the settings portal answers
//   (libadwaita, Qt 6, Electron and Flatpak apps). GTK 3 only knows dark as
//   a theme, so the stock themes flip between their light and dark halves:
//   Adwaita, and adw-gtk3 (libadwaita's look for GTK 3, DinOS's default,
//   os/configuration.nix). Another theme the user picked is theirs.
// - The colors are libadwaita's named colors (adw-gtk3 has the same ones),
//   in a block Din keeps at the top of ~/.config/gtk-3.0/gtk.css and
//   ~/.config/gtk-4.0/gtk.css. GTK reads those once, at start, so apps
//   opened after a change get it; the mode follows in open apps too.
// - GTK 3 on X11 (most AppImages force it) reads no GSettings: without an
//   XSETTINGS daemon its settings come from ~/.config/gtk-3.0/settings.ini,
//   which gets the same theme and mode.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './system.mts';

const SCHEMA = 'org.gnome.desktop.interface';

/** Stock themes and their light and dark halves. */
const THEME_PAIRS: [light: string, dark: string][] = [
  ['Adwaita', 'Adwaita-dark'],
  ['adw-gtk3', 'adw-gtk3-dark'],
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Din's colors as GTK gets them, each `#rrggbb` (src/lib/nativePalette.ts). */
export interface NativePalette {
  dark: boolean;
  window: string;
  windowFg: string;
  view: string;
  viewFg: string;
  headerbar: string;
  headerbarFg: string;
  sidebar: string;
  sidebarFg: string;
  card: string;
  cardFg: string;
  popover: string;
  popoverFg: string;
  accent: string;
  accentFg: string;
  destructive: string;
  destructiveFg: string;
  border: string;
}

const COLOR_KEYS = [
  'window', 'windowFg', 'view', 'viewFg', 'headerbar', 'headerbarFg', 'sidebar', 'sidebarFg',
  'card', 'cardFg', 'popover', 'popoverFg', 'accent', 'accentFg', 'destructive', 'destructiveFg', 'border',
] as const satisfies readonly (keyof NativePalette)[];

function parsePalette(value: unknown): NativePalette | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.dark !== 'boolean') return null;
  const palette: Partial<NativePalette> = { dark: record.dark };
  for (const key of COLOR_KEYS) {
    const color = record[key];
    if (typeof color !== 'string' || !HEX.test(color)) return null;
    palette[key] = color.toLowerCase();
  }
  return palette as NativePalette;
}

/** libadwaita's (and adw-gtk3's) named colors, from Din's. */
function namedColors(p: NativePalette): [name: string, color: string][] {
  return [
    ['accent_bg_color', p.accent],
    ['accent_fg_color', p.accentFg],
    ['accent_color', p.accent],
    ['destructive_bg_color', p.destructive],
    ['destructive_fg_color', p.destructiveFg],
    ['destructive_color', p.destructive],
    ['window_bg_color', p.window],
    ['window_fg_color', p.windowFg],
    ['view_bg_color', p.view],
    ['view_fg_color', p.viewFg],
    ['headerbar_bg_color', p.headerbar],
    ['headerbar_fg_color', p.headerbarFg],
    ['headerbar_backdrop_color', p.window],
    ['headerbar_border_color', p.border],
    ['sidebar_bg_color', p.sidebar],
    ['sidebar_fg_color', p.sidebarFg],
    ['sidebar_backdrop_color', p.sidebar],
    ['sidebar_border_color', p.border],
    ['card_bg_color', p.card],
    ['card_fg_color', p.cardFg],
    ['dialog_bg_color', p.window],
    ['dialog_fg_color', p.windowFg],
    ['popover_bg_color', p.popover],
    ['popover_fg_color', p.popoverFg],
  ];
}

const BLOCK_START = "/* Din's colors: Din rewrites this block when its theme changes. Add your own below it. */";
const BLOCK_END = "/* End of Din's colors */";

/**
 * The block for GTK VERSION's gtk.css. GTK 4's libadwaita (1.6 on) reads
 * its colors from CSS variables, the named colors only standing in for
 * them, so it gets both.
 */
function colorBlock(p: NativePalette, version: 3 | 4): string {
  const colors = namedColors(p);
  const lines = colors.map(([name, color]) => `@define-color ${name} ${color};`);
  if (version === 4) {
    lines.push(':root {', ...colors.map(([name, color]) => `  --${name.replaceAll('_', '-')}: ${color};`), '}');
  }
  return [BLOCK_START, ...lines, BLOCK_END].join('\n');
}

/** TEXT with Din's block replaced by BLOCK (or taken out, for null). */
export function withColorBlock(text: string, block: string | null): string {
  let rest = text;
  const start = rest.indexOf(BLOCK_START);
  const end = start === -1 ? -1 : rest.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    rest = rest.slice(0, start) + rest.slice(end + BLOCK_END.length);
  }
  rest = rest.replace(/^\n+/, '');
  if (!block) return rest;
  return rest ? `${block}\n\n${rest}` : `${block}\n`;
}

/** KEYS set in settings.ini's [Settings] group in TEXT, the rest left as it was. */
export function withSettings(text: string, keys: Record<string, string>): string {
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  let group = lines.findIndex((line) => line.trim() === '[Settings]');
  if (group === -1) {
    if (lines.length) lines.push('');
    lines.push('[Settings]');
    group = lines.length - 1;
  }
  let end = lines.findIndex((line, i) => i > group && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  const missing = new Map(Object.entries(keys));
  for (let i = group + 1; i < end; i++) {
    const key = lines[i].split('=')[0]?.trim();
    if (key && missing.has(key)) {
      lines[i] = `${key}=${missing.get(key)}`;
      missing.delete(key);
    }
  }
  // After the group's last setting, not after the blank lines that end it.
  let at = end;
  while (at > group + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, ...[...missing].map(([key, value]) => `${key}=${value}`));
  return `${lines.join('\n')}\n`;
}

/**
 * Write FILE as EDIT makes it from what's there. A link (a file kept by
 * home-manager, say) is someone else's and left alone.
 */
async function editConfigFile(file: string, edit: (text: string) => string): Promise<void> {
  let text = '';
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) return;
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = edit(text);
  if (next === text) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.din-${process.pid}`;
  await fsp.writeFile(temporary, next);
  await fsp.rename(temporary, file);
}

function configDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

async function gsettings(...args: string[]): Promise<string> {
  return (await runCommand('gsettings', args, { timeout: 3_000 })).stdout.trim();
}

function unquote(value: string): string {
  return value.replace(/^'|'$/g, '');
}

/**
 * The theme the system sets by default (on DinOS adw-gtk3, in its dconf
 * database), or null.
 */
async function defaultTheme(): Promise<string | null> {
  try {
    const value = (await runCommand('dconf', ['read', '-d', '/org/gnome/desktop/interface/gtk-theme'], { timeout: 3_000 })).stdout.trim();
    return value ? unquote(value) : null;
  } catch {
    return null;
  }
}

function onDinDesktop(): boolean {
  return process.env.DIN_DESKTOP_SESSION === '1';
}

/** One change at a time: each reads what the last one wrote. */
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>, what: string): void {
  queue = queue.then(task).catch((error: unknown) => {
    console.warn(`Could not pass ${what} on to native apps:`, error);
  });
}

let appliedScheme: 'light' | 'dark' | null = null;

/** Native apps' light/dark mode. */
export function setNativeColorScheme(scheme: 'light' | 'dark'): void {
  if (!onDinDesktop()) return;
  enqueue(async () => {
    if (scheme === appliedScheme) return;
    appliedScheme = null;
    await gsettings('set', SCHEMA, 'color-scheme', scheme === 'dark' ? 'prefer-dark' : 'default');
    let theme = unquote(await gsettings('get', SCHEMA, 'gtk-theme'));
    let pair = THEME_PAIRS.find((names) => names.includes(theme));
    // Adwaita is what Din set before DinOS had adw-gtk3, not a choice: it
    // gives way to the system's own stock theme.
    if (pair?.[0] === 'Adwaita') {
      const fallback = await defaultTheme();
      pair = THEME_PAIRS.find((names) => fallback !== null && names.includes(fallback)) ?? pair;
    }
    if (pair) {
      const want = scheme === 'dark' ? pair[1] : pair[0];
      if (theme !== want) await gsettings('set', SCHEMA, 'gtk-theme', want);
      theme = want;
    }
    await editConfigFile(path.join(configDir(), 'gtk-3.0', 'settings.ini'), (text) =>
      withSettings(text, {
        'gtk-theme-name': theme,
        'gtk-application-prefer-dark-theme': String(scheme === 'dark'),
      }),
    );
    appliedScheme = scheme;
  }, 'the color scheme');
}

let appliedPalette: string | null = null;

/** Native apps' colors, and with them their mode. */
export function setNativePalette(value: unknown): void {
  if (!onDinDesktop()) return;
  const palette = parsePalette(value);
  if (!palette) return;
  setNativeColorScheme(palette.dark ? 'dark' : 'light');
  const key = JSON.stringify(palette);
  enqueue(async () => {
    if (key === appliedPalette) return;
    appliedPalette = null;
    for (const version of [3, 4] as const) {
      await editConfigFile(path.join(configDir(), `gtk-${version}.0`, 'gtk.css'), (text) =>
        withColorBlock(text, colorBlock(palette, version)),
      );
    }
    appliedPalette = key;
  }, 'the theme colors');
}

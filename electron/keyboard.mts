// The keyboard layout native apps type with.
//
// Din forwards physical keys to native apps (src/lib/nativeDisplay.ts sends
// evdev keycodes, not characters), and the embedded display's servers turn
// them into characters with a keymap of their own. Left alone that keymap is
// US QWERTY whatever the OS is set to, so a Colemak or AZERTY typist got the
// right letters in Din's own windows (those come from the host) and the wrong
// ones in every native app. So the layout is read from wherever the OS keeps
// it, the user can override it in Settings, and native-display.mts pushes the
// result to the compositor (and through it Xwayland) and the X server.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { runCommand, watchCommand } from './system.mts';

/** XKB rules/model/layout/variant/options; empty fields take XKB's defaults. */
export interface Keymap {
  rules: string;
  model: string;
  /** Comma-separated, one entry per layout group. */
  layout: string;
  variant: string;
  options: string;
}

/** A layout the user can pick: a base layout (variant '') or one of its variants. */
interface LayoutChoice {
  layout: string;
  variant: string;
}

interface LayoutEntry extends LayoutChoice {
  /** Human-readable name, e.g. "English (Colemak)". */
  name: string;
}

const DEFAULT_KEYMAP: Keymap = { rules: '', model: '', layout: 'us', variant: '', options: '' };

/**
 * What a keymap field may contain. The values end up as setxkbmap arguments
 * and in the compositor's XKB lookup, so anything else is refused (a
 * leading dash would read as a flag).
 */
const SAFE_FIELD = /^(?!-)[A-Za-z0-9_+\-:(),.]*$/;

/** A keymap from raw fields, or null when it has no layout or a bad field. */
function toKeymap(fields: Partial<Record<keyof Keymap, string | undefined>>): Keymap | null {
  const keymap: Keymap = {
    rules: fields.rules?.trim() ?? '',
    model: fields.model?.trim() ?? '',
    layout: fields.layout?.trim() ?? '',
    variant: fields.variant?.trim() ?? '',
    options: fields.options?.trim() ?? '',
  };
  if (!keymap.layout) return null;
  return Object.values(keymap).every((value) => SAFE_FIELD.test(value)) ? keymap : null;
}

// ---------------------------------------------------------------------------
// The OS's layout
// ---------------------------------------------------------------------------

const GNOME_SCHEMA = 'org.gnome.desktop.input-sources';

function isGnome(): boolean {
  return /gnome/i.test(process.env.XDG_CURRENT_DESKTOP ?? '');
}

/** XKB_DEFAULT_*: how cage, sway and other wlroots compositors are told. */
function fromEnvironment(): Keymap | null {
  const env = process.env;
  return toKeymap({
    rules: env.XKB_DEFAULT_RULES,
    model: env.XKB_DEFAULT_MODEL,
    layout: env.XKB_DEFAULT_LAYOUT,
    variant: env.XKB_DEFAULT_VARIANT,
    options: env.XKB_DEFAULT_OPTIONS,
  });
}

async function gsettings(key: string): Promise<string | null> {
  try {
    return (await runCommand('gsettings', ['get', GNOME_SCHEMA, key], { timeout: 3_000 })).stdout;
  } catch {
    return null;
  }
}

/** GNOME's input sources, e.g. [('xkb', 'us+colemak'), ('ibus', 'mozc-jp')]. */
async function fromGnome(): Promise<Keymap | null> {
  if (!isGnome()) return null;
  const [sources, options] = await Promise.all([gsettings('sources'), gsettings('xkb-options')]);
  if (!sources) return null;
  // XKB holds at most four groups; input methods (ibus) aren't XKB layouts.
  const groups = [...sources.matchAll(/\(\s*'xkb'\s*,\s*'([^']*)'\s*\)/g)]
    .slice(0, 4)
    .map((match) => match[1].split('+'));
  if (groups.length === 0) return null;
  const variants = groups.map(([, variant]) => variant ?? '');
  return toKeymap({
    layout: groups.map(([layout]) => layout).join(','),
    variant: variants.some(Boolean) ? variants.join(',') : '',
    options: [...(options ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]).join(','),
  });
}

/** Parse the `[section]` of an INI-style file into key/value pairs. */
function iniSection(text: string, section: string): Map<string, string> {
  const values = new Map<string, string>();
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[(.*)\]$/.exec(line);
    if (header) current = header[1];
    else if (current === section && line.includes('=')) {
      const eq = line.indexOf('=');
      values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return values;
}

/** KDE Plasma's layouts, when it manages them (Use=true). */
async function fromKde(): Promise<Keymap | null> {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  let text: string;
  try {
    text = await fs.readFile(path.join(configHome, 'kxkbrc'), 'utf8');
  } catch {
    return null;
  }
  const layout = iniSection(text, 'Layout');
  if (layout.get('Use') !== 'true') return null;
  return toKeymap({
    model: layout.get('Model'),
    layout: layout.get('LayoutList'),
    variant: layout.get('VariantList'),
    options: layout.get('Options'),
  });
}

/** The host X server's live keymap, when Din runs on one. */
async function fromX(): Promise<Keymap | null> {
  if (!process.env.DISPLAY) return null;
  let stdout: string;
  try {
    ({ stdout } = await runCommand('setxkbmap', ['-query'], { timeout: 3_000 }));
  } catch {
    return null;
  }
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(stdout)?.[1];
  return toKeymap({
    rules: field('rules'),
    model: field('model'),
    layout: field('layout'),
    variant: field('variant'),
    options: field('options'),
  });
}

/** KEY=value files: /etc/default/keyboard (Debian), /etc/vconsole.conf (systemd). */
async function fromShellFile(file: string): Promise<Keymap | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const field = (name: string) =>
    new RegExp(`^\\s*${name}=(["']?)(.*?)\\1\\s*$`, 'm').exec(text)?.[2];
  return toKeymap({
    model: field('XKBMODEL'),
    layout: field('XKBLAYOUT'),
    variant: field('XKBVARIANT'),
    options: field('XKBOPTIONS'),
  });
}

/** Xorg's InputClass keyboard config, as localectl writes it (Fedora, Arch). */
async function fromXorgConf(file: string): Promise<Keymap | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const field = (name: string) =>
    new RegExp(`^\\s*Option\\s+"${name}"\\s+"([^"]*)"`, 'mi').exec(text)?.[1];
  return toKeymap({
    rules: field('XkbRules'),
    model: field('XkbModel'),
    layout: field('XkbLayout'),
    variant: field('XkbVariant'),
    options: field('XkbOptions'),
  });
}

/**
 * The OS's layout, from the most specific place that has one: what Din's
 * own compositor was told, then the desktop's settings, the live X server,
 * and the system-wide defaults.
 */
async function detectSystemKeymap(): Promise<Keymap | null> {
  const sources = [
    async () => fromEnvironment(),
    fromGnome,
    fromKde,
    fromX,
    () => fromShellFile('/etc/default/keyboard'),
    () => fromXorgConf('/etc/X11/xorg.conf.d/00-keyboard.conf'),
    () => fromShellFile('/etc/vconsole.conf'),
  ];
  for (const source of sources) {
    const keymap = await source();
    if (keymap) return keymap;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The layouts there are (xkeyboard-config's rules list)
// ---------------------------------------------------------------------------

function rulesDirs(): string[] {
  return [
    process.env.XKB_CONFIG_ROOT,
    '/usr/share/X11/xkb',
    '/run/current-system/sw/share/X11/xkb',
    '/etc/X11/xkb',
  ]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => path.join(dir, 'rules'));
}

/** The layout and variant sections of an xkeyboard-config .lst file. */
function parseRulesList(text: string): LayoutEntry[] {
  const entries: LayoutEntry[] = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('!')) {
      section = line.slice(1).trim();
      continue;
    }
    const match = /^\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    if (section === 'layout') {
      // A placeholder for a hand-written symbols file, not a layout.
      if (match[1] === 'custom') continue;
      entries.push({ layout: match[1], variant: '', name: match[2].trim() });
    } else if (section === 'variant') {
      // "  colemak         us: English (Colemak)"
      const variant = /^([^:\s]+):\s*(.+)$/.exec(match[2]);
      if (variant) entries.push({ layout: variant[1], variant: match[1], name: variant[2].trim() });
    }
  }
  return entries.filter((entry) => SAFE_FIELD.test(entry.layout) && SAFE_FIELD.test(entry.variant));
}

let catalog: Promise<LayoutEntry[]> | null = null;

function layoutCatalog(): Promise<LayoutEntry[]> {
  catalog ??= (async () => {
    for (const dir of rulesDirs()) {
      for (const file of ['evdev.lst', 'base.lst']) {
        try {
          const entries = parseRulesList(await fs.readFile(path.join(dir, file), 'utf8'));
          if (entries.length > 0) return entries.sort((a, b) => a.name.localeCompare(b.name));
        } catch {
          // try the next
        }
      }
    }
    return [];
  })();
  return catalog;
}

// ---------------------------------------------------------------------------
// The user's choice, and the keymap in effect
// ---------------------------------------------------------------------------

function selectionFile(): string {
  return path.join(app.getPath('userData'), 'keyboard-layout.json');
}

/** The layout picked in Settings; null follows the OS. */
let selection: LayoutChoice | null = null;
let system: Keymap | null = null;
let effective: Keymap = DEFAULT_KEYMAP;
let loaded: Promise<void> | null = null;
const listeners = new Set<(keymap: Keymap) => void>();

function parseChoice(value: unknown): LayoutChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { layout, variant } = value as Record<string, unknown>;
  if (typeof layout !== 'string' || typeof variant !== 'string') return null;
  return { layout, variant };
}

/**
 * Recompute the keymap in effect and tell listeners if it changed. A picked
 * layout replaces the OS's layouts but keeps its model and options (Caps
 * Lock as Ctrl and the like belong to the person, not the layout).
 */
function update(): void {
  const base = system ?? DEFAULT_KEYMAP;
  const next = selection ? { ...base, ...selection } : base;
  if (JSON.stringify(next) === JSON.stringify(effective)) return;
  effective = next;
  for (const listener of listeners) listener(next);
}

async function refreshSystem(): Promise<void> {
  system = await detectSystemKeymap();
  update();
}

function load(): Promise<void> {
  loaded ??= (async () => {
    try {
      selection = parseChoice(JSON.parse(await fs.readFile(selectionFile(), 'utf8')));
    } catch {
      selection = null;
    }
    await refreshSystem();
  })();
  return loaded;
}

/** The keymap native apps should use (the OS's unless Settings overrides it). */
export async function keyboardKeymap(): Promise<Keymap> {
  await load();
  return effective;
}

/** Call `listener` whenever the keymap in effect changes. */
export function onKeymapChange(listener: (keymap: Keymap) => void): void {
  listeners.add(listener);
}

/** A layout's display name; for several groups, the first one's. */
async function describe(keymap: Keymap): Promise<LayoutEntry> {
  const layout = keymap.layout.split(',')[0];
  const variant = keymap.variant.split(',')[0] ?? '';
  const entries = await layoutCatalog();
  const entry = entries.find((e) => e.layout === layout && e.variant === variant)
    ?? entries.find((e) => e.layout === layout && e.variant === '');
  return { layout, variant, name: entry?.name ?? (variant ? `${layout} (${variant})` : layout) };
}

export function registerKeyboardHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('keyboard:status', async (event) => {
    assertShellSender(event);
    await load();
    // The OS may have changed since; Settings is where anyone would look.
    await refreshSystem();
    return {
      system: await describe(system ?? DEFAULT_KEYMAP),
      selected: selection,
    };
  });

  ipcMain.handle('keyboard:layouts', async (event) => {
    assertShellSender(event);
    return layoutCatalog();
  });

  ipcMain.handle('keyboard:set', async (event, raw) => {
    assertShellSender(event);
    let next: LayoutChoice | null = null;
    if (raw !== null) {
      const choice = parseChoice(raw);
      const known = choice && (await layoutCatalog()).some(
        (entry) => entry.layout === choice.layout && entry.variant === choice.variant,
      );
      if (!choice || !known) throw new Error('Unknown keyboard layout');
      next = { layout: choice.layout, variant: choice.variant };
    }
    await load();
    if (next) await fs.writeFile(selectionFile(), JSON.stringify(next));
    else await fs.rm(selectionFile(), { force: true });
    selection = next;
    update();
  });

  // Follow GNOME's layout switches while Din runs.
  if (isGnome()) {
    let timer: NodeJS.Timeout | null = null;
    watchCommand('keyboard-layout', 'gsettings', ['monitor', GNOME_SCHEMA], () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (loaded) void refreshSystem();
      }, 250);
    });
  }
}

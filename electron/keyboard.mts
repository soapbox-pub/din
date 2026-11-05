// The keyboard layout: the system's, which Settings → Keyboard shows and
// changes.
//
// Din forwards physical keys to native apps (src/lib/nativeDisplay.ts sends
// evdev keycodes, not characters), and the embedded display's servers turn
// them into characters with a keymap of their own. Left alone that keymap is
// US QWERTY whatever the OS is set to, so a Colemak or AZERTY typist got the
// right letters in Din's own windows (those come from the host) and the wrong
// ones in every native app. So the layout is read from wherever the OS keeps
// it, and native-display.mts pushes it to the compositor (and through it
// Xwayland) and the X server.
//
// Settings changes the system's layout where Din knows how. On DinOS that's
// os/din-keyboard.sh, which DinOS's launcher names in DIN_KEYBOARD and the
// shell's user runs through sudo without a password, like the updater's
// helper. din-shell reads the layout when it starts, so native apps switch at
// once and Din's own windows after Din restarts. On GNOME it's the desktop's
// input sources, which switch everything at once. Elsewhere the layout is
// shown but not changed.
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

const HELPER = process.env.DIN_KEYBOARD;
const LAYOUT_FILE = '/var/lib/din/keyboard';

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

/** XKB_DEFAULT_*: how din-shell, sway and other wlroots compositors are told. */
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
  const groups = parseSources(sources)
    .filter(([type]) => type === 'xkb')
    .slice(0, 4)
    .map(([, name]) => name.split('+'));
  if (groups.length === 0) return null;
  const variants = groups.map(([, variant]) => variant ?? '');
  return toKeymap({
    layout: groups.map(([layout]) => layout).join(','),
    variant: variants.some(Boolean) ? variants.join(',') : '',
    options: [...(options ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]).join(','),
  });
}

/** An input sources value, e.g. "[('xkb', 'us'), ('ibus', 'mozc-jp')]", as pairs. */
function parseSources(value: string | null): [string, string][] {
  return [...(value ?? '').matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g)]
    .map((match): [string, string] => [match[1], match[2]]);
}

/**
 * Make a layout GNOME's: first in its input sources and its most recently
 * used, so it's the one in use. The others stay, to switch to as before.
 */
async function setGnomeLayout(choice: LayoutChoice): Promise<void> {
  const id = choice.variant ? `${choice.layout}+${choice.variant}` : choice.layout;
  const promote = (value: string | null) => {
    const rest = parseSources(value).filter(([type, name]) => !(type === 'xkb' && name === id));
    return `[${[['xkb', id], ...rest].map(([type, name]) => `('${type}', '${name}')`).join(', ')}]`;
  };
  const [sources, mru] = await Promise.all([gsettings('sources'), gsettings('mru-sources')]);
  await runCommand('gsettings', ['set', GNOME_SCHEMA, 'sources', promote(sources)], { timeout: 3_000 });
  await runCommand('gsettings', ['set', GNOME_SCHEMA, 'mru-sources', promote(mru)], { timeout: 3_000 });
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

/** DinOS's layout file, as XKB_DEFAULT_* lines (os/din-keyboard.sh). */
async function fromLayoutFile(): Promise<Keymap | null> {
  let text: string;
  try {
    text = await fs.readFile(LAYOUT_FILE, 'utf8');
  } catch {
    return null;
  }
  const field = (name: string) => new RegExp(`^XKB_DEFAULT_${name}=(.*)$`, 'm').exec(text)?.[1];
  return toKeymap({
    rules: field('RULES'),
    model: field('MODEL'),
    layout: field('LAYOUT'),
    variant: field('VARIANT'),
    options: field('OPTIONS'),
  });
}

/**
 * The OS's layout, from the most specific place that has one. On DinOS
 * that's the layout file, which is newer than what din-shell was started with
 * when Settings has changed it since. Elsewhere it's what Din's own
 * compositor was told, then the desktop's settings, the live X server, and
 * the system-wide defaults.
 */
async function detectSystemKeymap(): Promise<Keymap | null> {
  if (HELPER) return (await fromLayoutFile()) ?? fromEnvironment();
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
// The layouts, and the one typing
// ---------------------------------------------------------------------------

/** The most layouts a keymap holds: XKB's groups. */
const MAX_LAYOUTS = 4;

/** Whether Din is on din-shell, which names its Wayland socket so (session/mod.rs). */
const onShell = process.env.WAYLAND_DISPLAY === 'din-shell' && !!process.env.XDG_RUNTIME_DIR;

/** Where din-shell is told the keymap and the layout typing (session/layouts.rs). */
const SHELL_FILE = 'din-shell-keyboard';

let system: Keymap | null = null;
let effective: Keymap = DEFAULT_KEYMAP;
let loaded: Promise<void> | null = null;
const listeners = new Set<(keymap: Keymap) => void>();
const statusListeners = new Set<() => void>();

/** The layout typing, and those typed with before it, most recent first. */
let recent: LayoutChoice[] = [];

function parseChoice(value: unknown): LayoutChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { layout, variant } = value as Record<string, unknown>;
  if (typeof layout !== 'string' || typeof variant !== 'string') return null;
  return { layout, variant };
}

function sameChoice(a: LayoutChoice, b: LayoutChoice): boolean {
  return a.layout === b.layout && a.variant === b.variant;
}

function sameLayout(a: Keymap, b: Keymap): boolean {
  return a.layout === b.layout && a.variant === b.variant;
}

/** A keymap's layouts, one per XKB group. */
function groupsOf(keymap: Keymap): LayoutChoice[] {
  const variants = keymap.variant.split(',');
  return keymap.layout
    .split(',')
    .map((layout, i) => ({ layout: layout.trim(), variant: (variants[i] ?? '').trim() }))
    .filter((group) => group.layout)
    .slice(0, MAX_LAYOUTS);
}

/** KEYMAP with GROUPS for its layouts. */
function withGroups(keymap: Keymap, groups: LayoutChoice[]): Keymap {
  return {
    ...keymap,
    layout: groups.map((group) => group.layout).join(','),
    variant: groups.some((group) => group.variant) ? groups.map((group) => group.variant).join(',') : '',
  };
}

/** The system's layouts. */
function systemGroups(): LayoutChoice[] {
  return groupsOf(system ?? DEFAULT_KEYMAP);
}

/** Which of GROUPS is typing: the most recent one still there. */
function activeIndex(groups: LayoutChoice[]): number {
  for (const choice of recent) {
    const index = groups.findIndex((group) => sameChoice(group, choice));
    if (index >= 0) return index;
  }
  return 0;
}

/** Whether Settings can change the system's layouts here. */
function canChange(): boolean {
  return Boolean(HELPER) || isGnome();
}

/** Whether Din switches between the layouts: on din-shell, with more than one. */
function canSwitch(groups: LayoutChoice[]): boolean {
  return onShell && groups.length > 1;
}

const recentFile = () => path.join(app.getPath('userData'), 'keyboard-recent.json');

async function loadRecent(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(recentFile(), 'utf8'));
    if (Array.isArray(raw)) recent = raw.map(parseChoice).filter((choice): choice is LayoutChoice => choice !== null);
  } catch {
    recent = [];
  }
}

function saveRecent(): void {
  const file = recentFile();
  const temp = `${file}.${process.pid}`;
  void fs.writeFile(temp, JSON.stringify(recent))
    .then(() => fs.rename(temp, file))
    .catch((error) => console.error('keyboard: saving the layout in use failed:', error));
}

/** Tell din-shell the keymap and the layout typing; renamed into place, so it never reads half. */
async function tellShell(keymap: Keymap, group: number): Promise<void> {
  if (!onShell) return;
  const file = path.join(process.env.XDG_RUNTIME_DIR!, SHELL_FILE);
  const temp = `${file}.${process.pid}`;
  const text = [
    `rules=${keymap.rules}`,
    `model=${keymap.model}`,
    `layout=${keymap.layout}`,
    `variant=${keymap.variant}`,
    `options=${keymap.options}`,
    `group=${group}`,
  ].join('\n');
  try {
    await fs.writeFile(temp, `${text}\n`);
    await fs.rename(temp, file);
  } catch (error) {
    console.error('keyboard: telling din-shell the layout failed:', error);
  }
}

let told = '';

/**
 * Recompute the keymap in effect and tell everyone who needs it: din-shell
 * the system's keymap and which group is typing; the embedded display's
 * servers (native-display.mts) a keymap with the layout typing first, as
 * they hear only physical keys; and Settings and the menu bar.
 */
function update(): void {
  const current = system ?? DEFAULT_KEYMAP;
  const groups = groupsOf(current);
  const active = activeIndex(groups);
  const shell = JSON.stringify([current, active]);
  if (shell !== told) {
    told = shell;
    void tellShell(current, active);
    for (const listener of statusListeners) listener();
  }
  const next = withGroups(current, [groups[active], ...groups.filter((_, i) => i !== active)].filter(Boolean));
  if (JSON.stringify(next) === JSON.stringify(effective)) return;
  effective = next;
  for (const listener of listeners) listener(next);
}

async function refreshSystem(): Promise<void> {
  system = await detectSystemKeymap();
  update();
}

/** The choices as din-keyboard takes them: LAYOUT or LAYOUT:VARIANT. */
function helperArgs(choices: LayoutChoice[]): string[] {
  return choices.map((choice) => (choice.variant ? `${choice.layout}:${choice.variant}` : choice.layout));
}

/** GNOME's input sources: CHOICES, then the input methods it had (ibus). */
async function setGnomeLayouts(choices: LayoutChoice[]): Promise<void> {
  const others = parseSources(await gsettings('sources')).filter(([type]) => type !== 'xkb');
  const sources = [
    ...choices.map((choice): [string, string] => ['xkb', choice.variant ? `${choice.layout}+${choice.variant}` : choice.layout]),
    ...others,
  ];
  const value = `[${sources.map(([type, name]) => `('${type}', '${name}')`).join(', ')}]`;
  await runCommand('gsettings', ['set', GNOME_SCHEMA, 'sources', value], { timeout: 3_000 });
}

async function setSystemLayouts(choices: LayoutChoice[]): Promise<void> {
  if (HELPER) {
    await runCommand('sudo', ['-n', HELPER, 'set', ...helperArgs(choices)], { timeout: 15_000 });
  } else if (isGnome()) {
    await setGnomeLayouts(choices);
  } else {
    throw new Error('Din can\'t change the keyboard layout on this system');
  }
}

/** Make a layout the system's only one; on GNOME, its first, keeping the others. */
async function setSystemLayout(choice: LayoutChoice): Promise<void> {
  if (!HELPER && isGnome()) await setGnomeLayout(choice);
  else await setSystemLayouts([choice]);
}

/** Type with GROUPS[INDEX] from now on. */
function select(index: number): void {
  const groups = systemGroups();
  const choice = groups[index];
  if (!choice) throw new Error('No such keyboard layout');
  recent = [choice, ...recent.filter((other) => !sameChoice(other, choice))].slice(0, 16);
  saveRecent();
  update();
}

/**
 * Settings used to keep a layout of its own, for native apps only. On DinOS
 * that was the only way to pick one, so it becomes the system's, unless the
 * system already has one; elsewhere the system's layout takes over.
 */
async function migrateOldSelection(): Promise<void> {
  const file = path.join(app.getPath('userData'), 'keyboard-layout.json');
  let choice: LayoutChoice | null;
  try {
    choice = parseChoice(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return;
  }
  if (choice && HELPER && !(await fromLayoutFile())) {
    try {
      await setSystemLayout(choice);
    } catch (error) {
      console.error('keyboard: carrying over the old layout failed:', error);
    }
  }
  await fs.rm(file, { force: true });
}

function load(): Promise<void> {
  loaded ??= (async () => {
    await migrateOldSelection();
    await loadRecent();
    await refreshSystem();
  })();
  return loaded;
}

/** The keymap native apps should use: the system's, with the layout typing first. */
export async function keyboardKeymap(): Promise<Keymap> {
  await load();
  return effective;
}

/** Call `listener` whenever the keymap in effect changes. */
export function onKeymapChange(listener: (keymap: Keymap) => void): void {
  listeners.add(listener);
}

/** A layout's display name. */
async function describe(choice: LayoutChoice): Promise<LayoutEntry> {
  const { layout, variant } = choice;
  const entries = await layoutCatalog();
  const entry = entries.find((e) => e.layout === layout && e.variant === variant)
    ?? entries.find((e) => e.layout === layout && e.variant === '');
  return { layout, variant, name: entry?.name ?? (variant ? `${layout} (${variant})` : layout) };
}

async function status() {
  await load();
  const current = system ?? DEFAULT_KEYMAP;
  const groups = groupsOf(current);
  const layouts = await Promise.all(groups.map(describe));
  const active = activeIndex(groups);
  return {
    layout: layouts[active] ?? (await describe({ layout: 'us', variant: '' })),
    layouts,
    active,
    canChange: canChange(),
    canSwitch: canSwitch(groups),
    // Off din-shell, its compositor still has the layout it started with
    // (and passed down to Din); din-shell itself takes a new one at once.
    restartNeeded: Boolean(HELPER) && !onShell && !sameLayout(current, fromEnvironment() ?? DEFAULT_KEYMAP),
  };
}

/** Choices from the renderer, each one xkeyboard-config knows. */
async function knownChoices(raw: unknown): Promise<LayoutChoice[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LAYOUTS) {
    throw new Error(`One to ${MAX_LAYOUTS} keyboard layouts`);
  }
  const catalog = await layoutCatalog();
  const choices: LayoutChoice[] = [];
  for (const item of raw) {
    const choice = parseChoice(item);
    const known = choice && catalog.some((entry) => sameChoice(entry, choice));
    if (!choice || !known) throw new Error('Unknown keyboard layout');
    if (!choices.some((other) => sameChoice(other, choice))) choices.push({ layout: choice.layout, variant: choice.variant });
  }
  return choices;
}

// ---------------------------------------------------------------------------
// Switching from the keyboard
// ---------------------------------------------------------------------------

/**
 * Ctrl+Space and Ctrl+Alt+Space, as a Mac's Control-Space and
 * Control-Option-Space: back to the layout typed with before, and on to the
 * next one in the list. Pressing Space again with Ctrl still held goes on
 * back through the layouts in the order they were used, as a Mac does. The
 * keys are only taken when there are layouts to switch between, so with one
 * they're the page's, as they are on a Mac.
 */
let chain: { order: number[]; at: number } | null = null;

function switchKey(input: Electron.Input): 'previous' | 'next' | null {
  if (input.code !== 'Space' || !input.control || input.meta || input.shift) return null;
  return input.alt ? 'next' : 'previous';
}

function switchFromKeyboard(direction: 'previous' | 'next'): void {
  const groups = systemGroups();
  if (!canSwitch(groups)) return;
  const active = activeIndex(groups);
  if (direction === 'next') {
    chain = null;
    select((active + 1) % groups.length);
    return;
  }
  if (!chain) {
    // Most recent first, then any never used, in the list's order.
    const used = recent
      .map((choice) => groups.findIndex((group) => sameChoice(group, choice)))
      .filter((index, i, all) => index >= 0 && all.indexOf(index) === i);
    const order = [...used, ...groups.map((_, i) => i).filter((i) => !used.includes(i))];
    chain = { order, at: 0 };
  }
  // select() reorders recent; the run keeps the order it started with.
  chain.at = (chain.at + 1) % chain.order.length;
  select(chain.order[chain.at]);
}

/** Take the switching keys in CONTENTS: the shell's, or any guest's that has focus. */
export function attachLayoutKeys(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input) => {
    // Letting go of Ctrl ends a run of Ctrl+Space presses.
    if (!input.control || (input.type === 'keyUp' && input.key === 'Control')) chain = null;
    const direction = switchKey(input);
    if (!direction || !canSwitch(systemGroups())) return;
    event.preventDefault();
    if (input.type === 'keyDown' && !input.isAutoRepeat) switchFromKeyboard(direction);
  });
}

export function registerKeyboardHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  send: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, send } = options;

  // Settings and the menu bar hear of every switch, the keyboard's included.
  statusListeners.add(() => {
    void status().then((next) => send('keyboard:changed', next)).catch(() => {});
  });
  // din-shell starts typing with the first layout; tell it the one in use.
  void load();

  ipcMain.handle('keyboard:status', async (event) => {
    assertShellSender(event);
    await load();
    // The OS may have changed since; Settings is where anyone would look.
    await refreshSystem();
    return status();
  });

  ipcMain.handle('keyboard:layouts', async (event) => {
    assertShellSender(event);
    return layoutCatalog();
  });

  ipcMain.handle('keyboard:set', async (event, raw) => {
    assertShellSender(event);
    const [choice] = await knownChoices([raw]);
    await load();
    await setSystemLayout(choice);
    await refreshSystem();
  });

  ipcMain.handle('keyboard:setLayouts', async (event, raw) => {
    assertShellSender(event);
    const choices = await knownChoices(raw);
    await load();
    await setSystemLayouts(choices);
    await refreshSystem();
  });

  ipcMain.handle('keyboard:select', async (event, index) => {
    assertShellSender(event);
    await load();
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('No such keyboard layout');
    if (!canSwitch(systemGroups())) throw new Error('Din can\'t switch keyboard layouts here');
    select(index);
  });

  ipcMain.handle('keyboard:restart', async (event) => {
    assertShellSender(event);
    if (!HELPER) throw new Error('Din doesn\'t need a restart here');
    await runCommand('sudo', ['-n', HELPER, 'restart'], { timeout: 15_000 });
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

// X apps' desktop settings, over XSETTINGS.
//
// GTK on X11 (and Qt's GTK platform theme, Firefox, Electron's X11 GTK
// bits) takes its theme, icons, pointer, font and font rendering from the
// XSETTINGS manager of its display, and follows its changes live. It reads
// no GSettings there, and without a manager it falls back to settings.ini
// (gtk-theme.mts) or its own defaults: no icon theme, a different pointer,
// another font. Most AppImages run there, forced onto X11 by their
// launchers.
//
// So the embedded display (native-display.mts) gets xsettingsd, fed from
// the GSettings Din's own settings write (theme, icons, pointer, fonts,
// animations, the title bar's buttons), and told again whenever one
// changes.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand, watchCommand } from './system.mts';

const INTERFACE = 'org.gnome.desktop.interface';
const WM = 'org.gnome.desktop.wm.preferences';

/** A restart after the manager died, unless the display went too. */
const RESTART_DELAY = 5_000;

/** GSettings keys as `gsettings list-recursively` gives them: schema → key → value text. */
type Settings = Map<string, Map<string, string>>;

/** A GVariant text value as a string: a quoted one unquoted, anything else as it is. */
export function gvariantString(value: string): string {
  const text = value.trim();
  const quote = text[0];
  if ((quote === "'" || quote === '"') && text.endsWith(quote) && text.length >= 2) {
    return text.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return text;
}

/** `gsettings list-recursively` output, by schema and key. */
export function parseSettings(text: string): Settings {
  const settings: Settings = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, schema, key, value] = match;
    if (!settings.has(schema)) settings.set(schema, new Map());
    settings.get(schema)!.set(key, value);
  }
  return settings;
}

/** One xsettingsd setting: a string or an integer. */
type Value = string | number;

/** The XSETTINGS GTK reads, from GSettings. Unset keys are left out. */
export function xsettingsFrom(settings: Settings): [name: string, value: Value][] {
  const iface = settings.get(INTERFACE) ?? new Map<string, string>();
  const wm = settings.get(WM) ?? new Map<string, string>();
  const text = (map: Map<string, string>, key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : gvariantString(value);
  };
  const out: [string, Value][] = [];
  const put = (name: string, value: Value | undefined) => {
    if (value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value))) {
      out.push([name, value]);
    }
  };
  put('Net/ThemeName', text(iface, 'gtk-theme'));
  put('Net/IconThemeName', text(iface, 'icon-theme'));
  put('Gtk/CursorThemeName', text(iface, 'cursor-theme'));
  const cursorSize = text(iface, 'cursor-size');
  put('Gtk/CursorThemeSize', cursorSize === undefined ? undefined : parseInt(cursorSize.replace(/^int32\s+/, ''), 10));
  put('Gtk/FontName', text(iface, 'font-name'));
  const animations = text(iface, 'enable-animations');
  put('Gtk/EnableAnimations', animations === undefined ? undefined : animations === 'true' ? 1 : 0);
  put('Gtk/DecorationLayout', text(wm, 'button-layout'));
  const antialiasing = text(iface, 'font-antialiasing');
  if (antialiasing !== undefined) {
    put('Xft/Antialias', antialiasing === 'none' ? 0 : 1);
    put('Xft/RGBA', antialiasing === 'rgba' ? (text(iface, 'font-rgba-order') ?? 'rgb') : 'none');
  }
  const hinting = text(iface, 'font-hinting');
  if (hinting !== undefined) {
    put('Xft/Hinting', hinting === 'none' ? 0 : 1);
    put('Xft/HintStyle', `hint${hinting}`);
  }
  // Text scaling is the DPI X apps size their fonts by, in 1024ths.
  const scaling = parseFloat(text(iface, 'text-scaling-factor') ?? '1');
  put('Xft/DPI', Math.round(96 * 1024 * (Number.isFinite(scaling) && scaling > 0 ? scaling : 1)));
  return out;
}

/** xsettingsd's config file for SETTINGS. */
export function xsettingsConfig(settings: [string, Value][]): string {
  return settings
    .map(([name, value]) =>
      typeof value === 'number' ? `${name} ${Math.round(value)}` : `${name} "${value.replace(/["\\]/g, '\\$&')}"`,
    )
    .join('\n') + '\n';
}

interface Target {
  display: string;
  xauthority: string | null;
}

let target: Target | null = null;
let manager: ChildProcess | null = null;
let written = '';
let watching = false;
/** xsettingsd isn't installed: nothing more to try. */
let missing = false;

/** The config file for the display Din manages (one per display, for a Din nested in another). */
function configFile(): string {
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const display = (target?.display ?? '').replace(/[^0-9a-z]/gi, '');
  return path.join(dir, `din-xsettingsd-${display}.conf`);
}

async function readSettings(): Promise<Settings> {
  const lists = await Promise.all(
    [INTERFACE, WM].map((schema) =>
      runCommand('gsettings', ['list-recursively', schema], { timeout: 3_000 }).then(
        (result) => result.stdout,
        () => '',
      ),
    ),
  );
  return parseSettings(lists.join('\n'));
}

/** Write the settings as GSettings has them now, and tell the manager. */
async function refresh(): Promise<void> {
  const config = xsettingsConfig(xsettingsFrom(await readSettings()));
  if (config === written) return;
  await fsp.writeFile(configFile(), config);
  written = config;
  manager?.kill('SIGHUP');
}

function launch(): void {
  if (!target || manager || missing) return;
  const { display, xauthority } = target;
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display };
  if (xauthority) env.XAUTHORITY = xauthority;
  else delete env.XAUTHORITY;
  const child = spawn('xsettingsd', ['-c', configFile()], { env, stdio: 'ignore' });
  manager = child;
  child.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') missing = true;
  });
  child.once('exit', () => {
    if (manager !== child) return;
    manager = null;
    // It goes when its display does; another display starts its own.
    setTimeout(() => {
      if (target?.display === display) launch();
    }, RESTART_DELAY);
  });
}

/**
 * Be the XSETTINGS manager of DISPLAY (XAUTHORITY its cookie, if it has
 * one), in place of any display before it.
 */
export async function startXSettings(display: string, xauthority: string | null): Promise<void> {
  if (target?.display === display && manager) return;
  target = { display, xauthority };
  const old = manager;
  manager = null;
  old?.kill();
  if (!watching) {
    watching = true;
    for (const schema of [INTERFACE, WM]) {
      watchCommand(`xsettings-${schema}`, 'gsettings', ['monitor', schema], () => {
        refresh().catch((error: unknown) => console.warn('Could not update X apps’ settings:', error));
      });
    }
  }
  try {
    written = '';
    await refresh();
  } catch (error) {
    console.warn('Could not write X apps’ settings:', error);
    return;
  }
  launch();
}

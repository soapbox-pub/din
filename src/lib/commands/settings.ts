import type { AppConfig } from '@/contexts/AppContext';
import { effectsFor } from '@/lib/effects';
import { CLICK_EFFECTS, TRAIL_EFFECTS } from '@/lib/cursorEffects';
import { getNotificationState, setDoNotDisturb } from '@/lib/notificationCenter';
import { coerce } from './parse';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { command } from './util';

/**
 * `din settings`: Din's own preferences, by friendly keys, the way
 * `gsettings` does GNOME's. Each is what a switch or picker in Settings
 * changes. The system's (Wi-Fi, sound, the time zone…) have areas of their
 * own, which act rather than set.
 */

interface Setting {
  key: string;
  help: string;
  param: Omit<Param, 'name' | 'help' | 'positional'>;
  /** The AppConfig field it is, if it is one. */
  field?: keyof AppConfig;
  get?: (ctx: CommandContext) => unknown;
  set?: (ctx: CommandContext, value: unknown) => void;
  /** Values other than the choices it takes (an imported effect's id). */
  accepts?: (raw: string) => boolean;
}

const bool = { type: 'boolean' } as const;

const SETTINGS: Setting[] = [
  { key: 'appearance.theme', field: 'theme', help: 'Light, dark, or as the system prefers', param: { type: 'string', choices: ['light', 'dark', 'system'] } },
  { key: 'appearance.custom-theme', field: 'customThemeEnabled', help: 'Wear a custom theme of colors, fonts and a background', param: bool },
  { key: 'appearance.sync-profile-theme', field: 'syncProfileTheme', help: 'The custom theme is your profile theme, rather than this computer’s', param: bool },
  { key: 'appearance.wobbly-windows', field: 'wobblyWindows', help: 'Windows wobble as they’re dragged', param: bool },
  {
    key: 'appearance.minimize-effect', field: 'minimizeEffect', help: 'The effect windows minimize with',
    param: { type: 'string', choices: ['none', 'random', ...effectsFor('minimize').map((e) => e.id)] },
  },
  {
    key: 'appearance.close-effect', field: 'closeEffect', help: 'The effect windows close with',
    param: { type: 'string', choices: ['none', 'pop', 'random', ...effectsFor('close').map((e) => e.id)] },
  },
  {
    key: 'appearance.cursor-trail', field: 'cursorTrail', help: 'What the pointer leaves behind as it moves',
    param: { type: 'string', choices: ['none', ...TRAIL_EFFECTS.map((e) => e.id)] }, accepts: (raw) => raw.startsWith('cursorfx:'),
  },
  {
    key: 'appearance.cursor-click', field: 'cursorClick', help: 'What a click sets off',
    param: { type: 'string', choices: ['none', ...CLICK_EFFECTS.map((e) => e.id)] }, accepts: (raw) => raw.startsWith('cursorfx:'),
  },
  { key: 'appearance.cursor-theme-color', field: 'cursorThemeColor', help: 'Cursor effects take on the theme\'s color', param: bool },
  { key: 'appearance.show-mouse', field: 'cursorShowMouse', help: 'Super+Shift+K, or shaking the mouse, rings the pointer with light', param: bool },
  { key: 'appearance.fire-paint', field: 'cursorFirePaint', help: 'Super+Shift and drag to draw in fire', param: bool },
  { key: 'appearance.water', field: 'cursorWater', help: 'Hold Super+Ctrl and move the mouse to stir the screen', param: bool },
  { key: 'appearance.power-mode', field: 'powerMode', help: 'Type a while without stopping and keystrokes throw sparks from the caret', param: bool },
  { key: 'appearance.power-mode-shake', field: 'powerModeShake', help: 'Power mode shakes the window being typed in', param: bool },
  { key: 'windows.tiling', field: 'tilingEnabled', help: 'Windows tile instead of floating', param: bool },
  { key: 'windows.gaps', field: 'tilingGap', help: 'Pixels between tiled windows', param: { type: 'integer', min: 0, max: 32 } },
  { key: 'windows.reopen', field: 'restoreWindows', help: 'Din reopens your windows when it starts again', param: bool },
  { key: 'desktop.layout', field: 'desktopLayout', help: 'The menu bar and Dock, or a taskbar along the bottom', param: { type: 'string', choices: ['dock', 'taskbar'] } },
  { key: 'dock.size', field: 'dockSize', help: 'The size of a Dock icon, in pixels', param: { type: 'integer', min: 32, max: 160 } },
  { key: 'dock.magnification', field: 'dockMagnification', help: 'Dock icons grow under the pointer', param: bool },
  { key: 'dock.magnification-scale', field: 'dockMagnificationScale', help: 'How much they grow (1.5 is half again)', param: { type: 'number', min: 1, max: 3 } },
  { key: 'dock.style', field: 'dockStyle', help: 'What the Dock sits on', param: { type: 'string', choices: ['none', 'modern', 'classic'] } },
  { key: 'taskbar.style', field: 'taskbarStyle', help: 'A tall taskbar (Windows 7) or a slim one (Windows Vista)', param: { type: 'string', choices: ['tall', 'slim'] } },
  { key: 'taskbar.buttons', field: 'taskbarButtons', help: 'A taskbar button per app, its windows combined, or one per window', param: { type: 'string', choices: ['combine', 'separate'] } },
  { key: 'display.zoom', field: 'zoomLevel', help: 'Scale everything on the desktop, in percent', param: { type: 'integer', min: 50, max: 200 } },
  { key: 'datetime.clock-format', field: 'clockFormat', help: '12- or 24-hour time, or the locale’s', param: { type: 'string', choices: ['auto', '12', '24'] } },
  { key: 'datetime.show-date', field: 'clockShowDate', help: 'The menu bar shows the date beside the time', param: bool },
  { key: 'datetime.show-seconds', field: 'clockShowSeconds', help: 'The menu bar shows seconds', param: bool },
  { key: 'nostr.sync', field: 'syncToNostr', help: 'Sync Din’s settings and apps to your relays, encrypted', param: bool },
  { key: 'nostr.app-blossom-servers', field: 'useAppBlossomServers', help: 'Upload to Din’s Blossom servers as well as yours', param: bool },
  { key: 'assistant.enabled', field: 'assistantEnabled', help: 'The Assistant is on', param: bool },
  { key: 'assistant.directory', field: 'assistantDirectory', help: 'The folder new conversations work in (empty for home)', param: { type: 'path' } },
  { key: 'assistant.colorful-replies', field: 'assistantColorfulReplies', help: 'Replies color their headings, code and links', param: bool },
  {
    key: 'notifications.do-not-disturb', help: 'Only urgent notifications pop up', param: bool,
    get: () => getNotificationState().doNotDisturb,
    set: (_ctx, value) => setDoNotDisturb(value === true),
  },
];

/**
 * AppConfig fields that aren't `din settings` keys, and why. The parity
 * test fails on a field in neither list.
 */
export const CONFIG_FIELDS_ELSEWHERE: Partial<Record<keyof AppConfig, string>> = {
  relayMetadata: 'din nostr relays',
  blossomServerMetadata: 'din nostr blossom',
  profileThemeMetadata: 'the profile theme itself, kept in step by the desktop',
  localTheme: 'the theme editor in Settings → Themes (not yet a command)',
};

export const SETTING_FIELDS: (keyof AppConfig)[] = SETTINGS.flatMap((s) => (s.field ? [s.field] : []));

function find(key: string): Setting {
  const setting = SETTINGS.find((s) => s.key === key);
  if (!setting) throw new CommandError(`No setting ${key}; din settings list shows them`, 'usage');
  return setting;
}

function read(ctx: CommandContext, setting: Setting): unknown {
  if (setting.get) return setting.get(ctx);
  return setting.field ? ctx.config[setting.field] : undefined;
}

function shown(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return value === '' ? '""' : String(value);
}

const KEY: Param = { name: 'key', type: 'string', positional: true, help: 'The setting, e.g. appearance.theme' };

export const settingsArea: Area = {
  name: 'settings',
  summary: 'Din’s preferences: theme, effects, Dock or taskbar, tiling, clock, sync…',
  commands: [
    command('settings', 'list', 'Every setting, with its value', [
      { name: 'prefix', type: 'string', positional: true, optional: true, help: 'Only those under it, e.g. dock' },
    ], (args, ctx) => {
      const prefix = args.optString('prefix');
      const rows = SETTINGS
        .filter((s) => !prefix || s.key === prefix || s.key.startsWith(`${prefix}.`))
        .map((s) => ({ key: s.key, value: read(ctx, s), about: s.help }));
      return {
        data: rows,
        text: rows.map((r) => `${r.key} = ${shown(r.value)}`).join('\n'),
      };
    }),
    command('settings', 'get', 'A setting’s value', [KEY], (args, ctx) => {
      const value = read(ctx, find(args.string('key')));
      return { data: value, text: shown(value) };
    }),
    command('settings', 'describe', 'What a setting is, and the values it takes', [KEY], (args, ctx) => {
      const setting = find(args.string('key'));
      const { param } = setting;
      return {
        data: { key: setting.key, about: setting.help, value: read(ctx, setting), ...param },
        text: [
          `${setting.key}: ${setting.help}`,
          `value: ${shown(read(ctx, setting))}`,
          `takes: ${param.choices ? param.choices.join(', ') : param.type === 'boolean' ? 'on, off' : param.min !== undefined ? `${param.type} ${param.min} to ${param.max}` : param.type}`,
        ].join('\n'),
      };
    }),
    command('settings', 'set', 'Change a setting', [
      KEY,
      { name: 'value', type: 'string', positional: true, help: 'Its new value (on/off for a switch)' },
    ], (args, ctx) => {
      const setting = find(args.string('key'));
      const raw = args.string('value');
      const value = setting.accepts?.(raw) ? raw : coerce({ ...setting.param, name: setting.key, help: setting.help, positional: true }, raw, ctx.cwd);
      if (setting.set) setting.set(ctx, value);
      else if (setting.field) {
        const field = setting.field;
        ctx.updateConfig((current) => ({ ...current, [field]: value }));
      }
      return { data: value, text: `${setting.key} = ${shown(value)}` };
    }),
    command('settings', 'reset', 'Put a setting back to its default', [KEY], (args, ctx) => {
      const setting = find(args.string('key'));
      if (setting.field) {
        const field = setting.field;
        ctx.updateConfig((current) => {
          const next = { ...current };
          delete next[field];
          return next;
        });
      } else if (setting.key === 'notifications.do-not-disturb') {
        setDoNotDisturb(false);
      }
    }),
  ],
};

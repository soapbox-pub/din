import { getAudioBridge, MAX_VOLUME, type AudioDevices } from '@/lib/audio';
import { getBrightnessBridge, MIN_BRIGHTNESS, MIN_TEMPERATURE, MAX_TEMPERATURE, type NightLightSchedule } from '@/lib/brightness';
import {
  DISPLAY_ROTATIONS,
  getDisplayBridge,
  formatRefresh,
  friendlyOutputName,
  refreshRates,
  rotateInLayout,
  rotationLabel,
  type DisplayPlacement,
  type DisplayRotation,
} from '@/lib/display';
import { MAX_ZOOM, MIN_ZOOM, withDisplayZoom, zoomOf } from '@/lib/displayZoom';
import { getPowerBridge, summarizePower, describePowerProfile } from '@/lib/power';
import {
  LAYOUT_SWITCH_KEYS,
  MAX_KEYBOARD_LAYOUTS,
  getKeyboardBridge,
  layoutKey,
  withLayoutAdded,
  withLayoutRemoved,
  type KeyboardLayoutChoice,
} from '@/lib/keyboard';
import { FOCUS_AREAS, leaveArea, runFocusKey, type FocusKey } from '@/lib/desktopFocus';
import { getDateTimeBridge } from '@/lib/datetime';
import { getPrintingBridge, printFile } from '@/lib/printing';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din sound`, `din brightness`, `din display`, `din power`, `din keyboard`,
 * `din datetime`, `din printers`: Settings' Devices and System sections.
 */

const audio = () => need(getAudioBridge(), 'Sound');
const brightness = () => need(getBrightnessBridge(), 'Brightness');
const keyboard = () => need(getKeyboardBridge(), 'Keyboard layouts');
const ON: Param = { name: 'on', type: 'boolean', positional: true, help: 'on or off' };

function deviceRows(devices: AudioDevices, kind: 'sinks' | 'sources') {
  const inactive = kind === 'sinks' ? devices.inactiveSinks : devices.inactiveSources;
  return [
    ...devices[kind].map((d) => ({ id: String(d.id), name: d.name, default: d.isDefault, volume: d.volume, muted: d.muted })),
    ...inactive.map((p) => ({ id: `${p.card}:${p.port}`, name: p.name, default: false, volume: null, muted: false })),
  ];
}

/** Make an output or input the default, by id or name, switching a card's profile if it must. */
async function selectDevice(kind: 'sinks' | 'sources', query: string) {
  const devices = await call(audio().devices());
  const rows = deviceRows(devices, kind);
  const row = pick(rows, query, (r) => [r.id, r.name], kind === 'sinks' ? 'output' : 'input');
  const port = row.id.includes(':') ? row.id.split(':') : null;
  if (port) await call(audio().selectPort(port[0], port.slice(1).join(':')));
  else await call(audio().setDefault(Number(row.id)));
  return { text: `${kind === 'sinks' ? 'Output' : 'Input'}: ${row.name}` };
}

const LEVEL: Param = { name: 'percent', type: 'integer', positional: true, min: 0, max: MAX_VOLUME, help: 'The volume, in percent' };

export const soundArea: Area = {
  name: 'sound',
  summary: 'Volume, mute, and the speakers and mics in use',
  commands: [
    command('sound', 'status', 'Output and input volume', [], async () => {
      const [output, input] = await Promise.all([call(audio().status()), call(audio().inputStatus())]);
      return {
        data: { output, input },
        text: `output: ${output.volume ?? '?'}%${output.muted ? ' (muted)' : ''}\ninput: ${input.available ? `${input.volume ?? '?'}%${input.muted ? ' (muted)' : ''}` : 'none'}`,
      };
    }),
    command('sound', 'volume', 'Set the output volume', [LEVEL], async (args) => {
      const status = await call(audio().setVolume(args.number('percent')));
      return { data: status, text: `${status.volume}%` };
    }),
    command('sound', 'mute', 'Mute or unmute the output', [ON], async (args) => {
      await call(audio().setMuted(args.bool('on')));
    }),
    command('sound', 'input-volume', 'Set the microphone’s volume', [LEVEL], async (args) => {
      const status = await call(audio().setInputVolume(args.number('percent')));
      return { data: status, text: `${status.volume}%` };
    }),
    command('sound', 'input-mute', 'Mute or unmute the microphone', [ON], async (args) => {
      await call(audio().setInputMuted(args.bool('on')));
    }),
    command('sound', 'outputs', 'Speakers and headphones', [], async () => ({ data: deviceRows(await call(audio().devices()), 'sinks') })),
    command('sound', 'inputs', 'Microphones', [], async () => ({ data: deviceRows(await call(audio().devices()), 'sources') })),
    command('sound', 'output', 'Play sound through an output', [
      { name: 'device', type: 'string', positional: true, help: 'Its id or name, from din sound outputs' },
    ], (args) => selectDevice('sinks', args.string('device'))),
    command('sound', 'input', 'Record from an input', [
      { name: 'device', type: 'string', positional: true, help: 'Its id or name, from din sound inputs' },
    ], (args) => selectDevice('sources', args.string('device'))),
    command('sound', 'apps', 'What’s playing, by app', [], async () => ({ data: (await call(audio().streams())).streams })),
    command('sound', 'app-volume', 'Set one app’s volume', [
      { name: 'id', type: 'integer', positional: true, help: 'Its id, from din sound apps' },
      LEVEL,
    ], async (args) => {
      await call(audio().setNodeVolume(args.number('id'), args.number('percent')));
    }),
    command('sound', 'test', 'Play a test tone through the output', [], async () => {
      const devices = await call(audio().devices());
      const output = devices.sinks.find((d) => d.isDefault);
      if (!output) throw new CommandError('No output to play it through');
      await call(audio().test(output.id));
    }),
  ],
};

export const brightnessArea: Area = {
  name: 'brightness',
  summary: 'Screen brightness and Night Light',
  commands: [
    command('brightness', 'status', 'Brightness and Night Light', [], async () => {
      const status = await call(brightness().status());
      const night = status.nightLight;
      return {
        data: status,
        text: [
          `brightness: ${status.available ? `${status.brightness}%` : 'not adjustable'}`,
          `night light: ${night.enabled ? 'on' : 'off'}${night.active ? ' (tinting now)' : ''}, ${night.temperature}K, ${night.schedule === 'custom' ? `${night.from}–${night.to}` : night.schedule}`,
        ].join('\n'),
      };
    }),
    command('brightness', 'set', 'Set the brightness (below 0 dims the screen further)', [
      { name: 'percent', type: 'integer', positional: true, min: MIN_BRIGHTNESS, max: 100, help: 'The level, in percent' },
    ], async (args) => {
      const status = await call(brightness().setBrightness(args.number('percent')));
      return { data: status.brightness, text: `${status.brightness}%` };
    }),
    command('brightness', 'night-light', 'Turn Night Light on or off', [ON], async (args) => {
      await call(brightness().setNightLight(args.bool('on')));
    }),
    command('brightness', 'temperature', 'Night Light’s warmth, in kelvin (lower is warmer)', [
      { name: 'kelvin', type: 'integer', positional: true, min: MIN_TEMPERATURE, max: MAX_TEMPERATURE, help: 'The color temperature' },
    ], async (args) => {
      await call(brightness().setTemperature(args.number('kelvin')));
    }),
    command('brightness', 'schedule', 'When Night Light runs', [
      { name: 'schedule', type: 'string', positional: true, choices: ['always', 'sunset', 'custom'], help: 'Always, sunset to sunrise, or custom hours' },
      { name: 'from', type: 'string', optional: true, help: 'Custom: when it starts, HH:MM' },
      { name: 'to', type: 'string', optional: true, help: 'Custom: when it ends, HH:MM' },
    ], async (args) => {
      const current = (await call(brightness().status())).nightLight;
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      const from = args.optString('from') ?? current.from;
      const to = args.optString('to') ?? current.to;
      if (!time.test(from) || !time.test(to)) throw new CommandError('--from and --to take HH:MM', 'usage');
      await call(brightness().setNightLightSchedule({ schedule: args.string('schedule') as NightLightSchedule, from, to }));
    }),
  ],
};

export const displayArea: Area = {
  name: 'display',
  summary: 'Monitors: resolution, zoom, rotation, arrangement, which is primary',
  commands: [
    command('display', 'list', 'Connected monitors and their modes', [], async (_args, ctx) => {
      const status = await call(need(getDisplayBridge(), 'Display arrangement').status());
      const zoom = (o: (typeof status.outputs)[number]) => {
        if (!status.perDisplayZoom) return '';
        const { percent, automatic } = zoomOf(o, ctx.config.displayZoom);
        return `, zoom ${percent}%${automatic ? ' (automatic)' : ''}`;
      };
      return {
        data: status.perDisplayZoom
          ? status.outputs.map((o) => ({ ...o, zoom: zoomOf(o, ctx.config.displayZoom) }))
          : status.outputs,
        text: status.outputs.map((o) => [
          `${o.primary ? '*' : ' '} ${o.name} (${friendlyOutputName(o.name)}): ${o.enabled && o.current ? `${o.current.width}x${o.current.height}${o.current.refresh ? ` @ ${formatRefresh(o.current.refresh)}` : ''}${o.rotation ? `, ${rotationLabel(o.rotation, o.current.width, o.current.height).toLowerCase()} (${o.rotation}°)` : ''} at ${o.position.x},${o.position.y}${zoom(o)}` : 'off'}`,
          `    modes: ${[...new Set(o.modes.map((m) => `${m.width}x${m.height}`))].map((size) => {
            const [width, height] = size.split('x').map(Number);
            const rates = refreshRates(o.modes, width, height);
            return rates.length > 1 ? `${size} (${rates.map((r) => formatRefresh(r).replace(' Hz', '')).join('/')} Hz)` : size;
          }).join(' ')}`,
        ].join('\n')).join('\n'),
      };
    }),
    command('display', 'set', 'Change one monitor: its zoom, mode, refresh rate, rotation, position, whether it’s on or primary', [
      { name: 'output', type: 'string', positional: true, help: 'Its name, e.g. HDMI-A-1' },
      { name: 'zoom', type: 'string', optional: true, help: `Its zoom in percent (${MIN_ZOOM} to ${MAX_ZOOM}), remembered for it, or auto for its own (DinOS; elsewhere, din settings set display.zoom)` },
      { name: 'mode', type: 'string', optional: true, help: 'WIDTHxHEIGHT, one it offers' },
      {
        name: 'rotation', type: 'string', optional: true, choices: DISPLAY_ROTATIONS.map(String),
        help: `Degrees: ${DISPLAY_ROTATIONS.map((r) => `${r} ${rotationLabel(r).toLowerCase()}`).join(', ')}`,
      },
      { name: 'refresh', type: 'number', optional: true, help: 'Hz, one it offers at that size (e.g. 165); a new mode alone gets its fastest' },
      { name: 'x', type: 'integer', optional: true, help: 'Its left edge on the shared screen' },
      { name: 'y', type: 'integer', optional: true, help: 'Its top edge' },
      { name: 'enabled', type: 'boolean', optional: true, help: 'On, or off (--no-enabled)' },
      { name: 'primary', type: 'boolean', optional: true, help: 'Make it the primary monitor' },
    ], async (args, ctx) => {
      const bridge = need(getDisplayBridge(), 'Display arrangement');
      const { outputs, perDisplayZoom } = await call(bridge.status());
      const target = pick(outputs, args.string('output'), (o) => [o.name, friendlyOutputName(o.name)], 'monitor');
      const zoom = args.optString('zoom');
      if (zoom !== undefined) {
        if (!perDisplayZoom) throw new CommandError('Monitors can’t each have their own zoom here; din settings set display.zoom zooms the desktop');
        const percent = zoom === 'auto' ? null : Number(zoom.replace(/%$/, ''));
        if (percent !== null && !(Number.isFinite(percent) && percent >= MIN_ZOOM && percent <= MAX_ZOOM)) {
          throw new CommandError(`--zoom takes ${MIN_ZOOM} to ${MAX_ZOOM}, or auto`, 'usage');
        }
        ctx.updateConfig((current) => withDisplayZoom(current, target, percent));
        // Zoom alone: the arrangement stays as it is (AppProvider moves the others beside it).
        if (['mode', 'refresh', 'rotation', 'x', 'y', 'enabled', 'primary'].every((name) => !args.has(name))) return;
      }
      const mode = args.optString('mode');
      const size = mode ? /^(\d+)x(\d+)$/.exec(mode) : null;
      if (mode && !size) throw new CommandError('--mode takes WIDTHxHEIGHT', 'usage');
      if (size && !target.modes.some((m) => m.width === Number(size[1]) && m.height === Number(size[2]))) {
        throw new CommandError(`${target.name} doesn’t offer ${mode}`);
      }
      const targetSize = size
        ? { width: Number(size[1]), height: Number(size[2]) }
        : target.current ?? target.modes.find((m) => m.preferred) ?? target.modes[0] ?? { width: 0, height: 0 };
      const rates = refreshRates(target.modes, targetSize.width, targetSize.height);
      const wanted = args.optNumber('refresh');
      // Near enough: 165 picks 164.999.
      const refresh = wanted === undefined
        ? (size ? rates[0] : undefined)
        : rates.find((r) => Math.abs(r - wanted) < 0.5);
      if (wanted !== undefined && refresh === undefined) {
        throw new CommandError(
          `${target.name} doesn’t offer ${wanted} Hz at ${targetSize.width}x${targetSize.height}${rates.length ? ` (it offers ${rates.map(formatRefresh).join(', ')})` : ''}`,
        );
      }
      const primary = args.optBool('primary') === true;
      const rotation = args.optString('rotation');
      let placements: DisplayPlacement[] = outputs.map((o) => {
        const current = o.current ?? o.modes.find((m) => m.preferred) ?? o.modes[0] ?? { width: 0, height: 0 };
        return {
          output: o.name, enabled: o.enabled, primary: primary ? false : o.primary,
          x: o.position.x, y: o.position.y, width: current.width, height: current.height, rotation: o.rotation ?? 0, scale: o.scale,
        };
      });
      // Turned as Settings turns it: the displays beside it move with its edge.
      if (rotation !== undefined) {
        const turning = placements.find((p) => p.output === target.name);
        if (turning) placements = rotateInLayout(placements, turning, Number(rotation) as DisplayRotation);
      }
      placements = placements.map((base) => {
        if (base.output !== target.name) return base;
        return {
          ...base,
          enabled: args.optBool('enabled') ?? true,
          primary: primary || target.primary,
          x: args.optNumber('x') ?? base.x,
          y: args.optNumber('y') ?? base.y,
          ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
          ...(refresh !== undefined && { refresh }),
        };
      });
      if (!placements.some((p) => p.enabled)) throw new CommandError('That would turn every monitor off');
      if (!placements.some((p) => p.primary && p.enabled)) {
        const first = placements.find((p) => p.enabled);
        if (first) first.primary = true;
      }
      await call(bridge.applyLayout(placements));
    }),
  ],
};

export const powerArea: Area = {
  name: 'power',
  summary: 'Battery, power mode, restarting and shutting down',
  commands: [
    command('power', 'status', 'The battery, and the power mode', [], async () => {
      const bridge = need(getPowerBridge(), 'Power');
      const [status, profiles] = await Promise.all([call(bridge.status()), call(bridge.profiles())]);
      const summary = summarizePower(status);
      return {
        data: { ...status, profiles },
        text: [
          status.available && summary ? `battery: ${summary.percent}%${status.acConnected ? ', plugged in' : ''}` : 'battery: none',
          ...status.devices.map((d) => `${d.label}: ${d.percent ?? '?'}%`),
          profiles.available ? `power mode: ${profiles.active} (of ${profiles.profiles.join(', ')})` : '',
        ].filter(Boolean).join('\n'),
      };
    }),
    command('power', 'mode', 'Switch the power mode', [
      { name: 'profile', type: 'string', positional: true, help: 'e.g. power-saver, balanced, performance' },
    ], async (args) => {
      const bridge = need(getPowerBridge(), 'Power modes');
      const profiles = await call(bridge.profiles());
      const wanted = args.string('profile');
      if (!profiles.profiles.includes(wanted)) throw new CommandError(`Power modes here: ${profiles.profiles.join(', ')}`, 'usage');
      const next = await call(bridge.setProfile(wanted));
      return { text: describePowerProfile(next.active ?? wanted).label };
    }),
    command('power', 'restart', 'Restart the computer (asks on screen first)', [], async (_args, ctx) => {
      const bridge = need(getPowerBridge(), 'Restarting');
      if (!(await ctx.confirm({ title: 'Restart the computer?', description: 'A command asked to restart. Every app closes.', action: 'Restart', destructive: true }))) {
        throw new CommandError('You didn’t allow it');
      }
      await call(bridge.reboot());
    }),
    command('power', 'off', 'Shut the computer down (asks on screen first)', [], async (_args, ctx) => {
      const bridge = need(getPowerBridge(), 'Shutting down');
      if (!(await ctx.confirm({ title: 'Shut down the computer?', description: 'A command asked to shut down. Every app closes.', action: 'Shut Down', destructive: true }))) {
        throw new CommandError('You didn’t allow it');
      }
      await call(bridge.powerOff());
    }),
  ],
};

export const keyboardArea: Area = {
  name: 'keyboard',
  summary: 'The keyboard’s layouts, switching between them, and moving the keyboard about the desktop',
  commands: [
    command('keyboard', 'focus', 'Give the keyboard to a part of the desktop, as Ctrl+F2, F3, F8 and F6 do', [
      { name: 'part', type: 'string', positional: true, choices: [...FOCUS_AREAS, 'window', 'next', 'previous'], help: 'Where it goes; window gives it back to the window' },
    ], (args) => {
      const part = args.string('part');
      if (part === 'window') leaveArea();
      else if (!runFocusKey(part as FocusKey)) throw new CommandError(`The ${part} isn’t on screen`);
    }),
    command('keyboard', 'status', 'The layouts, and the one typing', [], async () => {
      const status = await call(keyboard().status());
      const lines = status.layouts.map((l, i) =>
        `${i === status.active ? '*' : ' '} ${layoutId(l)}\t${l.name}${i === 0 && status.layouts.length > 1 ? ' (default)' : ''}`);
      if (status.restartNeeded) lines.push('Din’s own windows switch after Din restarts');
      return { data: status, text: lines.join('\n') };
    }),
    command('keyboard', 'layouts', 'Every layout there is', [
      { name: 'search', type: 'string', positional: true, optional: true, help: 'Only those whose name has this' },
    ], async (args) => {
      const layouts = await call(keyboard().layouts());
      const q = args.optString('search')?.toLowerCase();
      const shown = q ? layouts.filter((l) => l.name.toLowerCase().includes(q) || l.layout === q) : layouts;
      return { data: shown, text: shown.map((l) => `${layoutId(l)}\t${l.name}`).join('\n') };
    }),
    command('keyboard', 'layout', `Make these the computer’s layouts, one to ${MAX_KEYBOARD_LAYOUTS}; the first is the default`, [
      { name: 'layouts', type: 'string', positional: true, rest: true, help: 'LAYOUT or LAYOUT:VARIANT, e.g. us or us:colemak' },
    ], async (args) => {
      const ids = args.list('layouts');
      if (ids.length === 0 || ids.length > MAX_KEYBOARD_LAYOUTS) throw new CommandError(`Give one to ${MAX_KEYBOARD_LAYOUTS} layouts`, 'usage');
      const found = await Promise.all(ids.map(findLayout));
      await call(keyboard().setLayouts(found.map(({ layout, variant }) => ({ layout, variant }))));
      return { text: found.map((l) => l.name).join(', ') };
    }),
    command('keyboard', 'add', 'Add a layout to switch to', [
      { name: 'layout', type: 'string', positional: true, help: 'LAYOUT or LAYOUT:VARIANT, e.g. de or us:colemak' },
    ], async (args) => {
      const found = await findLayout(args.string('layout'));
      const status = await call(keyboard().status());
      const next = withLayoutAdded(status.layouts, found);
      if (!next) {
        throw new CommandError(status.layouts.some((l) => layoutKey(l) === layoutKey(found))
          ? `${found.name} is already one of the layouts`
          : `The keyboard has ${MAX_KEYBOARD_LAYOUTS} layouts already; remove one first`);
      }
      await call(keyboard().setLayouts(next));
      return { text: `Added ${found.name}` };
    }),
    command('keyboard', 'remove', 'Remove one of the layouts', [
      { name: 'layout', type: 'string', positional: true, help: 'LAYOUT or LAYOUT:VARIANT, as din keyboard status lists them' },
    ], async (args) => {
      const status = await call(keyboard().status());
      const index = indexOfLayout(status.layouts, args.string('layout'));
      const next = withLayoutRemoved(status.layouts, index);
      if (!next) throw new CommandError('That’s the only layout; add another first');
      await call(keyboard().setLayouts(next));
      return { text: `Removed ${status.layouts[index].name}` };
    }),
    command('keyboard', 'switch', `Type with another of the layouts, as ${LAYOUT_SWITCH_KEYS.next} does`, [
      { name: 'layout', type: 'string', positional: true, optional: true, help: 'LAYOUT or LAYOUT:VARIANT, or next (the default) or previous' },
    ], async (args) => {
      const bridge = keyboard();
      const status = await call(bridge.status());
      if (!status.canSwitch) {
        throw new CommandError(status.layouts.length > 1 ? 'Din can’t switch layouts here' : 'There’s only one layout; din keyboard add adds another');
      }
      const which = args.optString('layout') ?? 'next';
      const count = status.layouts.length;
      const index = which === 'next' ? (status.active + 1) % count
        : which === 'previous' ? (status.active + count - 1) % count
          : indexOfLayout(status.layouts, which);
      await call(bridge.select(index));
      return { text: status.layouts[index].name };
    }),
  ],
};

/** LAYOUT or LAYOUT:VARIANT. */
function layoutId(choice: KeyboardLayoutChoice): string {
  return choice.variant ? `${choice.layout}:${choice.variant}` : choice.layout;
}

/** A layout xkeyboard-config has, by LAYOUT or LAYOUT:VARIANT. */
async function findLayout(id: string) {
  const [layout, variant = ''] = id.split(':');
  const found = (await call(keyboard().layouts())).find((l) => l.layout === layout && l.variant === variant);
  if (!found) throw new CommandError(`No layout ${id}; din keyboard layouts lists them`);
  return found;
}

/** Which of LAYOUTS is ID. */
function indexOfLayout(layouts: KeyboardLayoutChoice[], id: string): number {
  const index = layouts.findIndex((l) => layoutId(l) === id);
  if (index < 0) throw new CommandError(`${id} isn’t one of the layouts; din keyboard status lists them`);
  return index;
}

export const datetimeArea: Area = {
  name: 'datetime',
  summary: 'The time zone and the clock (how clocks show it is under din settings)',
  commands: [
    command('datetime', 'status', 'The time zone, and whether the clock sets itself', [], async () => {
      const status = await call(need(getDateTimeBridge(), 'Date & Time').status());
      return { data: { ...status, now: new Date().toString() } };
    }),
    command('datetime', 'zones', 'Every time zone', [
      { name: 'search', type: 'string', positional: true, optional: true, help: 'Only those with this in their name' },
    ], async (args) => {
      const zones = await call(need(getDateTimeBridge(), 'Date & Time').zones());
      const q = args.optString('search')?.toLowerCase();
      const shown = q ? zones.filter((z) => z.toLowerCase().includes(q)) : zones;
      return { data: shown, text: shown.join('\n') };
    }),
    command('datetime', 'zone', 'Set the time zone (turn automatic off first)', [
      { name: 'zone', type: 'string', positional: true, help: 'An IANA name, e.g. America/New_York' },
    ], async (args) => {
      const bridge = need(getDateTimeBridge(), 'Date & Time');
      const zones = await call(bridge.zones());
      if (!zones.includes(args.string('zone'))) throw new CommandError(`No time zone ${args.string('zone')}; din datetime zones lists them`);
      await call(bridge.setZone(args.string('zone')));
    }),
    command('datetime', 'zone-at', 'The time zone at a place', [
      { name: 'latitude', type: 'string', positional: true, help: 'Degrees north, e.g. 29.76' },
      { name: 'longitude', type: 'string', positional: true, help: 'Degrees east, e.g. -95.37' },
    ], async (args) => {
      const latitude = Number(args.string('latitude'));
      const longitude = Number(args.string('longitude'));
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new CommandError('Give the latitude and longitude in degrees', 'usage');
      const zone = await call(need(getDateTimeBridge(), 'Date & Time').zoneAt(latitude, longitude));
      if (!zone) throw new CommandError('No time zone there');
      return { data: zone, text: zone };
    }),
    command('datetime', 'automatic', 'Set the clock from the network and the time zone from where you are, or not', [ON], async (args) => {
      await call(need(getDateTimeBridge(), 'Date & Time').setAutomatic(args.bool('on')));
    }),
    command('datetime', 'set', 'Set the clock by hand (turn automatic off first)', [
      { name: 'time', type: 'string', positional: true, help: 'Local time, "YYYY-MM-DD HH:MM:SS"' },
    ], async (args) => {
      const time = args.string('time');
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) throw new CommandError('Give the time as "YYYY-MM-DD HH:MM:SS"', 'usage');
      await call(need(getDateTimeBridge(), 'Date & Time').setTime(time));
    }),
  ],
};

const printing = () => need(getPrintingBridge(), 'Printing');
const PRINTER: Param = { name: 'printer', type: 'string', positional: true, help: 'Its name' };

export const printersArea: Area = {
  name: 'printers',
  summary: 'Printers and what they’re printing',
  commands: [
    command('printers', 'list', 'Printers, and the print queue', [], async () => {
      const state = await call(printing().state());
      return {
        data: state,
        text: !state.available ? 'Printing isn’t available' : [
          ...state.printers.map((p) => `${p.isDefault ? '*' : ' '} ${p.name}  ${p.state}${p.problem ? ` (${p.problem})` : ''}`),
          ...(state.jobs.length ? ['', 'Queue:', ...state.jobs.map((j) => `  ${j.id}  ${j.printer}  ${j.title}`)] : []),
        ].join('\n'),
      };
    }),
    command('printers', 'find', 'Printers on the network or plugged in that aren’t added', [], async () => ({ data: await call(printing().discover()) })),
    command('printers', 'add', 'Add a printer found with din printers find', [
      { name: 'uri', type: 'string', positional: true, help: 'Its URI' },
    ], async (args) => ({ text: `Added ${await call(printing().add(args.string('uri')))}` })),
    command('printers', 'remove', 'Remove a printer', [PRINTER], async (args) => {
      await call(printing().remove(args.string('printer')));
    }),
    command('printers', 'default', 'Make a printer the default', [PRINTER], async (args) => {
      await call(printing().setDefault(args.string('printer')));
    }),
    command('printers', 'test', 'Print a test page', [PRINTER], async (args) => ({ text: `Job ${await call(printing().testPage(args.string('printer')))}` })),
    command('printers', 'resume', 'Start a stopped printer again', [PRINTER], async (args) => {
      await call(printing().resume(args.string('printer')));
    }),
    command('printers', 'print', 'Open the print dialog for a file', [
      { name: 'file', type: 'path', positional: true, help: 'A PDF, picture or text file' },
    ], async (args) => {
      await call(printFile(args.string('file')));
    }),
    command('printers', 'cancel', 'Cancel a print job', [
      { name: 'job', type: 'string', positional: true, help: 'Its id, from din printers list' },
    ], async (args) => {
      await call(printing().cancelJob(args.string('job')));
    }),
  ],
};

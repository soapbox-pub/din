import { appsArea, browserArea, notificationsArea, openArea, screenshotArea, widgetsArea, windowsArea, workspaceArea } from './desktop';
import { bluetoothArea, torArea, vpnArea, wifiArea } from './connections';
import { disksArea } from './disks';
import { brightnessArea, datetimeArea, displayArea, keyboardArea, powerArea, printersArea, soundArea } from './devices';
import { areaHelp, checkArgs, commandHelp, formatData, overviewHelp, parseArgv, specOf } from './parse';
import { phoneArea } from './phone';
import { settingsArea } from './settings';
import { firmwareArea, lockArea, nostrArea, updateArea } from './system';
import { vmsArea } from './vms';
import { CommandError, type Area, type Command, type CommandContext, type CommandSpec } from './types';
import { cleanError } from './util';

export type { CommandContext, CommandSpec } from './types';

/** Every area of the `din` command, in the order help lists them. */
export const AREAS: readonly Area[] = [
  settingsArea,
  appsArea,
  windowsArea,
  workspaceArea,
  widgetsArea,
  notificationsArea,
  browserArea,
  openArea,
  screenshotArea,
  wifiArea,
  bluetoothArea,
  phoneArea,
  vpnArea,
  torArea,
  soundArea,
  displayArea,
  brightnessArea,
  keyboardArea,
  printersArea,
  disksArea,
  powerArea,
  datetimeArea,
  vmsArea,
  nostrArea,
  updateArea,
  firmwareArea,
  lockArea,
];

/**
 * The area each Settings section's settings are under (a string), or why
 * none is (`{ not: … }`). The parity test fails on a section missing here.
 */
export const SECTION_AREAS: Record<string, string | { not: string }> = {
  wifi: 'wifi',
  bluetooth: 'bluetooth',
  phone: 'phone',
  appearance: 'settings',
  windows: 'settings',
  dock: 'settings',
  notifications: 'notifications',
  assistant: 'settings',
  display: 'display',
  brightness: 'brightness',
  sound: 'sound',
  keyboard: 'keyboard',
  printers: 'printers',
  power: 'power',
  password: { not: 'the password and what sudo asks for are only changed by hand' },
  nostr: 'nostr',
  connected: { not: 'giving apps the signer is only done by hand' },
  datetime: 'datetime',
  about: 'update',
  developers: { not: 'debugging the desktop itself' },
};

/** What a command line came to: text to print and data for --json, or why it failed. */
export type Answer =
  | { ok: true; text: string; data: unknown }
  | { ok: false; error: string; usage: boolean };

export function findCommand(path: readonly string[], areas: readonly Area[] = AREAS): Command | undefined {
  return areas.find((a) => a.name === path[0])?.commands.find((c) => c.path[1] === path[1]);
}

export function describeCommands(areas: readonly Area[] = AREAS): CommandSpec[] {
  return areas.flatMap((area) => area.commands.map(specOf));
}

const HELP = new Set(['-h', '--help', 'help']);

function help(argv: readonly string[], areas: readonly Area[]): Answer {
  const [areaName, verb] = argv;
  if (!areaName) return { ok: true, text: overviewHelp(areas), data: describeCommands(areas) };
  const area = areas.find((a) => a.name === areaName);
  if (!area) return { ok: false, error: `No area ${areaName}; din help lists them`, usage: true };
  if (!verb) return { ok: true, text: areaHelp(area), data: area.commands.map(specOf) };
  const command = area.commands.find((c) => c.path[1] === verb);
  if (!command) return { ok: false, error: `No command din ${areaName} ${verb}; din help ${areaName} lists them`, usage: true };
  return { ok: true, text: commandHelp(command), data: specOf(command) };
}

async function answer(command: Command, run: () => ReturnType<Command['run']>): Promise<Answer> {
  if (command.client) return { ok: false, error: `din ${command.path.join(' ')} runs in the din command itself`, usage: true };
  try {
    const result = (await run()) ?? {};
    return { ok: true, text: result.text ?? formatData(result.data), data: result.data ?? null };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message, usage: error.kind === 'usage' };
    return { ok: false, error: cleanError(error), usage: false };
  }
}

/** Run a `din …` command line. */
export async function runCommandLine(argv: readonly string[], ctx: CommandContext, areas: readonly Area[] = AREAS): Promise<Answer> {
  const [areaName, verb, ...rest] = argv;
  if (!areaName || areaName === 'help' || HELP.has(areaName)) return help(argv.slice(1), areas);
  const area = areas.find((a) => a.name === areaName);
  if (!area) return { ok: false, error: `No area ${areaName}; din help lists them`, usage: true };
  const named = verb ? area.commands.find((c) => c.path[1] === verb) : undefined;
  const own = area.commands.find((c) => c.bare);
  const command = named ?? own;
  const args = named ? rest : argv.slice(1);
  if (!command || (verb && HELP.has(verb) && !named)) {
    if (verb && !HELP.has(verb) && !own) return { ok: false, error: `No command din ${areaName} ${verb}; din help ${areaName} lists them`, usage: true };
    return help([areaName], areas);
  }
  if (args.some((a) => a === '--help' || a === '-h')) return help(command.path, areas);
  return answer(command, () => command.run(parseArgv(command, args, ctx.cwd), ctx));
}

/** Run a command with structured arguments (the Assistant's tools). */
export function runStructured(path: readonly string[], input: Record<string, unknown>, ctx: CommandContext): Promise<Answer> {
  const command = findCommand(path);
  if (!command) return Promise.resolve({ ok: false, error: `No command din ${path.join(' ')}`, usage: true });
  return answer(command, () => command.run(checkArgs(command, input, ctx.cwd), ctx));
}

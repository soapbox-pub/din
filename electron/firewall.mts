// The firewall (window.dinos.firewall - see preload.cjs, and Settings →
// Firewall): which ports the user has let other devices connect to, and
// letting more in or shutting them again.
//
// DinOS's firewall lets in only what Din's own features need (Quick Share,
// AirPlay, LocalSend; os/configuration.nix). Ports for anything else are the
// user's, kept by os/din-firewall.sh in /var/lib/din/firewall and put in the
// firewall each time it starts. That's DinOS's: the launcher names the
// helper in DIN_FIREWALL and the shell's user runs it through sudo without
// a password, like Tor's.
//
// Elsewhere, where firewalld runs (Fedora, RHEL, openSUSE), Din lets ports in
// and shuts them through firewall-cmd, in its default zone, both for now and
// for good, as root through sudo, the password asked for in Din
// (electron/system-packages.mts's runAsAdmin). Reading firewalld's own list
// takes the password too, so the ports Din let in are kept in USER_RULES_FILE
// and those are what Settings shows; others' are firewalld's own to show. Din's
// own features' ports are not in firewalld's defaults, so Settings offers to
// let them in (`features`). Other firewalls (ufw, which Ubuntu leaves off)
// Din leaves alone, and says it can't change.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { runAsAdmin } from './system-packages.mts';
import { CommandError, runCommand, which } from './system.mts';

const HELPER = process.env.DIN_FIREWALL;
/** Where os/din-firewall.sh keeps the user's rules: "protocol ports name" lines. */
const RULES_FILE = '/var/lib/din/firewall';
/** The ports Din let into firewalld, in the same lines. */
const USER_RULES_FILE = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'din', 'firewall');

type Protocol = 'tcp' | 'udp' | 'both';

interface FirewallRule {
  protocol: Protocol;
  /** The first port, and the last of a range (the same for one port). */
  from: number;
  to: number;
  /** What it's for, as the user put it; may be empty. */
  name: string;
}

interface FirewallStatus {
  /** Whether Din can change the firewall here (DinOS, or firewalld). */
  canChange: boolean;
  /** Which firewall Din changes: DinOS's own, or firewalld; null where it doesn't. */
  manager: 'dinos' | 'firewalld' | null;
  /** Whether the firewall is running; null where Din can't tell. */
  active: boolean | null;
  /** The ports the user has let in. */
  rules: FirewallRule[];
}

/**
 * The ports Din's own features listen on, which DinOS lets in itself
 * (os/configuration.nix): Quick Share's, LocalSend's, and AirPlay's for
 * receivers' timing and sound control.
 */
const FEATURE_RULES: FirewallRule[] = [
  { protocol: 'tcp', from: 47331, to: 47331, name: 'Quick Share' },
  { protocol: 'both', from: 53317, to: 53317, name: 'LocalSend' },
  { protocol: 'udp', from: 7010, to: 7039, name: 'AirPlay' },
];

type AssertSender = (event: Electron.IpcMainInvokeEvent) => void;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};

const PROTOCOLS: readonly string[] = ['tcp', 'udp', 'both'];

/** Long enough to type the password into Din's prompt. */
const ADMIN_TIMEOUT_MS = 10 * 60_000;

function parsePorts(ports: string): { from: number; to: number } | null {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(ports);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  return from >= 1 && to <= 65535 && from <= to ? { from, to } : null;
}

function portsOf(rule: Pick<FirewallRule, 'from' | 'to'>): string {
  return rule.from === rule.to ? `${rule.from}` : `${rule.from}-${rule.to}`;
}

function readRules(file: string): FirewallRule[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rules: FirewallRule[] = [];
  for (const line of text.split('\n')) {
    const [protocol, ports, ...name] = line.trim().split(/\s+/);
    const range = ports ? parsePorts(ports) : null;
    if (!PROTOCOLS.includes(protocol) || !range) continue;
    rules.push({ protocol: protocol as Protocol, ...range, name: name.join(' ') });
  }
  return rules.sort((a, b) => a.from - b.from || a.to - b.to || a.protocol.localeCompare(b.protocol));
}

function writeUserRules(rules: FirewallRule[]): void {
  fs.mkdirSync(path.dirname(USER_RULES_FILE), { recursive: true });
  const temp = `${USER_RULES_FILE}.${process.pid}`;
  fs.writeFileSync(temp, rules.map((r) => `${r.protocol} ${portsOf(r)}${r.name ? ` ${r.name}` : ''}\n`).join(''));
  fs.renameSync(temp, USER_RULES_FILE);
}

/** systemd's word on whether a unit runs; null when it can't say. */
async function unitActive(unit: string): Promise<boolean | null> {
  try {
    await runCommand('systemctl', ['is-active', '--quiet', unit], { timeout: 5_000 });
    return true;
  } catch (error) {
    // is-active says no with an exit status; anything else is not knowing.
    return error instanceof CommandError && typeof error.code === 'number' ? false : null;
  }
}

/** Which firewall Din changes here. */
async function manager(): Promise<FirewallStatus['manager']> {
  if (HELPER) return 'dinos';
  if (process.platform === 'linux' && which('firewall-cmd') && (await unitActive('firewalld.service'))) return 'firewalld';
  return null;
}

async function status(): Promise<FirewallStatus> {
  const kind = await manager();
  if (kind === 'dinos') return { canChange: true, manager: kind, active: await unitActive('firewall.service'), rules: readRules(RULES_FILE) };
  if (kind === 'firewalld') return { canChange: true, manager: kind, active: true, rules: readRules(USER_RULES_FILE) };
  return { canChange: false, manager: null, active: null, rules: [] };
}

/** firewall-cmd's port arguments for a rule: "8080/tcp", "8080/udp". */
function firewalldPorts(protocol: Protocol, ports: string): string[] {
  return (protocol === 'both' ? ['tcp', 'udp'] : [protocol]).map((p) => `${ports}/${p}`);
}

/** Add or remove ports in firewalld's default zone, now and for good, in one password. */
async function firewalld(action: 'add' | 'remove', rules: [Protocol, string][]): Promise<void> {
  const ports = rules.flatMap(([protocol, range]) => firewalldPorts(protocol, range));
  const script = `set -e; for port in "$@"; do firewall-cmd --quiet --permanent --${action}-port="$port"; firewall-cmd --quiet --${action}-port="$port"; done`;
  await runAsAdmin(['sh', '-c', script, 'sh', ...ports], ADMIN_TIMEOUT_MS);
}

/** Let rules in, or shut them, in whichever firewall Din changes here. */
async function change(action: 'allow' | 'remove', rules: FirewallRule[]): Promise<FirewallStatus> {
  const kind = await manager();
  if (!kind) throw new Error("Din can't change the firewall on this system");
  try {
    if (kind === 'dinos') {
      for (const rule of rules) {
        const name = action === 'allow' && rule.name ? rule.name.split(' ') : [];
        await runCommand('sudo', ['-n', HELPER!, action, rule.protocol, portsOf(rule), ...name], { timeout: 30_000 });
      }
    } else {
      await firewalld(action === 'allow' ? 'add' : 'remove', rules.map((r) => [r.protocol, portsOf(r)]));
      const same = (a: FirewallRule, b: FirewallRule) => a.protocol === b.protocol && a.from === b.from && a.to === b.to;
      const kept = readRules(USER_RULES_FILE).filter((r) => !rules.some((other) => same(r, other)));
      writeUserRules(action === 'allow' ? [...kept, ...rules] : kept);
    }
  } catch (error) {
    // The helper says what went wrong on its last line.
    const reason = error instanceof CommandError ? error.stderr.trim().split('\n').pop() : '';
    throw reason ? new Error(reason) : error;
  }
  const next = await status();
  sendToShell('firewall:status', next);
  return next;
}

/** The protocol and ports of a rule from the shell, checked, as the helper takes them. */
function ruleArgs(value: unknown): Omit<FirewallRule, 'name'> {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid rule');
  const { protocol, from, to } = value as Record<string, unknown>;
  if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol)) throw new Error('The protocol is tcp, udp or both');
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('Ports are whole numbers');
  const range = parsePorts(from === to ? `${from as number}` : `${from as number}-${to as number}`);
  if (!range) throw new Error('Ports go from 1 to 65535, the lower first');
  return { protocol: protocol as Protocol, ...range };
}

export function registerFirewallHandlers(options: {
  assertShellSender: AssertSender;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;

  ipcMain.handle('firewall:status', (event) => {
    assertShellSender(event);
    return status();
  });

  ipcMain.handle('firewall:allow', (event, rule: unknown) => {
    assertShellSender(event);
    const key = ruleArgs(rule);
    const name = (rule as { name?: unknown }).name ?? '';
    if (typeof name !== 'string') throw new Error('Invalid name');
    // One line in the helper's file: spaces run together, nothing else.
    const clean = name.replace(/\s+/g, ' ').trim();
    if (clean.length > 64) throw new Error('The name is at most 64 characters');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error("The name can't have control characters");
    return change('allow', [{ ...key, name: clean }]);
  });

  ipcMain.handle('firewall:remove', (event, rule: unknown) => {
    assertShellSender(event);
    return change('remove', [{ ...ruleArgs(rule), name: '' }]);
  });

  ipcMain.handle('firewall:allowFeatures', async (event) => {
    assertShellSender(event);
    if ((await manager()) !== 'firewalld') throw new Error('The firewall here lets Din’s features in already');
    return change('allow', FEATURE_RULES);
  });
}

// The firewall (window.dinos.firewall - see preload.cjs, and Settings →
// Firewall): which ports the user has let other devices connect to, and
// letting more in or shutting them again.
//
// DinOS's firewall lets in only what Din's own features need (Quick Share,
// AirPlay, LocalSend; os/configuration.nix). Ports for anything else are the
// user's, kept by os/din-firewall.sh in /var/lib/din/firewall and put in the
// firewall each time it starts. That's DinOS's: the launcher names the
// helper in DIN_FIREWALL and the shell's user runs it through sudo without
// a password, like Tor's. Elsewhere Din leaves the computer's firewall
// alone, and says it can't change it.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import { ipcMain } from 'electron';
import { CommandError, runCommand } from './system.mts';

const HELPER = process.env.DIN_FIREWALL;
/** Where os/din-firewall.sh keeps the user's rules: "protocol ports name" lines. */
const RULES_FILE = '/var/lib/din/firewall';

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
  /** Whether Din can change the firewall here (DinOS). */
  canChange: boolean;
  /** Whether the firewall is running; null where Din can't tell. */
  active: boolean | null;
  /** The ports the user has let in. */
  rules: FirewallRule[];
}

type AssertSender = (event: Electron.IpcMainInvokeEvent) => void;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};

const PROTOCOLS: readonly string[] = ['tcp', 'udp', 'both'];

function parsePorts(ports: string): { from: number; to: number } | null {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(ports);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  return from >= 1 && to <= 65535 && from <= to ? { from, to } : null;
}

function readRules(): FirewallRule[] {
  let text: string;
  try {
    text = fs.readFileSync(RULES_FILE, 'utf8');
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

async function isActive(): Promise<boolean | null> {
  if (!HELPER) return null;
  try {
    await runCommand('systemctl', ['is-active', '--quiet', 'firewall.service'], { timeout: 5_000 });
    return true;
  } catch (error) {
    // is-active says no with an exit status; anything else is not knowing.
    return error instanceof CommandError && typeof error.code === 'number' ? false : null;
  }
}

async function status(): Promise<FirewallStatus> {
  return { canChange: Boolean(HELPER), active: await isActive(), rules: HELPER ? readRules() : [] };
}

async function helper(args: string[]): Promise<FirewallStatus> {
  if (!HELPER) throw new Error("Din can't change the firewall on this system");
  try {
    await runCommand('sudo', ['-n', HELPER, ...args], { timeout: 30_000 });
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
function ruleArgs(value: unknown): [Protocol, string] {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid rule');
  const { protocol, from, to } = value as Record<string, unknown>;
  if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol)) throw new Error('The protocol is tcp, udp or both');
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('Ports are whole numbers');
  const ports = from === to ? `${from as number}` : `${from as number}-${to as number}`;
  if (!parsePorts(ports)) throw new Error('Ports go from 1 to 65535, the lower first');
  return [protocol as Protocol, ports];
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
    const args = ruleArgs(rule);
    const name = (rule as { name?: unknown }).name ?? '';
    if (typeof name !== 'string') throw new Error('Invalid name');
    // One line in the helper's file: spaces run together, nothing else.
    const clean = name.replace(/\s+/g, ' ').trim();
    if (clean.length > 64) throw new Error('The name is at most 64 characters');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error("The name can't have control characters");
    return helper(['allow', ...args, ...(clean ? clean.split(' ') : [])]);
  });

  ipcMain.handle('firewall:remove', (event, rule: unknown) => {
    assertShellSender(event);
    return helper(['remove', ...ruleArgs(rule)]);
  });
}

/**
 * The firewall, through the `window.dinos.firewall` bridge
 * (electron/preload.cjs, backed by electron/firewall.mts): the ports the
 * user has let other devices connect to, and letting more in, on DinOS
 * and where firewalld runs. Din's own features' ports are DinOS's
 * (os/configuration.nix) and aren't listed there; with firewalld, Din lets
 * them in when asked (`allowFeatures`), and lists them with the rest.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getFirewallBridge()`.
 */

export type FirewallProtocol = 'tcp' | 'udp' | 'both';

export interface FirewallRule {
  protocol: FirewallProtocol;
  /** The first port, and the last of a range (the same for one port). */
  from: number;
  to: number;
  /** What it's for, as the user put it; may be empty. */
  name: string;
}

export interface FirewallStatus {
  /** Whether Din can change the firewall here (DinOS, or firewalld). */
  canChange: boolean;
  /** Which firewall Din changes: DinOS's own, or firewalld; null where it doesn't. */
  manager: 'dinos' | 'firewalld' | null;
  /** Whether the firewall is running; null where Din can't tell. */
  active: boolean | null;
  /** The ports the user has let in. */
  rules: FirewallRule[];
}

export type FirewallRuleKey = Pick<FirewallRule, 'protocol' | 'from' | 'to'>;

export interface FirewallBridge {
  status(): Promise<FirewallStatus>;
  allow(rule: FirewallRule): Promise<FirewallStatus>;
  remove(rule: FirewallRuleKey): Promise<FirewallStatus>;
  /** With firewalld: let in the ports Din's own features listen on (Quick Share, LocalSend, AirPlay). */
  allowFeatures(): Promise<FirewallStatus>;
  onStatus(callback: (status: FirewallStatus) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    firewall?: FirewallBridge;
  }
}

/** The firewall bridge, or undefined outside the Electron shell. */
export function getFirewallBridge(): FirewallBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.firewall;
}

export const FIREWALL_PROTOCOLS: readonly FirewallProtocol[] = ['tcp', 'udp', 'both'];

export const PROTOCOL_LABELS: Record<FirewallProtocol, string> = {
  tcp: 'TCP',
  udp: 'UDP',
  both: 'TCP and UDP',
};

/** "53317", or "27000-27015" for a range. */
export function formatPorts(rule: Pick<FirewallRule, 'from' | 'to'>): string {
  return rule.from === rule.to ? String(rule.from) : `${rule.from}-${rule.to}`;
}

/** "TCP 53317", "TCP and UDP 27000-27015". */
export function describeRule(rule: FirewallRuleKey): string {
  return `${PROTOCOL_LABELS[rule.protocol]} ${formatPorts(rule)}`;
}

/** A port, or a range like "27000-27015", or why it isn't one. */
export function parsePorts(text: string): { from: number; to: number } | { error: string } {
  const match = /^\s*(\d{1,5})\s*(?:[-–:]\s*(\d{1,5})\s*)?$/.exec(text);
  if (!match) return { error: 'A port is a number, like 53317, or a range, like 27000-27015' };
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (from < 1 || to > 65535) return { error: 'Ports go from 1 to 65535' };
  if (from > to) return { error: 'A range starts at its lower port' };
  return { from, to };
}

/** The bridge's error without Electron's "Error invoking remote method" wrapper. */
export function cleanFirewallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The ports Din's own features listen on, as electron/firewall.mts lets them into firewalld. */
const FEATURE_RULES: FirewallRuleKey[] = [
  { protocol: 'tcp', from: 47331, to: 47331 },
  { protocol: 'both', from: 53317, to: 53317 },
  { protocol: 'udp', from: 7010, to: 7039 },
];

/** Whether every one of Din's own features' ports is among RULES. */
export function featurePortsAllowed(rules: FirewallRuleKey[]): boolean {
  return FEATURE_RULES.every((f) => rules.some((r) => r.protocol === f.protocol && r.from === f.from && r.to === f.to));
}

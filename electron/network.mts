// The WiFi and VPN bridges (window.wifi, window.vpn - see preload.cjs, the
// Settings app and the network menu).
//
// Thin wrappers around `nmcli` (NetworkManager). The shell's OS user is in
// the `networkmanager` group, so nmcli works without polkit prompts; in a
// plain browser or on a machine without NetworkManager the WiFi bridge
// reports `available: false` and the Settings app renders a fallback.
//
// Saved networks are addressed by their connection UUID, never by name: a
// profile's name is only a label (nmcli makes "SSID 1", "SSID 2" ...), and
// SSIDs can repeat.
//
// A network's proxy is Din's, not NetworkManager's, which has no manual
// proxy and whose PAC setting nothing here reads. It's kept per connection
// UUID in wifi-proxy.json and applied to every Electron session while that
// network is up - the browser, installed apps and the shell itself. Native
// apps don't see it (Android has the same caveat), and nor does the
// browser's Tor session, which goes through Tor alone (electron/tor.mts).
//
// Threat model: same boundaries as the other bridges (strict CSP, the
// sender guard, arguments re-validated here). All nmcli invocations use an
// argv array - no shell, so SSIDs/passwords can't inject commands.
// Passwords do transit argv (briefly visible in /proc/<pid>/cmdline to other
// processes of the same user); acceptable on a single-user machine.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app, ipcMain, session } from 'electron';
import { setOnionProxyTorPort, startOnionProxy } from './onion-proxy.mts';
import { CommandError, runCommand } from './system.mts';

type AssertSender = (event: Electron.IpcMainInvokeEvent) => void;

const NMCLI_TIMEOUT_MS = 15_000;
const NMCLI_CONNECT_TIMEOUT_MS = 60_000;
const WIFI_TYPE = '802-11-wireless';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run nmcli to completion: resolves stdout; rejects with `nmcli-missing`
 * when it isn't installed, else with the first line of its error output.
 */
async function nmcli(args: string[], timeout = NMCLI_TIMEOUT_MS): Promise<string> {
  try {
    return (await runCommand('nmcli', args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (error instanceof CommandError && error.code === 'ENOENT') {
      throw new Error('nmcli-missing', { cause: error });
    }
    const stderr = error instanceof CommandError ? error.stderr : '';
    const detail = (stderr || messageOf(error)).trim().split('\n')[0];
    throw new Error(detail.replace(/^Error:\s*/, '') || 'nmcli failed', { cause: error });
  }
}

/**
 * Split one line of `nmcli -t` list output into fields. Terse mode separates
 * fields with ':' and escapes literal ':' and '\' in values with a backslash.
 */
function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
    } else if (ch === ':') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Non-empty lines of nmcli terse output, split into fields. */
function terseRows(stdout: string): string[][] {
  return stdout.split('\n').filter((line) => line.length > 0).map(splitTerse);
}

/**
 * `nmcli -t connection show <id>...` / `device show` output: one
 * `property:value` per line (values unescaped), a blank line between
 * connections.
 */
function propertyBlocks(stdout: string): Map<string, string>[] {
  const blocks: Map<string, string>[] = [];
  let current = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (line === '') {
      if (current.size > 0) blocks.push(current);
      current = new Map();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) current.set(line.slice(0, colon), line.slice(colon + 1));
  }
  if (current.size > 0) blocks.push(current);
  return blocks;
}

/** Values of an indexed property (`IP4.DNS[1]`, `IP4.DNS[2]`, ...), in order. */
function indexed(props: Map<string, string>, name: string): string[] {
  const values: string[] = [];
  for (let i = 1; props.has(`${name}[${i}]`); i++) values.push(props.get(`${name}[${i}]`) ?? '');
  return values.filter((v) => v !== '');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validString(value: unknown, what: string, max = 256): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || /[\n\r]/.test(value)) {
    throw new Error(`Invalid ${what}`);
  }
  return value;
}

/** Validate a caller-supplied SSID. */
function validSsid(ssid: unknown): string {
  const value = validString(ssid, 'network name', 32 * 4);
  if (value.length === 0 || new TextEncoder().encode(value).length > 32) {
    throw new Error('A network name is 1 to 32 bytes long');
  }
  return value;
}

/** Validate an optional caller-supplied WiFi password. */
function validPassword(password: unknown): string | undefined {
  if (password === undefined || password === null || password === '') return undefined;
  return validString(password, 'password');
}

/** A WPA passphrase: 8 to 63 characters, or a 64-digit hex key. */
function validPsk(password: unknown): string {
  const value = validPassword(password);
  if (value === undefined || !(value.length >= 8 && value.length <= 63) && !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('The password must be 8 to 63 characters');
  }
  return value;
}

function validUuid(uuid: unknown): string {
  if (typeof uuid !== 'string' || !/^[0-9a-fA-F-]{8,64}$/.test(uuid)) {
    throw new Error('Invalid network');
  }
  return uuid;
}

/**
 * Validate a caller-supplied NetworkManager connection name. Names transit
 * argv (no shell), so the concern is only well-formedness, not injection.
 */
function validConnName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128 || name.includes('\0')) {
    throw new Error('Invalid connection name');
  }
  return name;
}

function validIpv4(value: unknown, what: string): string {
  if (typeof value !== 'string' || !net.isIPv4(value)) throw new Error(`Invalid ${what}`);
  return value;
}

function validFile(value: unknown, what: string): string {
  const file = validString(value, what, 4096);
  if (!path.isAbsolute(file)) throw new Error(`Invalid ${what}`);
  return path.normalize(file);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${what}`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Settings model (mirrors src/lib/wifi.ts)
// ---------------------------------------------------------------------------

const SECURITY_TYPES = ['open', 'owe', 'wep', 'wpa-psk', 'sae', 'wpa-eap'] as const;
type WifiSecurity = (typeof SECURITY_TYPES)[number];

const METERED = ['auto', 'yes', 'no'] as const;
type Metered = (typeof METERED)[number];

const MAC_MODES = ['randomized', 'random', 'device', 'default'] as const;
type MacMode = (typeof MAC_MODES)[number];

interface IpSettings {
  method: 'dhcp' | 'static';
  /** Static only. */
  address: string;
  prefix: number;
  gateway: string;
  /** Static, or DHCP with DNS servers of one's own; empty means the network's. */
  dns: string[];
}

const PROXY_MODES = ['none', 'manual', 'pac'] as const;

interface ProxySettings {
  mode: (typeof PROXY_MODES)[number];
  host: string;
  port: number;
  /** Comma-separated hosts that skip the proxy. */
  bypass: string;
  pacUrl: string;
}

const EAP_METHODS = ['peap', 'ttls', 'tls', 'pwd'] as const;
const PHASE2 = ['none', 'mschapv2', 'gtc', 'pap', 'mschap', 'md5'] as const;
const CA_MODES = ['system', 'file', 'none'] as const;

interface EapSettings {
  method: (typeof EAP_METHODS)[number];
  phase2: (typeof PHASE2)[number];
  caMode: (typeof CA_MODES)[number];
  caCert: string;
  domain: string;
  identity: string;
  anonymousIdentity: string;
  /** TLS: the user certificate, and its key (the same file for PKCS#12). */
  clientCert: string;
  privateKey: string;
}

interface SavedWifiNetwork {
  uuid: string;
  name: string;
  ssid: string;
  active: boolean;
  autoconnect: boolean;
  hidden: boolean;
  security: WifiSecurity;
}

/** Map a profile's key-mgmt to the security the UI talks about. */
function securityOf(keyMgmt: string | undefined): WifiSecurity {
  switch (keyMgmt) {
    case undefined:
    case '':
      return 'open';
    case 'none':
      return 'wep';
    case 'owe':
      return 'owe';
    case 'wpa-psk':
      return 'wpa-psk';
    case 'sae':
      return 'sae';
    default:
      // wpa-eap, wpa-eap-suite-b-192, ieee8021x (dynamic WEP)
      return 'wpa-eap';
  }
}

function macModeOf(cloned: string | undefined): MacMode {
  switch (cloned) {
    case 'stable':
      return 'randomized';
    case 'random':
      return 'random';
    case 'permanent':
    case 'preserve':
      return 'device';
    default:
      return 'default';
  }
}

const CLONED_MAC: Record<MacMode, string> = {
  randomized: 'stable',
  random: 'random',
  device: 'permanent',
  default: '',
};

function validIp(raw: unknown): IpSettings {
  if (!isRecord(raw)) throw new Error('Invalid IP settings');
  const method = oneOf(raw.method, ['dhcp', 'static'] as const, 'IP settings');
  if (!Array.isArray(raw.dns) || raw.dns.length > 4) throw new Error('Invalid DNS');
  const dns = raw.dns.map((entry) => {
    if (typeof entry !== 'string' || net.isIP(entry) === 0) throw new Error(`Invalid DNS server "${String(entry)}"`);
    return entry;
  });
  if (method === 'dhcp') return { method, address: '', prefix: 24, gateway: '', dns };
  const prefix = raw.prefix;
  if (typeof prefix !== 'number' || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
    throw new Error('Invalid network prefix length');
  }
  return {
    method,
    address: validIpv4(raw.address, 'IP address'),
    prefix,
    gateway: raw.gateway === '' ? '' : validIpv4(raw.gateway, 'gateway'),
    dns,
  };
}

function validProxy(raw: unknown): ProxySettings {
  if (!isRecord(raw)) throw new Error('Invalid proxy');
  const mode = oneOf(raw.mode, PROXY_MODES, 'proxy');
  const none: ProxySettings = { mode: 'none', host: '', port: 0, bypass: '', pacUrl: '' };
  if (mode === 'none') return none;
  if (mode === 'pac') {
    const url = validString(raw.pacUrl, 'PAC URL', 2048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid PAC URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid PAC URL');
    return { ...none, mode, pacUrl: parsed.href };
  }
  const host = validString(raw.host, 'proxy hostname', 253);
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9a-fA-F:.]+\]$/.test(host)) throw new Error('Invalid proxy hostname');
  const port = raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid proxy port');
  }
  const bypass = validString(raw.bypass ?? '', 'bypass list', 2048);
  if (!/^[A-Za-z0-9.*:/[\]\-_, ]*$/.test(bypass)) throw new Error('Invalid bypass list');
  return { ...none, mode, host, port, bypass };
}

function validEap(raw: unknown): EapSettings {
  if (!isRecord(raw)) throw new Error('Invalid enterprise settings');
  const method = oneOf(raw.method, EAP_METHODS, 'EAP method');
  const caMode = oneOf(raw.caMode, CA_MODES, 'CA certificate');
  const eap: EapSettings = {
    method,
    phase2: method === 'peap' || method === 'ttls' ? oneOf(raw.phase2, PHASE2, 'phase 2 authentication') : 'none',
    caMode,
    caCert: caMode === 'file' ? validFile(raw.caCert, 'CA certificate') : '',
    domain: validString(raw.domain ?? '', 'domain'),
    identity: validString(raw.identity ?? '', 'identity'),
    anonymousIdentity: validString(raw.anonymousIdentity ?? '', 'anonymous identity'),
    clientCert: '',
    privateKey: '',
  };
  if (method === 'tls') {
    eap.clientCert = validFile(raw.clientCert, 'user certificate');
    eap.privateKey = raw.privateKey ? validFile(raw.privateKey, 'private key') : eap.clientCert;
  }
  return eap;
}

/** nmcli property arguments for an IP configuration. */
function ipArgs(ip: IpSettings): string[] {
  const dns = ip.dns.join(' ');
  if (ip.method === 'dhcp') {
    return [
      'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '',
      'ipv4.dns', dns, 'ipv4.ignore-auto-dns', ip.dns.length > 0 ? 'yes' : 'no',
    ];
  }
  return [
    'ipv4.method', 'manual', 'ipv4.addresses', `${ip.address}/${ip.prefix}`,
    'ipv4.gateway', ip.gateway, 'ipv4.dns', dns, 'ipv4.ignore-auto-dns', 'no',
  ];
}

/** nmcli property arguments for an enterprise (802.1X) configuration. */
function eapArgs(eap: EapSettings, password: string | undefined, keyPassword: string | undefined): string[] {
  const args = [
    '802-1x.eap', eap.method,
    '802-1x.identity', eap.identity,
    '802-1x.anonymous-identity', eap.method === 'tls' || eap.method === 'pwd' ? '' : eap.anonymousIdentity,
    '802-1x.domain-suffix-match', eap.domain,
    '802-1x.system-ca-certs', eap.caMode === 'system' ? 'yes' : 'no',
    '802-1x.ca-cert', eap.caMode === 'file' ? eap.caCert : '',
    '802-1x.phase2-auth', '',
    '802-1x.phase2-autheap', '',
  ];
  if (eap.phase2 !== 'none') {
    // TTLS carries GTC and MD5 as an inner EAP method, the rest as plain auth.
    const innerEap = eap.method === 'ttls' && (eap.phase2 === 'gtc' || eap.phase2 === 'md5');
    args.push(innerEap ? '802-1x.phase2-autheap' : '802-1x.phase2-auth', eap.phase2);
  }
  if (eap.method === 'tls') {
    args.push('802-1x.client-cert', eap.clientCert, '802-1x.private-key', eap.privateKey);
    if (keyPassword !== undefined) args.push('802-1x.private-key-password', keyPassword);
  } else {
    args.push('802-1x.client-cert', '', '802-1x.private-key', '');
    if (password !== undefined) args.push('802-1x.password', password);
  }
  return args;
}

/** WEP keys of 5/13 characters or 10/26 hex digits are keys; anything else is a passphrase. */
function wepArgs(key: string): string[] {
  const isKey = key.length === 5 || key.length === 13 || /^([0-9a-fA-F]{10}|[0-9a-fA-F]{26})$/.test(key);
  return ['wifi-sec.wep-key-type', isKey ? 'key' : 'phrase', 'wifi-sec.wep-key0', key];
}

// ---------------------------------------------------------------------------
// Proxies (Din's own, per connection; see the top of the file)
// ---------------------------------------------------------------------------

function proxyFile(): string {
  return path.join(app.getPath('userData'), 'wifi-proxy.json');
}

function readProxies(): Record<string, ProxySettings> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(proxyFile(), 'utf8'));
    if (!isRecord(parsed)) return {};
    const proxies: Record<string, ProxySettings> = {};
    for (const [uuid, value] of Object.entries(parsed)) {
      try {
        proxies[uuid] = validProxy(value);
      } catch {
        // Skip a damaged entry rather than lose the rest.
      }
    }
    return proxies;
  } catch {
    return {};
  }
}

function writeProxy(uuid: string, proxy: ProxySettings | null): void {
  const proxies = readProxies();
  if (proxy && proxy.mode !== 'none') proxies[uuid] = proxy;
  else delete proxies[uuid];
  fs.writeFileSync(proxyFile(), JSON.stringify(proxies, null, 2));
}

const NO_PROXY: ProxySettings = { mode: 'none', host: '', port: 0, bypass: '', pacUrl: '' };

function electronProxyConfig(proxy: ProxySettings): Electron.ProxyConfig {
  if (proxy.mode === 'pac') return { mode: 'pac_script', pacScript: proxy.pacUrl };
  if (proxy.mode === 'manual') {
    const bypass = proxy.bypass.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      mode: 'fixed_servers',
      proxyRules: `${proxy.host}:${proxy.port}`,
      proxyBypassRules: [...bypass, '<local>'].join(','),
    };
  }
  return { mode: 'system' };
}

// Browser tabs on onion services run in a session of their own whose every
// request goes to Tor's SOCKS port (electron/tor.mts), by way of the proxy
// that serves plain-http onion sites as https (electron/onion-proxy.mts),
// and no other session sends anything there. Chromium hands SOCKS5 the
// hostname, and so does that proxy, so nothing resolves an onion address, or
// the clearnet hosts an onion site loads from, outside Tor. The network's
// proxy doesn't apply to that session: Tor is on this machine, and makes its
// own way out.
//
// (A PAC script sending only .onion hosts to Tor would have kept one session,
// but Electron rejects every PAC lookup for a request from a page on a
// standard custom scheme, nsite:// included: electron/electron#53887.)

/** Where Tor is looked for when Din hasn't found one, so onion sites fail rather than go anywhere else. */
const DEFAULT_TOR_SOCKS_PORT = 9050;

/** Tor's SOCKS port, while there's a Tor. */
let torSocksPort: number | null = null;
let torSession: Electron.Session | null = null;

async function applyTorProxy(): Promise<void> {
  if (!torSession) return;
  setOnionProxyTorPort(torSocksPort ?? DEFAULT_TOR_SOCKS_PORT);
  await torSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: `socks5://127.0.0.1:${await startOnionProxy()}`,
    // Even loopback: an onion site has no business with this machine's servers.
    proxyBypassRules: '<-loopback>',
  });
  await torSession.closeAllConnections();
}

/** Point the browser's Tor session at Tor's SOCKS port (null: none found). */
export function setTorSocksPort(port: number | null): void {
  if (port === torSocksPort) return;
  torSocksPort = port;
  void applyTorProxy().catch(() => {});
}

/** Every session the proxy goes to: the ones named by main, plus all created since. */
const proxySessions = new Set<Electron.Session>();
let proxySessionSource: () => Electron.Session[] = () => [];
let appliedProxy = JSON.stringify(NO_PROXY);

async function applyProxy(proxy: ProxySettings, only?: Electron.Session): Promise<void> {
  const config = electronProxyConfig(proxy);
  const targets = only ? [only] : new Set([session.defaultSession, ...proxySessionSource(), ...proxySessions]);
  await Promise.all(
    [...targets].map(async (s) => {
      if (s === torSession) return;
      await s.setProxy(config);
      // Sockets opened under the old proxy would otherwise linger.
      if (!only) await s.closeAllConnections();
    }),
  );
}

/** UUIDs of the active WiFi connections. */
async function activeWifiUuids(): Promise<string[]> {
  const rows = terseRows(await nmcli(['-t', '-f', 'UUID,TYPE', 'connection', 'show', '--active']));
  return rows.filter((r) => r[1] === WIFI_TYPE).map((r) => r[0]);
}

/**
 * Apply the proxy of the WiFi network that's up (or none). Called at
 * startup, on every NetworkManager change, and after the proxy is edited.
 */
export async function refreshWifiProxy(): Promise<void> {
  let uuids: string[] = [];
  try {
    uuids = await activeWifiUuids();
  } catch {
    // No NetworkManager: no network proxies.
  }
  const proxies = readProxies();
  const proxy = uuids.map((uuid) => proxies[uuid]).find((p) => p !== undefined) ?? NO_PROXY;
  const key = JSON.stringify(proxy);
  if (key === appliedProxy) return;
  appliedProxy = key;
  await applyProxy(proxy);
}

// ---------------------------------------------------------------------------
// NetworkManager queries
// ---------------------------------------------------------------------------

/** One NetworkManager device row. */
interface NmDevice {
  iface: string;
  state: string;
  connection: string | null;
}

async function firstDevice(type: string): Promise<NmDevice | null> {
  const rows = terseRows(await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']));
  const row = rows.find((fields) => fields[1] === type);
  if (!row) return null;
  return { iface: row[0], state: row[2], connection: row[3] || null };
}

// ---------------------------------------------------------------------------
// Scanning, and starting the adapter over
//
// A WiFi driver can stop finishing scans (some do after a wake from sleep)
// or fail to attach to its card at boot, and NetworkManager's radio switch
// doesn't touch the card, so neither turning WiFi off and on nor a rescan
// would help. DinOS has a helper, os/din-wifi.sh, which its launcher names in
// DIN_WIFI and the shell's user runs through sudo without a password: it
// resets the cards, whatever their chip, as a reboot would. Turning WiFi on
// runs it, and so does a refresh whose scan never finishes. Elsewhere such a
// refresh fails rather than showing the last scan's networks again.
// ---------------------------------------------------------------------------

const WIFI_HELPER = process.env.DIN_WIFI;
const SCAN_TIMEOUT_MS = 20_000;
const SCAN_RECENT_MS = 5_000;
const SCAN_POLL_MS = 500;
const RESET_TIMEOUT_MS = 60_000;
const WIRELESS_IFACE = 'org.freedesktop.NetworkManager.Device.Wireless';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start every WiFi card over (os/din-wifi.sh). */
async function resetWifi(): Promise<void> {
  if (!WIFI_HELPER) throw new Error("Din can't reset the Wi-Fi adapter on this system");
  try {
    await runCommand('sudo', ['-n', WIFI_HELPER, 'reset'], { timeout: RESET_TIMEOUT_MS });
  } catch (error) {
    // The helper says what went wrong on its last line.
    const reason = error instanceof CommandError ? error.stderr.trim().split('\n').pop() : '';
    throw reason ? new Error(reason) : error;
  }
}

/**
 * When NetworkManager last saw a scan of this interface finish (its
 * LastScan, ms since boot); null when it can't be asked.
 */
async function lastScan(iface: string): Promise<string | null> {
  try {
    const props = propertyBlocks(await nmcli(['-t', '-f', 'GENERAL.DBUS-PATH', 'device', 'show', iface]))[0];
    const dbusPath = props?.get('GENERAL.DBUS-PATH') ?? '';
    if (!dbusPath.startsWith('/org/freedesktop/NetworkManager/')) return null;
    return await nmProperty(dbusPath, WIRELESS_IFACE, 'LastScan');
  } catch {
    return null;
  }
}

/** Milliseconds since boot, counting sleep, as LastScan does (CLOCK_BOOTTIME). */
function bootMs(): number {
  return Number.parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000;
}

/** Ask for a scan, and say whether one finished in time. */
async function scanFinishes(iface: string): Promise<boolean> {
  // NetworkManager may let a rescan asked for just after a scan go, so a
  // scan that finished a moment before counts too.
  const since = bootMs() - SCAN_RECENT_MS;
  const finished = async () => {
    const at = Number.parseInt((await lastScan(iface)) ?? '', 10);
    // Without LastScan there's no telling; trust it.
    return Number.isNaN(at) || at >= since;
  };
  // Failing to start one (one under way already, say) is fine: any scan that finishes counts.
  await nmcli(['device', 'wifi', 'rescan', 'ifname', iface]).catch(() => {});
  for (const deadline = Date.now() + SCAN_TIMEOUT_MS; Date.now() < deadline; ) {
    if (await finished()) return true;
    await wait(SCAN_POLL_MS);
  }
  return finished();
}

/** The WiFi adapter once NetworkManager can scan with it again, after a reset. */
async function readyWifiDevice(): Promise<NmDevice | null> {
  for (const deadline = Date.now() + SCAN_TIMEOUT_MS; Date.now() < deadline; ) {
    const device = await firstDevice('wifi').catch(() => null);
    if (device && device.state !== 'unavailable' && device.state !== 'unmanaged') return device;
    await wait(SCAN_POLL_MS);
  }
  return null;
}

let scanning: Promise<void> | null = null;

/**
 * Scan afresh, resetting the adapter if the scan never finishes; rejects
 * when there's no fresh scan to be had.
 */
function freshScan(): Promise<void> {
  scanning ??= (async () => {
    try {
      if ((await nmcli(['-t', 'radio', 'wifi'])).trim() !== 'enabled') return;
      const device = await firstDevice('wifi');
      if (device && (await scanFinishes(device.iface))) return;
      if (!WIFI_HELPER) {
        throw new Error(device ? "The Wi-Fi adapter didn't finish scanning" : 'No Wi-Fi adapter was found');
      }
      await resetWifi();
      const ready = await readyWifiDevice();
      if (!ready || !(await scanFinishes(ready.iface))) {
        throw new Error("The Wi-Fi adapter didn't finish scanning, even after a reset");
      }
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

/** Saved WiFi profiles (client ones - not hotspots), with their SSIDs. */
async function savedWifiNetworks(): Promise<SavedWifiNetwork[]> {
  const rows = terseRows(
    await nmcli(['-t', '-f', 'NAME,UUID,TYPE,ACTIVE,AUTOCONNECT', 'connection', 'show']),
  ).filter((fields) => fields[2] === WIFI_TYPE);
  if (rows.length === 0) return [];
  const blocks = propertyBlocks(
    await nmcli([
      '-t', '-f',
      'connection.uuid,802-11-wireless.ssid,802-11-wireless.mode,802-11-wireless.hidden,802-11-wireless-security.key-mgmt',
      'connection', 'show',
      ...rows.flatMap((r) => ['uuid', r[1]]),
    ]),
  );
  const byUuid = new Map(blocks.map((b) => [b.get('connection.uuid') ?? '', b]));
  const saved: SavedWifiNetwork[] = [];
  for (const [name, uuid, , active, autoconnect] of rows) {
    const props = byUuid.get(uuid);
    if (!props || (props.get('802-11-wireless.mode') ?? 'infrastructure') !== 'infrastructure') continue;
    saved.push({
      uuid,
      name,
      ssid: props.get('802-11-wireless.ssid') || name,
      active: active === 'yes',
      autoconnect: autoconnect === 'yes',
      hidden: props.get('802-11-wireless.hidden') === 'yes',
      security: securityOf(props.get('802-11-wireless-security.key-mgmt')),
    });
  }
  return saved.sort((a, b) => a.ssid.localeCompare(b.ssid));
}

async function savedByUuid(uuid: string): Promise<SavedWifiNetwork> {
  const network = (await savedWifiNetworks()).find((n) => n.uuid === uuid);
  if (!network) throw new Error('That network is no longer saved');
  return network;
}

/** One saved profile's properties, without secrets unless asked. */
async function connectionProps(uuid: string, secrets = false): Promise<Map<string, string>> {
  const out = await nmcli([
    '-t', ...(secrets ? ['-s'] : []),
    '-f', 'connection,802-11-wireless,802-11-wireless-security,802-1x,ipv4',
    'connection', 'show', 'uuid', uuid,
  ]);
  return propertyBlocks(out)[0] ?? new Map();
}

/** A D-Bus property of a NetworkManager object, via busctl; null when unavailable. */
async function nmProperty(objectPath: string, iface: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand(
      'busctl',
      ['--system', 'get-property', 'org.freedesktop.NetworkManager', objectPath, iface, name],
      { timeout: 5_000 },
    );
    // `u 144400` / `s "08:A1:..."`
    const value = stdout.trim().replace(/^\S+\s+/, '');
    return value.replace(/^"(.*)"$/, '$1');
  } catch {
    return null;
  }
}

interface LiveDetails {
  iface: string;
  signal: number;
  freqMhz: number;
  channel: number;
  bssid: string;
  /** The link's current speed and the access point's best, Mbit/s; 0 when unknown. */
  linkSpeed: number;
  maxSpeed: number;
  security: string;
  macAddress: string;
  deviceMacAddress: string;
  ipAddress: string;
  prefix: number;
  gateway: string;
  dns: string[];
  ipv6Addresses: string[];
}

async function liveDetails(iface: string): Promise<LiveDetails> {
  const [deviceOut, listOut] = await Promise.all([
    nmcli(['-t', '-f', 'GENERAL.HWADDR,GENERAL.DBUS-PATH,IP4,IP6', 'device', 'show', iface]),
    nmcli([
      '-t', '-f', 'IN-USE,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY',
      'device', 'wifi', 'list', 'ifname', iface, '--rescan', 'no',
    ]).catch(() => ''),
  ]);
  const props = propertyBlocks(deviceOut)[0] ?? new Map<string, string>();
  const ap = terseRows(listOut).find((r) => r[0] === '*') ?? [];
  const dbusPath = props.get('GENERAL.DBUS-PATH') ?? '';
  const wireless = 'org.freedesktop.NetworkManager.Device.Wireless';
  const [bitrate, permanent] = dbusPath.startsWith('/org/freedesktop/NetworkManager/')
    ? await Promise.all([
        nmProperty(dbusPath, wireless, 'Bitrate'),
        nmProperty(dbusPath, wireless, 'PermHwAddress'),
      ])
    : [null, null];
  const [address = '', prefix = '0'] = (indexed(props, 'IP4.ADDRESS')[0] ?? '').split('/');
  const macAddress = props.get('GENERAL.HWADDR') ?? '';
  return {
    iface,
    signal: Number.parseInt(ap[5] ?? '', 10) || 0,
    freqMhz: Number.parseInt(ap[3] ?? '', 10) || 0,
    channel: Number.parseInt(ap[2] ?? '', 10) || 0,
    bssid: ap[1] ?? '',
    linkSpeed: Math.round((Number.parseInt(bitrate ?? '', 10) || 0) / 1000),
    maxSpeed: Number.parseInt(ap[4] ?? '', 10) || 0,
    security: (ap[6] ?? '').trim(),
    macAddress,
    deviceMacAddress: permanent || macAddress,
    ipAddress: address,
    prefix: Number.parseInt(prefix, 10) || 0,
    gateway: props.get('IP4.GATEWAY') ?? '',
    dns: [...indexed(props, 'IP4.DNS'), ...indexed(props, 'IP6.DNS')],
    ipv6Addresses: indexed(props, 'IP6.ADDRESS'),
  };
}

async function wifiDetails(uuid: string) {
  const [network, props, activeRows] = await Promise.all([
    savedByUuid(uuid),
    connectionProps(uuid),
    nmcli(['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']).then(terseRows),
  ]);
  const iface = activeRows.find((r) => r[0] === uuid)?.[1] ?? '';
  const [address = '', prefix = '24'] = (props.get('ipv4.addresses') ?? '').split(',')[0].split('/');
  const dns = (props.get('ipv4.dns') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const method = props.get('ipv4.method') === 'manual' ? 'static' : 'dhcp';
  const eapMethod = (props.get('802-1x.eap') ?? '').split(',')[0];
  const phase2 = props.get('802-1x.phase2-autheap') || props.get('802-1x.phase2-auth') || 'none';
  const caCert = props.get('802-1x.ca-cert') ?? '';
  const metered = props.get('connection.metered');

  return {
    ...network,
    settings: {
      autoconnect: props.get('connection.autoconnect') !== 'no',
      metered: (metered === 'yes' ? 'yes' : metered === 'no' ? 'no' : 'auto') as Metered,
      mac: macModeOf(props.get('802-11-wireless.cloned-mac-address')),
      hidden: props.get('802-11-wireless.hidden') === 'yes',
      ip: {
        method,
        address: method === 'static' ? address : '',
        prefix: Number.parseInt(prefix, 10) || 24,
        gateway: method === 'static' ? (props.get('ipv4.gateway') ?? '') : '',
        dns: method === 'static' || props.get('ipv4.ignore-auto-dns') === 'yes' ? dns : [],
      } satisfies IpSettings,
      proxy: readProxies()[uuid] ?? NO_PROXY,
      eap:
        network.security === 'wpa-eap'
          ? ({
              method: (EAP_METHODS as readonly string[]).includes(eapMethod) ? (eapMethod as EapSettings['method']) : 'peap',
              phase2: (PHASE2 as readonly string[]).includes(phase2) ? (phase2 as EapSettings['phase2']) : 'none',
              caMode: caCert ? 'file' : props.get('802-1x.system-ca-certs') === 'yes' ? 'system' : 'none',
              caCert,
              domain: props.get('802-1x.domain-suffix-match') ?? '',
              identity: props.get('802-1x.identity') ?? '',
              anonymousIdentity: props.get('802-1x.anonymous-identity') ?? '',
              clientCert: props.get('802-1x.client-cert') ?? '',
              privateKey: props.get('802-1x.private-key') ?? '',
            } satisfies EapSettings)
          : null,
    },
    live: iface ? await liveDetails(iface).catch(() => null) : null,
  };
}

/** The password a saved network joins with (for sharing it), or null. */
async function wifiSecret(uuid: string): Promise<string | null> {
  const props = await connectionProps(uuid, true);
  const keyMgmt = props.get('802-11-wireless-security.key-mgmt');
  const secret =
    keyMgmt === 'none'
      ? props.get('802-11-wireless-security.wep-key0')
      : keyMgmt === 'wpa-psk' || keyMgmt === 'sae'
        ? props.get('802-11-wireless-security.psk')
        : undefined;
  return secret && secret !== '<hidden>' ? secret : null;
}

/** nmcli's arguments for one security type's password. */
function passwordArgs(security: WifiSecurity, password: string): string[] {
  switch (security) {
    case 'wpa-psk':
    case 'sae':
      return ['wifi-sec.psk', validPsk(password)];
    case 'wep':
      return wepArgs(password);
    case 'wpa-eap':
      return ['802-1x.password', password];
    default:
      return [];
  }
}

/** Bring a saved profile up, rejecting with NetworkManager's reason. */
function activate(uuid: string): Promise<string> {
  return nmcli(['connection', 'up', 'uuid', uuid], NMCLI_CONNECT_TIMEOUT_MS);
}

/** Apply a change set to a saved network; reconnects if it's up and that's needed. */
async function updateWifi(uuid: string, raw: unknown): Promise<void> {
  if (!isRecord(raw)) throw new Error('Invalid changes');
  const network = await savedByUuid(uuid);
  const args: string[] = [];
  let reconnect = false;

  if (raw.autoconnect !== undefined) {
    args.push('connection.autoconnect', raw.autoconnect === true ? 'yes' : 'no');
  }
  if (raw.metered !== undefined) {
    const metered = oneOf(raw.metered, METERED, 'metered setting');
    args.push('connection.metered', metered === 'auto' ? 'unknown' : metered);
  }
  if (raw.mac !== undefined) {
    args.push('802-11-wireless.cloned-mac-address', CLONED_MAC[oneOf(raw.mac, MAC_MODES, 'privacy setting')]);
    reconnect = true;
  }
  if (raw.hidden !== undefined) {
    args.push('802-11-wireless.hidden', raw.hidden === true ? 'yes' : 'no');
  }
  if (raw.ip !== undefined) {
    args.push(...ipArgs(validIp(raw.ip)));
    reconnect = true;
  }
  if (raw.eap !== undefined) {
    if (network.security !== 'wpa-eap') throw new Error('Not an enterprise network');
    args.push(...eapArgs(validEap(raw.eap), validPassword(raw.password), validPassword(raw.keyPassword)));
    reconnect = true;
  } else if (raw.password !== undefined) {
    args.push(...passwordArgs(network.security, validString(raw.password, 'password')));
    reconnect = true;
  }
  const proxy = raw.proxy === undefined ? undefined : validProxy(raw.proxy);

  if (args.length > 0) await nmcli(['connection', 'modify', 'uuid', uuid, ...args]);
  if (proxy !== undefined) {
    writeProxy(uuid, proxy);
    await refreshWifiProxy();
  }
  if (reconnect && network.active) await activate(uuid);
}

/** Save a network typed in by hand (Add network), then try to join it. */
async function addWifi(raw: unknown): Promise<{ uuid: string; connected: boolean; error: string | null }> {
  if (!isRecord(raw)) throw new Error('Invalid network');
  const ssid = validSsid(raw.ssid);
  const security = oneOf(raw.security, SECURITY_TYPES, 'security');
  const password = validPassword(raw.password);
  const args = [
    'connection', 'add', 'type', 'wifi', 'ifname', '*', 'con-name', ssid, 'ssid', ssid,
    '802-11-wireless.hidden', raw.hidden === true ? 'yes' : 'no',
    'connection.autoconnect', raw.autoconnect === false ? 'no' : 'yes',
  ];
  if (raw.metered !== undefined) {
    const metered = oneOf(raw.metered, METERED, 'metered setting');
    args.push('connection.metered', metered === 'auto' ? 'unknown' : metered);
  }
  if (raw.mac !== undefined) {
    const mac = CLONED_MAC[oneOf(raw.mac, MAC_MODES, 'privacy setting')];
    if (mac) args.push('802-11-wireless.cloned-mac-address', mac);
  }
  if (raw.ip !== undefined) args.push(...ipArgs(validIp(raw.ip)));

  switch (security) {
    case 'open':
      break;
    case 'owe':
      args.push('wifi-sec.key-mgmt', 'owe');
      break;
    case 'wep':
      if (password === undefined) throw new Error('Enter the WEP key');
      args.push('wifi-sec.key-mgmt', 'none', ...wepArgs(password));
      break;
    case 'wpa-psk':
    case 'sae':
      args.push('wifi-sec.key-mgmt', security, 'wifi-sec.psk', validPsk(password));
      break;
    case 'wpa-eap':
      args.push('wifi-sec.key-mgmt', 'wpa-eap', ...eapArgs(validEap(raw.eap), password, validPassword(raw.keyPassword)));
      break;
  }
  const proxy = raw.proxy === undefined ? NO_PROXY : validProxy(raw.proxy);

  const out = await nmcli(args);
  const uuid = /\(([0-9a-fA-F-]{36})\)/.exec(out)?.[1];
  if (!uuid) throw new Error('NetworkManager did not save the network');
  if (proxy.mode !== 'none') writeProxy(uuid, proxy);

  // Like Android, a network that's saved stays saved even when it can't be
  // joined right now (out of range, a typo in the password to fix later).
  // Trying to join one that isn't in range would drop the current network
  // first, so only a hidden one (which no scan shows) is tried blind.
  if (raw.hidden !== true) {
    const visible = terseRows(
      await nmcli(['-t', '-f', 'SSID', 'device', 'wifi', 'list', '--rescan', 'no']).catch(() => ''),
    ).some((r) => r[0] === ssid);
    if (!visible) return { uuid, connected: false, error: null };
  }
  try {
    await activate(uuid);
    return { uuid, connected: true, error: null };
  } catch (error) {
    return { uuid, connected: false, error: messageOf(error) };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** One WiFi network as listed by wifi:networks. */
interface WifiNetwork {
  ssid: string;
  inUse: boolean;
  signal: number;
  security: string;
  freqMhz: number;
}

export function registerWifiHandlers(options: {
  assertShellSender: AssertSender;
  /** Sessions the network proxy applies to, besides the default one and those created later. */
  proxySessions: () => Electron.Session[];
  /** The browser's session for onion sites, which goes through Tor instead. */
  torSession: Electron.Session;
}): void {
  const { assertShellSender } = options;
  proxySessionSource = options.proxySessions;
  torSession = options.torSession;
  app.on('session-created', (s) => {
    proxySessions.add(s);
    if (appliedProxy !== JSON.stringify(NO_PROXY)) {
      void applyProxy(JSON.parse(appliedProxy) as ProxySettings, s).catch(() => {});
    }
  });
  void applyTorProxy().catch(() => {});
  void refreshWifiProxy().catch(() => {});

  ipcMain.handle('wifi:status', async (event) => {
    assertShellSender(event);
    try {
      const [device, ethernet, radio] = await Promise.all([
        firstDevice('wifi'),
        firstDevice('ethernet'),
        nmcli(['-t', 'radio', 'wifi']),
      ]);
      return {
        available: true,
        radioEnabled: radio.trim() === 'enabled',
        canReset: Boolean(WIFI_HELPER),
        device,
        ethernet,
      };
    } catch (error) {
      if (messageOf(error) === 'nmcli-missing') {
        return { available: false, radioEnabled: false, canReset: false, device: null, ethernet: null };
      }
      throw error;
    }
  });

  ipcMain.handle('wifi:networks', async (event, rescan) => {
    assertShellSender(event);
    // A refresh lists what a scan it saw finish found, not what's left of the last one.
    if (rescan === true) await freshScan();
    const rows = terseRows(
      await nmcli(
        [
          '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY,FREQ',
          'device', 'wifi', 'list',
          '--rescan', rescan === true ? 'no' : 'auto',
        ],
        30_000,
      ),
    );

    // One entry per SSID (strongest signal wins; hidden networks skipped).
    const bySsid = new Map<string, WifiNetwork>();
    for (const [inUse, ssid, signal, security, freq] of rows) {
      if (!ssid) continue;
      const network: WifiNetwork = {
        ssid,
        inUse: inUse === '*',
        signal: Number.parseInt(signal, 10) || 0,
        // e.g. "WPA2", "WPA1 WPA2", "WPA2 802.1X", "" for open networks.
        security: security.trim(),
        freqMhz: Number.parseInt(freq, 10) || 0,
      };
      const existing = bySsid.get(ssid);
      if (!existing || network.inUse || (!existing.inUse && network.signal > existing.signal)) {
        bySsid.set(ssid, network);
      }
    }

    return [...bySsid.values()].sort(
      (a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal,
    );
  });

  ipcMain.handle('wifi:saved', async (event) => {
    assertShellSender(event);
    try {
      return await savedWifiNetworks();
    } catch (error) {
      if (messageOf(error) === 'nmcli-missing') return [];
      throw error;
    }
  });

  ipcMain.handle('wifi:details', async (event, rawUuid) => {
    assertShellSender(event);
    return wifiDetails(validUuid(rawUuid));
  });

  ipcMain.handle('wifi:secret', async (event, rawUuid) => {
    assertShellSender(event);
    return wifiSecret(validUuid(rawUuid));
  });

  ipcMain.handle('wifi:update', async (event, rawUuid, changes) => {
    assertShellSender(event);
    await updateWifi(validUuid(rawUuid), changes);
  });

  ipcMain.handle('wifi:add', async (event, network) => {
    assertShellSender(event);
    return addWifi(network);
  });

  ipcMain.handle('wifi:connect', async (event, rawSsid, rawPassword) => {
    assertShellSender(event);
    const ssid = validSsid(rawSsid);
    const password = validPassword(rawPassword);
    const saved = (await savedWifiNetworks()).find((n) => n.ssid === ssid);

    if (saved) {
      // Reusing the profile (instead of `device wifi connect`) avoids nmcli
      // piling up duplicate "SSID 1", "SSID 2" profiles.
      if (password !== undefined) {
        await nmcli(['connection', 'modify', 'uuid', saved.uuid, ...passwordArgs(saved.security, password)]);
      }
      await activate(saved.uuid);
      return;
    }

    const args = ['device', 'wifi', 'connect', ssid];
    if (password !== undefined) args.push('password', password);
    try {
      await nmcli(args, NMCLI_CONNECT_TIMEOUT_MS);
    } catch (error) {
      // A failed first attempt (wrong password) leaves a broken profile
      // behind that would shadow the next try; drop it.
      const broken = (await savedWifiNetworks().catch(() => [])).filter((n) => n.ssid === ssid);
      for (const n of broken) await nmcli(['connection', 'delete', 'uuid', n.uuid]).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('wifi:activate', async (event, rawUuid) => {
    assertShellSender(event);
    await activate(validUuid(rawUuid));
  });

  ipcMain.handle('wifi:disconnect', async (event) => {
    assertShellSender(event);
    const device = await firstDevice('wifi');
    if (!device) throw new Error('No WiFi device');
    await nmcli(['device', 'disconnect', device.iface]);
  });

  ipcMain.handle('wifi:forget', async (event, rawUuid) => {
    assertShellSender(event);
    const uuid = validUuid(rawUuid);
    await savedByUuid(uuid);
    await nmcli(['connection', 'delete', 'uuid', uuid]);
    writeProxy(uuid, null);
    await refreshWifiProxy();
  });

  ipcMain.handle('wifi:setRadio', async (event, enabled) => {
    assertShellSender(event);
    if (enabled !== true) {
      await nmcli(['radio', 'wifi', 'off']);
      return;
    }
    // Turning WiFi on starts the adapter over, so that it works again
    // whatever had gone wrong with it. The radio comes on even if that fails.
    let resetError: unknown = null;
    if (WIFI_HELPER) await resetWifi().catch((error: unknown) => (resetError = error));
    await nmcli(['radio', 'wifi', 'on']);
    if (resetError) throw resetError;
  });
}

// ---------------------------------------------------------------------------
// VPN bridge (window.vpn - see preload.cjs / the network selector).
//
// Same nmcli/NetworkManager substrate as the WiFi bridge, scoped to VPN and
// WireGuard connection profiles. The menu can only toggle profiles that
// already exist (imported via `nmcli connection import` / a .ovpn/.conf, or
// the Terminal); it deliberately doesn't create or edit them, which would
// mean handling credentials and per-provider config. `vpn:list` reports [] on
// a machine without NetworkManager so the UI simply shows no VPN section.
// ---------------------------------------------------------------------------

/** Connection types NetworkManager exposes as a VPN in the network menu. */
const VPN_TYPES = new Set(['vpn', 'wireguard']);

/** One saved VPN profile and whether its tunnel is currently up. */
interface VpnConnection {
  name: string;
  /** "vpn" (OpenVPN, IKEv2, ...) or "wireguard". */
  type: string;
  active: boolean;
}

/** Saved VPN/WireGuard connection profiles with their active state. */
async function savedVpnConnections(): Promise<VpnConnection[]> {
  const rows = terseRows(await nmcli(['-t', '-f', 'NAME,TYPE,ACTIVE', 'connection', 'show']));
  return rows
    .filter((fields) => VPN_TYPES.has(fields[1]))
    .map((fields) => ({ name: fields[0], type: fields[1], active: fields[2] === 'yes' }));
}

export function registerVpnHandlers(options: { assertShellSender: AssertSender }): void {
  const { assertShellSender } = options;

  ipcMain.handle('vpn:list', async (event) => {
    assertShellSender(event);
    try {
      return await savedVpnConnections();
    } catch (error) {
      if (messageOf(error) === 'nmcli-missing') return [];
      throw error;
    }
  });

  ipcMain.handle('vpn:connect', async (event, rawName) => {
    assertShellSender(event);
    const name = validConnName(rawName);
    await nmcli(['connection', 'up', 'id', name], NMCLI_CONNECT_TIMEOUT_MS);
  });

  ipcMain.handle('vpn:disconnect', async (event, rawName) => {
    assertShellSender(event);
    const name = validConnName(rawName);
    await nmcli(['connection', 'down', 'id', name]);
  });
}

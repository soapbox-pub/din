/**
 * Typed access to the OS WiFi bridge exposed by the Electron preload
 * (`window.wifi`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by nmcli/NetworkManager in the main process; the shell's OS user is
 * in the `networkmanager` group so no polkit prompts appear. On systems
 * without NetworkManager `status()` resolves with `available: false`.
 *
 * In a plain browser (`make dev-browser`) the bridge is absent; callers must
 * feature-detect via `getWifiBridge()` and render a fallback.
 */

export interface WifiDeviceStatus {
  /** Interface name, e.g. "wlan1". */
  iface: string;
  /** NetworkManager device state, e.g. "connected", "disconnected". */
  state: string;
  /** Name of the active connection profile, or null when not connected. */
  connection: string | null;
}

export interface WifiStatus {
  /** False when NetworkManager/nmcli is not present on the system. */
  available: boolean;
  /** Whether the WiFi radio (rfkill soft switch) is on. */
  radioEnabled: boolean;
  /** The first WiFi adapter, or null when none exists. */
  device: WifiDeviceStatus | null;
  /** The first wired (ethernet) adapter, or null when none exists. */
  ethernet: WifiDeviceStatus | null;
}

/** Whether a wired ethernet link is currently up. */
export function isEthernetConnected(status: WifiStatus | undefined): boolean {
  return status?.ethernet?.state === 'connected';
}

export interface WifiNetwork {
  ssid: string;
  /** True for the network the adapter is currently connected to. */
  inUse: boolean;
  /** Signal strength, 0-100. */
  signal: number;
  /** Security flags as nmcli reports them, e.g. "WPA2"; "" for open. */
  security: string;
  freqMhz: number;
}

/** How a network is secured, in the terms the UI offers. */
export type WifiSecurity = 'open' | 'owe' | 'wep' | 'wpa-psk' | 'sae' | 'wpa-eap';

export const SECURITY_LABELS: Record<WifiSecurity, string> = {
  open: 'None',
  owe: 'Enhanced Open',
  wep: 'WEP',
  'wpa-psk': 'WPA/WPA2-Personal',
  sae: 'WPA3-Personal',
  'wpa-eap': 'WPA/WPA2/WPA3-Enterprise',
};

/** A saved (remembered) network. Saved networks are addressed by `uuid`. */
export interface SavedWifiNetwork {
  uuid: string;
  /** The profile's label; usually the SSID. */
  name: string;
  ssid: string;
  active: boolean;
  autoconnect: boolean;
  hidden: boolean;
  security: WifiSecurity;
}

/** Whether the network counts as metered: decided by the network, or forced. */
export type WifiMetered = 'auto' | 'yes' | 'no';

/**
 * Which MAC address the computer shows the network: one randomized per
 * network, a new one each time it joins, the adapter's own, or whatever
 * the system's default is (the adapter's own on DinOS).
 */
export type WifiMacMode = 'randomized' | 'random' | 'device' | 'default';

export interface WifiIpSettings {
  method: 'dhcp' | 'static';
  /** Static only. */
  address: string;
  /** Network prefix length (24 for 255.255.255.0). Static only. */
  prefix: number;
  /** Static only. */
  gateway: string;
  /** DNS servers of one's own; empty means the network's. */
  dns: string[];
}

export interface WifiProxySettings {
  mode: 'none' | 'manual' | 'pac';
  host: string;
  port: number;
  /** Comma-separated hosts that skip the proxy. */
  bypass: string;
  pacUrl: string;
}

export type EapMethod = 'peap' | 'ttls' | 'tls' | 'pwd';
export type EapPhase2 = 'none' | 'mschapv2' | 'gtc' | 'pap' | 'mschap' | 'md5';

export interface WifiEapSettings {
  method: EapMethod;
  phase2: EapPhase2;
  /** How the network's certificate is checked: against the system's CAs, a CA file, or not at all. */
  caMode: 'system' | 'file' | 'none';
  caCert: string;
  /** The server's domain, checked against its certificate. */
  domain: string;
  identity: string;
  anonymousIdentity: string;
  /** TLS: the user certificate and its private key (the same file for PKCS#12). */
  clientCert: string;
  privateKey: string;
}

export interface WifiSettings {
  autoconnect: boolean;
  metered: WifiMetered;
  mac: WifiMacMode;
  hidden: boolean;
  ip: WifiIpSettings;
  proxy: WifiProxySettings;
  /** Enterprise networks only. */
  eap: WifiEapSettings | null;
}

/** The link as it is right now, for a network that's connected. */
export interface WifiLiveDetails {
  iface: string;
  signal: number;
  freqMhz: number;
  channel: number;
  bssid: string;
  /** Current and best link speed, Mbit/s; 0 when unknown. */
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

export interface WifiDetails extends SavedWifiNetwork {
  settings: WifiSettings;
  live: WifiLiveDetails | null;
}

/** Changes to a saved network; every field optional. */
export interface WifiChanges extends Partial<Omit<WifiSettings, 'eap'>> {
  /** The network's password (WPA/WEP key, or the enterprise password). */
  password?: string;
  eap?: WifiEapSettings;
  /** The TLS private key's password. */
  keyPassword?: string;
}

/** A network entered by hand. */
export interface NewWifiNetwork extends WifiChanges {
  ssid: string;
  security: WifiSecurity;
}

export interface WifiAddResult {
  uuid: string;
  connected: boolean;
  /** Why joining failed (null with `connected: false`: not in range); the network is saved anyway. */
  error: string | null;
}

export interface WifiBridge {
  /** Adapter/radio state. `available: false` when NetworkManager is absent. */
  status(): Promise<WifiStatus>;
  /** Visible networks, one entry per SSID. `rescan` forces a fresh scan. */
  networks(rescan?: boolean): Promise<WifiNetwork[]>;
  /** Saved (remembered) networks. */
  saved(): Promise<SavedWifiNetwork[]>;
  /** A saved network's settings, and its live link details while it's up. */
  details(uuid: string): Promise<WifiDetails>;
  /** The password a saved network joins with, for sharing it; null if none. */
  secret(uuid: string): Promise<string | null>;
  /** Change a saved network's settings (reconnecting it if needed). */
  update(uuid: string, changes: WifiChanges): Promise<void>;
  /** Save a network entered by hand, then try to join it. */
  add(network: NewWifiNetwork): Promise<WifiAddResult>;
  /** Join a network, creating or updating its saved profile. */
  connect(ssid: string, password?: string): Promise<void>;
  /** Join a saved network. */
  activate(uuid: string): Promise<void>;
  /** Disconnect the WiFi adapter from its current network. */
  disconnect(): Promise<void>;
  /** Delete a saved network. */
  forget(uuid: string): Promise<void>;
  /** Turn the WiFi radio on or off. */
  setRadio(enabled: boolean): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    wifi?: WifiBridge;
  }
}

/** The wifi bridge, or undefined when running outside the Electron shell. */
export function getWifiBridge(): WifiBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.wifi;
}

/**
 * Strip Electron's IPC error prefix ("Error invoking remote method
 * 'wifi:connect': Error: ...") so users see just the underlying message.
 */
export function cleanWifiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** Whether a network requires a password to join. */
export function isSecured(network: WifiNetwork): boolean {
  return network.security !== '' && network.security !== '--' && network.security !== 'OWE';
}

/** Whether a scanned network signs in with an account (802.1X) rather than a password. */
export function isEnterprise(network: WifiNetwork): boolean {
  return network.security.includes('802.1X');
}

/** The security type to save a scanned network with. */
export function scannedSecurity(network: WifiNetwork): WifiSecurity {
  const flags = network.security.split(/\s+/);
  if (isEnterprise(network)) return 'wpa-eap';
  if (flags.includes('OWE')) return 'owe';
  if (!isSecured(network)) return 'open';
  if (flags.includes('WEP')) return 'wep';
  if (flags.includes('WPA3') && !flags.includes('WPA2') && !flags.includes('WPA1')) return 'sae';
  return 'wpa-psk';
}

/** The saved network with this SSID, if any. */
export function savedFor(
  saved: SavedWifiNetwork[] | undefined,
  ssid: string,
): SavedWifiNetwork | undefined {
  return saved?.find((n) => n.ssid === ssid);
}

/** "Excellent" / "Good" / ... for a 0-100 signal, as Android puts it. */
export function signalLabel(signal: number): string {
  if (signal >= 75) return 'Excellent';
  if (signal >= 50) return 'Good';
  if (signal >= 25) return 'Fair';
  return 'Poor';
}

/** "2.4 GHz" / "5 GHz" / "6 GHz" for a channel frequency. */
export function bandLabel(freqMhz: number): string {
  if (freqMhz >= 5925) return '6 GHz';
  if (freqMhz >= 5000) return '5 GHz';
  if (freqMhz > 0) return '2.4 GHz';
  return 'Unknown';
}

/** Dotted subnet mask for a prefix length (24 -> 255.255.255.0). */
export function subnetMask(prefix: number): string {
  const bits = prefix <= 0 ? 0 : (0xffffffff << (32 - Math.min(prefix, 32))) >>> 0;
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 0xff).join('.');
}

/** Escape a value for a WIFI: QR payload. */
function qrEscape(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * The `WIFI:` payload phones scan to join a network (the format Android and
 * iOS cameras read), or null for networks that can't be shared that way.
 */
export function wifiQrPayload(network: SavedWifiNetwork, password: string | null): string | null {
  const type =
    network.security === 'wpa-psk' ? 'WPA'
    : network.security === 'sae' ? 'SAE'
    : network.security === 'wep' ? 'WEP'
    : network.security === 'open' || network.security === 'owe' ? 'nopass'
    : null;
  if (type === null || (type !== 'nopass' && !password)) return null;
  const parts = [`T:${type}`, `S:${qrEscape(network.ssid)}`];
  if (type !== 'nopass' && password) parts.push(`P:${qrEscape(password)}`);
  if (network.hidden) parts.push('H:true');
  return `WIFI:${parts.join(';')};;`;
}

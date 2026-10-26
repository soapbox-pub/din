import type {
  EapMethod,
  EapPhase2,
  WifiEapSettings,
  WifiIpSettings,
  WifiMacMode,
  WifiMetered,
  WifiProxySettings,
  WifiSecurity,
} from '@/lib/wifi';

/**
 * The drafts Wi-Fi settings are edited through (see
 * components/desktop/apps/WifiForms.tsx): text as typed, checked here, and
 * turned into the settings the bridge takes once it is valid.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:.]+$/;

export function isIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

/** Why a password won't do for this security, or null. */
export function passwordError(security: WifiSecurity, password: string): string | null {
  if (security === 'wpa-psk' || security === 'sae') {
    if (/^[0-9a-fA-F]{64}$/.test(password)) return null;
    if (password.length < 8) return 'At least 8 characters';
    if (password.length > 63) return 'At most 63 characters';
  }
  if (security === 'wep' && password.length === 0) return 'Enter the WEP key';
  return null;
}

// ---------------------------------------------------------------------------
// Privacy and metered options
// ---------------------------------------------------------------------------

export const METERED_OPTIONS: { value: WifiMetered; label: string }[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'yes', label: 'Treat as metered' },
  { value: 'no', label: 'Treat as unmetered' },
];

export const MAC_OPTIONS: { value: Exclude<WifiMacMode, 'default'>; label: string }[] = [
  { value: 'randomized', label: 'Use randomized MAC' },
  { value: 'random', label: 'Use a new randomized MAC each time' },
  { value: 'device', label: 'Use device MAC' },
];

/** The privacy option to show: "default" is the device's own MAC on DinOS. */
export function shownMac(mode: WifiMacMode): Exclude<WifiMacMode, 'default'> {
  return mode === 'default' ? 'device' : mode;
}

// ---------------------------------------------------------------------------
// IP settings
// ---------------------------------------------------------------------------

export interface IpDraft {
  method: 'dhcp' | 'static';
  address: string;
  prefix: string;
  gateway: string;
  dnsMode: 'auto' | 'custom';
  dns1: string;
  dns2: string;
}

export function ipDraftFrom(ip: WifiIpSettings): IpDraft {
  return {
    method: ip.method,
    address: ip.address,
    prefix: String(ip.prefix || 24),
    gateway: ip.gateway,
    dnsMode: ip.method === 'static' || ip.dns.length > 0 ? 'custom' : 'auto',
    dns1: ip.dns[0] ?? '',
    dns2: ip.dns[1] ?? '',
  };
}

export const DEFAULT_IP: WifiIpSettings = { method: 'dhcp', address: '', prefix: 24, gateway: '', dns: [] };

export function ipErrors(draft: IpDraft): Partial<Record<keyof IpDraft, string>> {
  const errors: Partial<Record<keyof IpDraft, string>> = {};
  if (draft.method === 'static') {
    if (!IPV4.test(draft.address)) errors.address = 'Type a valid IP address';
    const prefix = Number(draft.prefix);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) errors.prefix = 'Type a length from 1 to 32';
    if (draft.gateway && !IPV4.test(draft.gateway)) errors.gateway = 'Type a valid gateway address';
  }
  if (draft.method === 'static' || draft.dnsMode === 'custom') {
    if (draft.method === 'dhcp' && !draft.dns1) errors.dns1 = 'Type a DNS server';
    if (draft.dns1 && !isIp(draft.dns1)) errors.dns1 = 'Type a valid DNS address';
    if (draft.dns2 && !isIp(draft.dns2)) errors.dns2 = 'Type a valid DNS address';
  }
  return errors;
}

/** The settings a draft stands for, or null while it has errors. */
export function ipFromDraft(draft: IpDraft): WifiIpSettings | null {
  if (Object.keys(ipErrors(draft)).length > 0) return null;
  const dns = draft.method === 'static' || draft.dnsMode === 'custom'
    ? [draft.dns1, draft.dns2].filter(Boolean)
    : [];
  return draft.method === 'static'
    ? { method: 'static', address: draft.address, prefix: Number(draft.prefix), gateway: draft.gateway, dns }
    : { method: 'dhcp', address: '', prefix: 24, gateway: '', dns };
}


// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

export interface ProxyDraft {
  mode: WifiProxySettings['mode'];
  host: string;
  port: string;
  bypass: string;
  pacUrl: string;
}

export const NO_PROXY: WifiProxySettings = { mode: 'none', host: '', port: 0, bypass: '', pacUrl: '' };

export function proxyDraftFrom(proxy: WifiProxySettings): ProxyDraft {
  return { ...proxy, port: proxy.port ? String(proxy.port) : '' };
}

export function proxyErrors(draft: ProxyDraft): Partial<Record<keyof ProxyDraft, string>> {
  const errors: Partial<Record<keyof ProxyDraft, string>> = {};
  if (draft.mode === 'manual') {
    if (!/^[A-Za-z0-9.-]+$/.test(draft.host) && !/^\[[0-9a-fA-F:.]+\]$/.test(draft.host)) {
      errors.host = 'Type a valid hostname';
    }
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Type a port from 1 to 65535';
    if (!/^[A-Za-z0-9.*:/[\]\-_, ]*$/.test(draft.bypass)) errors.bypass = 'Separate hosts with commas';
  }
  if (draft.mode === 'pac' && !/^https?:\/\/\S+$/.test(draft.pacUrl)) errors.pacUrl = 'Type an http or https URL';
  return errors;
}

export function proxyFromDraft(draft: ProxyDraft): WifiProxySettings | null {
  if (Object.keys(proxyErrors(draft)).length > 0) return null;
  if (draft.mode === 'manual') return { ...NO_PROXY, mode: 'manual', host: draft.host, port: Number(draft.port), bypass: draft.bypass };
  if (draft.mode === 'pac') return { ...NO_PROXY, mode: 'pac', pacUrl: draft.pacUrl };
  return NO_PROXY;
}


export function proxySummary(proxy: WifiProxySettings): string {
  if (proxy.mode === 'manual') return `${proxy.host}:${proxy.port}`;
  if (proxy.mode === 'pac') return 'Auto-config';
  return 'None';
}

/** One line describing IP settings. */
export function ipSummary(ip: WifiIpSettings): string {
  if (ip.method === 'static') return `Static · ${ip.address}/${ip.prefix}`;
  return ip.dns.length > 0 ? `DHCP · DNS ${ip.dns.join(', ')}` : 'DHCP';
}


// ---------------------------------------------------------------------------
// Enterprise sign-in (802.1X)
// ---------------------------------------------------------------------------

export interface EapDraft extends WifiEapSettings {
  password: string;
  keyPassword: string;
}

export const DEFAULT_EAP: WifiEapSettings = {
  method: 'peap',
  phase2: 'mschapv2',
  caMode: 'system',
  caCert: '',
  domain: '',
  identity: '',
  anonymousIdentity: '',
  clientCert: '',
  privateKey: '',
};

export function eapDraftFrom(eap: WifiEapSettings | null): EapDraft {
  return { ...(eap ?? DEFAULT_EAP), password: '', keyPassword: '' };
}

export const PHASE2_OPTIONS: Record<EapMethod, { value: EapPhase2; label: string }[]> = {
  peap: [
    { value: 'none', label: 'None' },
    { value: 'mschapv2', label: 'MSCHAPV2' },
    { value: 'gtc', label: 'GTC' },
  ],
  ttls: [
    { value: 'none', label: 'None' },
    { value: 'pap', label: 'PAP' },
    { value: 'mschap', label: 'MSCHAP' },
    { value: 'mschapv2', label: 'MSCHAPV2' },
    { value: 'gtc', label: 'GTC' },
  ],
  tls: [],
  pwd: [],
};

export function eapErrors(draft: EapDraft, requirePassword: boolean): Partial<Record<keyof EapDraft, string>> {
  const errors: Partial<Record<keyof EapDraft, string>> = {};
  if (!draft.identity) errors.identity = 'Enter your identity';
  if (draft.caMode === 'file' && !draft.caCert) errors.caCert = 'Choose the CA certificate';
  if (draft.method === 'tls' && !draft.clientCert) errors.clientCert = 'Choose your certificate';
  if (draft.method !== 'tls' && requirePassword && !draft.password) errors.password = 'Enter your password';
  return errors;
}

/** The settings and secrets a draft stands for, or null while it has errors. */
export function eapFromDraft(
  draft: EapDraft,
  requirePassword: boolean,
): { eap: WifiEapSettings; password?: string; keyPassword?: string } | null {
  if (Object.keys(eapErrors(draft, requirePassword)).length > 0) return null;
  const { password, keyPassword, ...eap } = draft;
  const phase2Allowed = PHASE2_OPTIONS[eap.method].some((o) => o.value === eap.phase2);
  return {
    eap: { ...eap, phase2: phase2Allowed ? eap.phase2 : 'none' },
    password: password || undefined,
    keyPassword: keyPassword || undefined,
  };
}


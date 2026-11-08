/**
 * Tor, through the `window.dinos.tor` bridge (electron/preload.cjs, backed by
 * electron/tor.mts): whether Din has found a Tor and how far it has got
 * connecting, turning it on and off on DinOS, and elsewhere setting up a Tor
 * of Din's own. Browser tabs on onion sites
 * run in a session of their own (WEBBROWSER_TOR_PARTITION) that goes through
 * Tor.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getTorBridge()`.
 */

export interface TorStatus {
  /** Whether Din can turn Tor on and off here: DinOS, or where Din has a Tor of its own. */
  canToggle: boolean;
  /** Whether Tor is set to run; null where Din doesn't manage it. */
  enabled: boolean | null;
  /** The SOCKS port of the Tor Din found, or null when there's none. */
  port: number | null;
  /** How far Tor has got connecting, 0-100; null when it doesn't say. */
  progress: number | null;
  /** Tor's word for what it's doing, e.g. "Loading relay descriptors". */
  summary: string | null;
  /** Whether Din can set up a Tor of its own here (not DinOS, which has one). */
  canInstall: boolean;
  /** The version of Din's own Tor ("16.0"), or null where it has none. */
  installed: string | null;
  /** What setting up or updating Din's own Tor is doing, or null. */
  installing: string | null;
  /** Why setting up or running Din's own Tor last failed, or null. */
  error: string | null;
}

export interface TorBridge {
  status(): Promise<TorStatus>;
  refresh(): Promise<TorStatus>;
  setEnabled(enabled: boolean): Promise<TorStatus>;
  /** Set up a Tor of Din's own: the Tor Project's Expert Bundle, in ~/.local/share/din/tor. */
  install(): Promise<TorStatus>;
  onStatus(callback: (status: TorStatus) => void): () => void;
  /** A browser tab's page went to or from an onion site, to be loaded in the other session. */
  onMoveTab(callback: (move: { wcId: number; url: string }) => void): () => void;
  /** Onion hosts with TLS of their own. */
  tlsHosts(): Promise<string[]>;
  onTlsHosts(callback: (hosts: string[]) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    tor?: TorBridge;
  }
}

/** The Tor bridge, or undefined outside the Electron shell. */
export function getTorBridge(): TorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.tor;
}

/** Where Tor stands, for the UI. */
export type TorState = 'off' | 'missing' | 'connecting' | 'ready';

export function torState(status: TorStatus): TorState {
  if (status.port !== null) {
    return status.progress !== null && status.progress < 100 ? 'connecting' : 'ready';
  }
  return status.enabled === false ? 'off' : status.enabled === true ? 'connecting' : 'missing';
}

/** Whether a hostname is on an onion service. */
export function isOnionHost(hostname: string): boolean {
  return /(^|\.)onion\.?$/i.test(hostname);
}

/** Whether a URL is on an onion service. */
export function isOnionUrl(url: string): boolean {
  try {
    return isOnionHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Onion hosts with TLS of their own, kept up to date once something asks. */
const tlsHosts = new Set<string>();
let watchingTlsHosts = false;

function watchTlsHosts(): void {
  const bridge = getTorBridge();
  if (watchingTlsHosts || !bridge) return;
  watchingTlsHosts = true;
  const replace = (hosts: string[]) => {
    tlsHosts.clear();
    for (const host of hosts) tlsHosts.add(host);
  };
  bridge.onTlsHosts(replace);
  bridge.tlsHosts().then(replace, () => {});
}

/**
 * A page's address as the user should see it. Din runs plain-http onion
 * sites as https so their pages are secure contexts, as Tor Browser's are
 * (electron/onion-proxy.mts), but their address is http://, and that's what
 * the address bar, history and copied links say. Sites with TLS of their
 * own keep https://. Anything else comes back as it is.
 */
export function shownUrl(url: string): string {
  if (!/^https:/i.test(url)) return url;
  watchTlsHosts();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.port || !isOnionHost(parsed.hostname) || tlsHosts.has(parsed.hostname.toLowerCase())) return url;
  parsed.protocol = 'http:';
  return parsed.href;
}

/** The bridge's error without Electron's "Error invoking remote method" wrapper. */
export function cleanTorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

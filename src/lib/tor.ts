/**
 * Tor, through the `window.tor` bridge (electron/preload.cjs, backed by
 * electron/tor.mts): whether Din has found a Tor and how far it has got
 * connecting, and turning it on and off on DinOS. Browser tabs on onion sites
 * run in a session of their own (WEBBROWSER_TOR_PARTITION) that goes through
 * Tor.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getTorBridge()`.
 */

export interface TorStatus {
  /** Whether Din can turn Tor on and off here (DinOS). */
  canToggle: boolean;
  /** Whether Tor is set to run; null where Din doesn't manage it. */
  enabled: boolean | null;
  /** The SOCKS port of the Tor Din found, or null when there's none. */
  port: number | null;
  /** How far Tor has got connecting, 0-100; null when it doesn't say. */
  progress: number | null;
  /** Tor's word for what it's doing, e.g. "Loading relay descriptors". */
  summary: string | null;
}

export interface TorBridge {
  status(): Promise<TorStatus>;
  refresh(): Promise<TorStatus>;
  setEnabled(enabled: boolean): Promise<TorStatus>;
  onStatus(callback: (status: TorStatus) => void): () => void;
  /** A browser tab's page went to or from an onion site, to be loaded in the other session. */
  onMoveTab(callback: (move: { wcId: number; url: string }) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    tor?: TorBridge;
  }
}

/** The Tor bridge, or undefined outside the Electron shell. */
export function getTorBridge(): TorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.tor;
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

/** The bridge's error without Electron's "Error invoking remote method" wrapper. */
export function cleanTorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

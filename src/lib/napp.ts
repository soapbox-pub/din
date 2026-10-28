/**
 * Typed access to the napp runtime's shell bridge (`window.dinos.nappHost`, see
 * electron/preload.cjs + electron/napp.mts): what an installed nsite has set
 * up on this computer beyond its files - push subscriptions, periodic sync,
 * ENV - and its service worker asking to open its window. Absent outside the
 * Electron shell.
 */

export interface NappStatus {
  /** Variables its pages read as window.ENV. */
  env: Record<string, string>;
  /** Push subscriptions it holds (window.napp.push). */
  subscriptions: number;
  /** Its periodic sync tags. */
  syncTags: string[];
}

export interface NappHostBridge {
  status(host: string): Promise<NappStatus>;
  setEnv(host: string, env: Record<string, string>): Promise<void>;
  clearData(host: string): Promise<void>;
  onOpen(callback: (request: { host: string; url: string | null }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    nappHost?: NappHostBridge;
  }
}

/** The napp bridge, or undefined outside the Electron shell. */
export function getNappHost(): NappHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.nappHost;
}

/** Variable names window.ENV accepts (as electron/napp.mts checks them). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VARS = 100;
export const MAX_ENV_VALUE = 4096;

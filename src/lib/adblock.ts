/**
 * The Web Browser's built-in ad blocker, through the `window.adblock` bridge
 * (electron/preload.cjs, backed by electron/adblock.mts). The main process
 * owns the settings and does the blocking; the shell only shows and changes
 * them.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getAdblockBridge()` and hide the ad blocker's UI.
 */

export interface AdblockSettings {
  enabled: boolean;
  /** Hostnames ads are allowed on (blocking off). */
  allowlist: string[];
}

export interface AdblockBridge {
  getSettings(): Promise<AdblockSettings>;
  setEnabled(enabled: boolean): Promise<void>;
  setSiteAllowed(hostname: string, allowed: boolean): Promise<void>;
  /** Requests blocked since the tab's page loaded. */
  blockedCount(wcId: number): Promise<number>;
  onSettings(callback: (settings: AdblockSettings) => void): () => void;
  onBlocked(callback: (update: { wcId: number; count: number }) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    adblock?: AdblockBridge;
  }
}

/** The ad blocker bridge, or undefined outside the Electron shell. */
export function getAdblockBridge(): AdblockBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.adblock;
}

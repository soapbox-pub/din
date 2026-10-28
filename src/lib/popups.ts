/**
 * The pop-up blocker, through the `window.dinos.popups` bridge (electron/preload.cjs,
 * backed by electron/popups.mts). The main process decides what opens; the
 * shell shows what was blocked and the sites allowed to open pop-ups.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getPopupsBridge()` and hide the blocker's UI.
 */

export interface PopupSettings {
  /** Hostnames allowed to open pop-ups without a click. */
  allowlist: string[];
}

export interface PopupsBridge {
  getSettings(): Promise<PopupSettings>;
  setSiteAllowed(hostname: string, allowed: boolean): Promise<void>;
  /** Pop-ups blocked since the tab's page loaded. */
  blocked(wcId: number): Promise<string[]>;
  onSettings(callback: (settings: PopupSettings) => void): () => void;
  onBlocked(callback: (update: { wcId: number; urls: string[] }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    popups?: PopupsBridge;
  }
}

/** The pop-up blocker bridge, or undefined outside the Electron shell. */
export function getPopupsBridge(): PopupsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.popups;
}

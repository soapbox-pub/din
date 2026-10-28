/**
 * Typed access to websites' Web Push (`window.dinos.webPushHost`, see
 * electron/preload.cjs + electron/web-push.mts): the push service sites'
 * subscriptions are made with, and their service workers asking for a
 * window after a click on one of their notifications. Absent outside the
 * Electron shell.
 */

export interface WebPushStatus {
  /** The push service in use. */
  url: string;
  /** Mozilla's, used unless the user chose another. */
  defaultUrl: string;
  state: 'idle' | 'connecting' | 'ready';
  connectedAt: number | null;
  lastError: string | null;
  retryAt: number | null;
  /** Subscriptions sites hold, in the Web Browser and installed apps alike. */
  subscriptions: number;
}

export interface WebPushHostBridge {
  status(): Promise<WebPushStatus>;
  /** null: back to the default. Every subscription is dropped. */
  setServer(url: string | null): Promise<void>;
  onChanged(callback: () => void): () => void;
  onOpen(callback: (request: { url: string }) => void): () => void;
  onFocus(callback: (request: { webContentsId: number }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    webPushHost?: WebPushHostBridge;
  }
}

/** The Web Push bridge, or undefined outside the Electron shell. */
export function getWebPushHost(): WebPushHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.webPushHost;
}

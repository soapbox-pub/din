/**
 * Quick Share (`window.dinos.quickShare`): the user's connected Android
 * phones share files and links to this computer from their share sheet, as
 * they do with each other. Run in Electron main by electron/quickshare.mts;
 * this computer is visible over Bluetooth for a little while after one of
 * the user's connected phones opens its share sheet, and the desktop shows
 * each share in a notification (QuickShareHost). Types shared by both sides
 * (main checks every argument itself), and the desktop's getter.
 */

export type QuickShareDeviceType = 'phone' | 'tablet' | 'computer' | 'unknown';

/** Something a nearby device is sharing to this computer, one share's worth, as it goes. */
export interface QuickShareTransfer {
  id: string;
  /** The sender's name, as it calls itself. */
  device: string;
  deviceType: QuickShareDeviceType;
  /** The code both screens show, to tell it's the device in your hand. */
  pin: string;
  /**
   * `asking` until the user accepts or declines; `done` once it's over and
   * something arrived; `declined`, `cancelled` (by either side) or `failed`
   * if nothing did.
   */
  status: 'asking' | 'receiving' | 'done' | 'declined' | 'cancelled' | 'failed';
  /** What it offered: files, or one piece of text or a link. */
  offer: { files: { name: string; size: number }[]; text: { kind: 'text' | 'url'; title: string } | null };
  /** The files saved so far, in Downloads (shared text arrives as a file too). */
  files: { name: string; path: string }[];
  /** Names of files that didn't arrive. */
  failed: string[];
  /** A link it shared, once it's arrived. */
  url: string | null;
  transferred: number;
  total: number;
  /** Why something didn't arrive, in words for the user. */
  error: string | null;
}

/** The desktop's part (`window.dinos.quickShare`): answering and stopping shares. */
export interface QuickShareDesktopBridge {
  /** Take what a device offered (an `asking` transfer's id), or turn it down. */
  respond(id: string, accept: boolean): Promise<void>;
  /** Stop a share that's asking or arriving. */
  cancel(id: string): Promise<void>;
  onTransfer(cb: (transfer: QuickShareTransfer) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    quickShare?: QuickShareDesktopBridge;
  }
}

/** The desktop's Quick Share bridge (QuickShareHost's notifications), or undefined outside Electron. */
export function getQuickShareDesktopBridge(): QuickShareDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.quickShare;
}

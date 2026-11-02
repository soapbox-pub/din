/**
 * Quick Share (`window.dinos.quickShare`): Android phones, tablets and
 * Chromebooks on the same network share files and links to this computer
 * from their share sheet, as they do with each other. Run in Electron main
 * by electron/quickshare.mts. Types shared by both sides (main checks every
 * argument itself), and the desktop's getter.
 */

export interface QuickShareState {
  /** Whether this computer shows up in nearby devices' Quick Share. */
  enabled: boolean;
  /** The name it shows up as. */
  name: string;
  /** Enabled and announced on the network, so devices can see it. */
  visible: boolean;
  /** Why it isn't visible though it's enabled, in words for the user. */
  error: string | null;
}

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

export interface QuickShareBridge {
  state(): Promise<QuickShareState>;
  /** Show up in nearby devices' Quick Share, or stop. */
  setEnabled(on: boolean): Promise<void>;
  /** Take what a device offered (an `asking` transfer's id), or turn it down. */
  respond(id: string, accept: boolean): Promise<void>;
  /** Stop a transfer that's arriving. */
  cancel(id: string): Promise<void>;
  onChanged(cb: (state: QuickShareState) => void): () => void;
  onTransfer(cb: (transfer: QuickShareTransfer) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    quickShare?: QuickShareBridge;
  }
}

/** The desktop's Quick Share bridge (Settings → Phone, notifications, `din phone quick-share`), or undefined outside Electron. */
export function getQuickShareBridge(): QuickShareBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.quickShare;
}

/** Whether a link shared over Quick Share is one Din opens. */
export function isOpenableLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Quick Share (`din.system.quickShare`, for the Quick Share app with the
 * `quickshare` permission): Android phones, tablets and Chromebooks nearby
 * share files and links to this computer from their share sheet, over the
 * network or Bluetooth, as they do with each other. Run in Electron main by
 * electron/quickshare.mts; this computer is visible while a window has asked
 * to receive, and over Bluetooth for a little while after one of the user's
 * connected phones opens its share sheet. Types shared by both sides (main
 * checks every argument itself), and the desktop's getter: it shows shares
 * no window is showing.
 */

export interface QuickShareState {
  /** Whether a window is receiving. */
  listening: boolean;
  /** The name this computer shows up as. */
  name: string;
  /** Announced on the network or over Bluetooth, so devices can see it (because a window is receiving, or a phone opened its share sheet). */
  visible: boolean;
  /** Why it isn't visible though it's receiving, in words for the user. */
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
  /**
   * It arrived with no Quick Share window open (a phone's share sheet made
   * this computer visible): the desktop shows it in a notification, and
   * asks about it there unless it's from one of the user's own phones, and
   * windows leave it alone.
   */
  background: boolean;
}

export interface QuickShareBridge {
  state(): Promise<QuickShareState>;
  /**
   * Be visible to nearby devices until this window closes, reloads or calls
   * `stop` (or, with more than one window receiving, until the last does).
   */
  receive(): Promise<QuickShareState>;
  stop(): Promise<void>;
  /** Take what a device offered (an `asking` transfer's id), or turn it down. */
  respond(id: string, accept: boolean): Promise<void>;
  /** Stop a share that's asking or arriving. */
  cancel(id: string): Promise<void>;
  onChanged(cb: (state: QuickShareState) => void): () => void;
  onTransfer(cb: (transfer: QuickShareTransfer) => void): () => void;
}

/** The desktop's part (`window.dinos.quickShare`): answering and stopping the shares no window is showing. */
export type QuickShareDesktopBridge = Pick<QuickShareBridge, 'respond' | 'cancel' | 'onTransfer'>;

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

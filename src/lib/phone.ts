/**
 * The phone bridge (`window.dinos.phone` on the desktop, `din.system.phone`
 * with the `phone` permission): text messages from the user's phones, run in
 * Electron main by electron/phone.mts. iPhones and Android phones alike
 * connect over Bluetooth's Message Access Profile (electron/phone-map.mts).
 * Types shared by both sides (main checks every argument itself), and the
 * desktop's getter; Messages' is in src/shared/phone.ts.
 */

/** How a phone is reached: Bluetooth, for now the only way. */
export type PhoneKind = 'bluetooth';

export type PhoneStatus = 'connected' | 'connecting' | 'offline';

/** Which kind of phone it is, when Bluetooth can tell. */
export type PhonePlatform = 'iphone' | 'android';

export interface PhoneDevice {
  id: string;
  kind: PhoneKind;
  name: string;
  platform: PhonePlatform | null;
  status: PhoneStatus;
  /** What went wrong last time it tried to connect, in words for the user. */
  error: string | null;
  battery: number | null;
  charging: boolean | null;
  /** Unread messages across its conversations. */
  unread: number;
  /** When it last connected (ms), or null if it never has. */
  lastSeen: number | null;
  /** Whether files it shares over Bluetooth are saved to Downloads (electron/phone-receive.mts). */
  receiveFiles: boolean;
}

/** A phone that could be added: one paired over Bluetooth, or one found on the network. */
export interface PhoneCandidate {
  id: string;
  kind: PhoneKind;
  name: string;
  platform: PhonePlatform | null;
}

export interface PhoneState {
  phones: PhoneDevice[];
  candidates: PhoneCandidate[];
  /** Whether Bluetooth is there to reach phones with. */
  bluetooth: boolean;
}

export interface PhoneMessage {
  id: string;
  phoneId: string;
  threadId: string;
  /** The other people in the conversation (phone numbers or addresses). */
  addresses: string[];
  /** Who sent it, for messages from others: an address, or null for the user's own. */
  sender: string | null;
  body: string;
  /** ms since the epoch. */
  time: number;
  outgoing: boolean;
  read: boolean;
  /** For the user's own: whether it's on its way, sent, or failed. */
  status: 'sending' | 'sent' | 'failed' | null;
  /** Thumbnails of pictures, as data: URLs. */
  images: string[];
}

export interface PhoneConversation {
  phoneId: string;
  threadId: string;
  addresses: string[];
  /** Contact names for the addresses, or the numbers themselves. */
  name: string;
  last: PhoneMessage;
  unread: number;
}

export interface PhoneContact {
  name: string;
  numbers: string[];
}

/** Messages in these conversations changed (arrived, sent, read). */
export interface PhoneMessagesChange {
  phoneId: string;
  threadIds: string[];
}

/** A new message from someone, for a notification. */
export interface PhoneIncoming {
  message: PhoneMessage;
  /** The conversation's name, as the list shows it. */
  name: string;
  /** The sender's name, when it's a group. */
  from: string;
  /** Names for one already announced (contacts arrived after it): change its notification if it's still there, without popping it up again. */
  update?: boolean;
}

/** Files a phone is sharing to this computer, one share's worth, as it goes. */
export interface PhoneReceive {
  id: string;
  phoneId: string;
  phoneName: string;
  /** `done` once the share is over and something arrived; `failed` or `cancelled` if nothing did. */
  status: 'receiving' | 'done' | 'failed' | 'cancelled';
  /** The files saved so far, in Downloads. */
  files: { name: string; path: string }[];
  /** Names of files that didn't arrive. */
  failed: string[];
  /** The file arriving now; `size` is null when the phone didn't say. */
  current: { name: string; transferred: number; size: number | null } | null;
  /** Why something didn't arrive, in words for the user. */
  error: string | null;
}

export interface PhoneBridge {
  state(): Promise<PhoneState>;
  /** Every conversation, newest first; one phone's with `phoneId`. */
  conversations(phoneId?: string): Promise<PhoneConversation[]>;
  /** A conversation's messages, oldest first. */
  messages(phoneId: string, threadId: string): Promise<PhoneMessage[]>;
  contacts(phoneId: string): Promise<PhoneContact[]>;
  /** Send a text to these addresses; resolves with its conversation's id. */
  send(phoneId: string, addresses: string[], body: string): Promise<string>;
  markRead(phoneId: string, threadId: string): Promise<void>;
  /** Forget a conversation on this computer (the phone keeps it). */
  deleteConversation(phoneId: string, threadId: string): Promise<void>;
  /** Ask the phone for what's new, and connect again if it isn't connected. */
  refresh(phoneId: string): Promise<void>;
  /** Stop talking to a phone until `refresh` connects it again (or Din starts again). */
  disconnect(phoneId: string): Promise<void>;
  /** Add a phone paired in Bluetooth, and start connecting to it. */
  add(candidateId: string): Promise<void>;
  /** Remove a phone and its messages from this computer (it stays paired in Bluetooth). */
  forget(phoneId: string): Promise<void>;
  /** Save files the phone shares over Bluetooth to Downloads, or turn them away. */
  setReceiveFiles(phoneId: string, on: boolean): Promise<void>;
  /** Stop files arriving in a share (a PhoneReceive's id). */
  cancelReceive(id: string): Promise<void>;
  onChanged(cb: (state: PhoneState) => void): () => void;
  onMessages(cb: (change: PhoneMessagesChange) => void): () => void;
  onIncoming(cb: (incoming: PhoneIncoming) => void): () => void;
  onReceive(cb: (receive: PhoneReceive) => void): () => void;
}

/** What Messages has of it (`din.system.phone`): the messages, not adding, disconnecting or forgetting phones, or their files. */
export type PhoneAppBridge = Omit<PhoneBridge, 'add' | 'disconnect' | 'forget' | 'setReceiveFiles' | 'cancelReceive' | 'onReceive'>;

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    phone?: PhoneBridge;
  }
}

/** The desktop's phone bridge (Settings → Phone, notifications, `din phone`), or undefined outside Electron. */
export function getPhoneDesktopBridge(): PhoneBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.phone;
}

/** A phone's status line, as Settings and `din phone list` show it. */
export function describePhone(phone: PhoneDevice): string {
  if (phone.status === 'connecting') return 'Connecting…';
  if (phone.status === 'connected') {
    const battery = phone.battery === null ? '' : ` · ${phone.battery}%${phone.charging ? ', charging' : ''}`;
    return `Connected${battery}`;
  }
  if (!phone.lastSeen) return 'Not connected yet. Is it nearby?';
  return `Not connected · last seen ${new Date(phone.lastSeen).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

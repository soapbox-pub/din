/**
 * The phone bridge (`window.dinos.phone` on the desktop, `din.system.phone`
 * with the `phone` permission): text messages from the user's phones, run in
 * Electron main by electron/phone.mts. iPhones connect over Bluetooth's
 * Message Access Profile (electron/phone-map.mts), Android phones over KDE
 * Connect's protocol on the local network (electron/phone-kdeconnect.mts).
 * Types shared by both sides (main checks every argument itself), and the
 * desktop's getter; Messages' is in src/shared/phone.ts.
 */

/** How a phone is reached: Bluetooth (iPhones, any phone with MAP) or KDE Connect (Android). */
export type PhoneKind = 'bluetooth' | 'kdeconnect';

export type PhoneStatus = 'connected' | 'connecting' | 'offline';

export interface PhoneDevice {
  id: string;
  kind: PhoneKind;
  name: string;
  status: PhoneStatus;
  /** What went wrong last time it tried to connect, in words for the user. */
  error: string | null;
  battery: number | null;
  charging: boolean | null;
  /** Whether it sends messages from before it connected (Android does; iPhones only send new ones). */
  history: boolean;
  /** Whether it sends pictures and group conversations. */
  pictures: boolean;
  /** Unread messages across its conversations. */
  unread: number;
  /** When it last connected (ms), or null if it never has. */
  lastSeen: number | null;
}

/** A phone that could be added: one paired over Bluetooth, or one found on the network. */
export interface PhoneCandidate {
  id: string;
  kind: PhoneKind;
  name: string;
}

/** A pairing in progress with an Android phone: compare `key` with the one on its screen. */
export interface PhonePairing {
  id: string;
  name: string;
  key: string;
  /** The phone asked (rather than this computer). */
  incoming: boolean;
}

export interface PhoneState {
  phones: PhoneDevice[];
  candidates: PhoneCandidate[];
  pairing: PhonePairing | null;
  /** Whether Bluetooth is there to reach iPhones with. */
  bluetooth: boolean;
  /** Whether Din is listening for Android phones on the network, and why not if it can't. */
  network: { listening: boolean; error: string | null };
  /** What Android phones see this computer as. */
  name: string;
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
}

export interface PhoneBridge {
  state(): Promise<PhoneState>;
  /** Every conversation, newest first; one phone's with `phoneId`. */
  conversations(phoneId?: string): Promise<PhoneConversation[]>;
  /** A conversation's messages, oldest first; a phone that has history is asked for more. */
  messages(phoneId: string, threadId: string): Promise<PhoneMessage[]>;
  contacts(phoneId: string): Promise<PhoneContact[]>;
  /** Send a text to these addresses; resolves with its conversation's id. */
  send(phoneId: string, addresses: string[], body: string): Promise<string>;
  markRead(phoneId: string, threadId: string): Promise<void>;
  /** Forget a conversation on this computer (the phone keeps it). */
  deleteConversation(phoneId: string, threadId: string): Promise<void>;
  /** Ask the phone for what's new, and connect again if it isn't connected. */
  refresh(phoneId: string): Promise<void>;
  /** Look for Android phones on the network, and take pairing requests from them, while on. */
  discover(on: boolean): Promise<void>;
  /** Add a candidate: a Bluetooth phone starts connecting, an Android phone is asked to pair. */
  add(candidateId: string): Promise<void>;
  /** Accept or turn down the pairing on screen. */
  answer(id: string, accept: boolean): Promise<void>;
  /** Remove a phone, its messages on this computer, and (for Android) the pairing. */
  forget(phoneId: string): Promise<void>;
  onChanged(cb: (state: PhoneState) => void): () => void;
  onMessages(cb: (change: PhoneMessagesChange) => void): () => void;
  onIncoming(cb: (incoming: PhoneIncoming) => void): () => void;
}

/** What Messages has of it (`din.system.phone`): the messages, not adding or forgetting phones. */
export type PhoneAppBridge = Omit<PhoneBridge, 'discover' | 'add' | 'answer' | 'forget'>;

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
  if (!phone.lastSeen) return phone.kind === 'bluetooth' ? 'Not connected yet. Is it nearby?' : 'Not connected yet. Is KDE Connect open on it?';
  return `Not connected · last seen ${new Date(phone.lastSeen).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

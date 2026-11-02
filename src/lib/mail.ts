/**
 * The mail bridge (`din.system.mail`, permission `mail`): IMAP and SMTP
 * accounts, run in Electron main by electron/mail.mts, for the Mail app
 * (src/apps/mail/), and on `window.dinos.mail` the part `din mail` needs.
 * Types shared by both sides (main imports nothing else); main checks every
 * argument itself.
 */

export interface MailServer {
  host: string;
  port: number;
  /** TLS from the start (993, 465); false is STARTTLS. */
  secure: boolean;
  /** The login name; usually the email address. */
  user: string;
}

export interface MailAccount {
  id: string;
  /** What the sidebar calls it: "iCloud", "Work". */
  name: string;
  /** The sender's name on outgoing mail. */
  fullName: string;
  email: string;
  imap: MailServer;
  smtp: MailServer;
  /** Plain text, added below new messages. */
  signature: string;
}

export interface NewMailAccount {
  name: string;
  fullName: string;
  email: string;
  password: string;
  imap: MailServer;
  smtp: MailServer;
}

export interface MailAccountPatch {
  name?: string;
  fullName?: string;
  signature?: string;
  password?: string;
  imap?: MailServer;
  smtp?: MailServer;
}

/** What `discover` found for an address: the servers, and which provider they are. */
export interface MailSettings {
  imap: MailServer;
  smtp: MailServer;
  /** A provider Mail knows (for its setup hints), or null. */
  provider: 'gmail' | 'icloud' | 'outlook' | 'yahoo' | 'aol' | 'fastmail' | 'proton' | null;
  /** Where the settings came from: Mail's own list, Thunderbird's ISPDB, or a guess. */
  source: 'known' | 'ispdb' | 'guess';
}

export type SpecialMailbox = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';

export interface MailboxInfo {
  path: string;
  name: string;
  /** The parent's path, or '' at the top. */
  parent: string;
  delimiter: string;
  special: SpecialMailbox | null;
  /** False for folders that only hold other folders ([Gmail]). */
  selectable: boolean;
  total: number;
  unseen: number;
}

export interface MailAddress {
  name: string;
  address: string;
}

export interface MessageSummary {
  uid: number;
  messageId: string | null;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** Milliseconds since the epoch. */
  date: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  /** The start of the text, or null when it couldn't be read. */
  preview: string | null;
  size: number;
  /** It has a List-Unsubscribe header; unknown (undefined) for summaries kept from before Mail looked. */
  listUnsubscribe?: boolean;
  /** The server's conversation id (Gmail's X-GM-THRID, or OBJECTID's THREADID), where it has one. */
  threadId?: string | null;
  /** The message it answers. */
  inReplyTo?: string | null;
  /**
   * The conversation it's part of, by Message-ID, oldest first (at most
   * the first and last few); undefined for summaries kept from before
   * Mail looked.
   */
  references?: string[];
}

/** A message of a conversation, with the mailbox it's in. */
export interface ConversationMessage {
  path: string;
  summary: MessageSummary;
}

export type MessageFilter = 'unread' | 'flagged' | null;

export interface MessagePage {
  messages: MessageSummary[];
  /** Messages in the mailbox (or matching the search). */
  total: number;
  /** Whether there are older ones; ask again with `before` set to the last uid. */
  more: boolean;
}

export interface MailAttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  /** Shown in the body (a cid: image), not listed below it. */
  inline: boolean;
}

export interface MailMessage extends MessageSummary {
  replyTo: MailAddress[];
  bcc: MailAddress[];
  inReplyTo: string | null;
  references: string[];
  /** The HTML body, unsanitized, with cid: pictures as data: URLs; null for plain text mail. */
  html: string | null;
  text: string;
  attachments: MailAttachmentInfo[];
  /** How to unsubscribe from the list it came from, or null when it doesn't say. */
  unsubscribe: UnsubscribeInfo | null;
}

/**
 * How a list is left (List-Unsubscribe, RFC 2369): a POST to its https link
 * (RFC 8058's one click), a message to its mailto: address, or only a web
 * page for the user to finish on.
 */
export type UnsubscribeMethod = 'one-click' | 'email' | 'web';

export interface UnsubscribeInfo {
  /** The list, the way Mail groups its mail: by List-Id, else the sender. */
  id: string;
  method: UnsubscribeMethod;
  /** The sender's domain passed DKIM, by the account's own server's Authentication-Results. */
  verified: boolean;
  /** When it was unsubscribed from here, or null. */
  unsubscribed: number | null;
}

/** A mailing list that has mailed the inbox: one sender, or one List-Id. */
export interface MailSubscription extends UnsubscribeInfo {
  accountId: string;
  name: string;
  address: string;
  listId: string | null;
  /** Its messages in the inbox in the time looked at. */
  count: number;
  /** The newest one's date, ms. */
  last: number;
  /** Messages that came over two days after unsubscribing: it isn't listening. */
  since: number;
}

export interface SubscriptionScan {
  subscriptions: MailSubscription[];
  /** How far back it looked, ms. */
  from: number;
}

export interface UnsubscribeResult {
  id: string;
  /** done: it's sent; page: only a web page can do it (`url`); failed: `error` says why. */
  status: 'done' | 'page' | 'failed';
  method: UnsubscribeMethod | null;
  url: string | null;
  error: string | null;
  /** Messages moved to the Trash. */
  trashed: number;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutgoingMessage {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
  inReplyTo?: string | null;
  references?: string[];
  /** The message this answers, flagged \Answered once it's sent. */
  answering?: { path: string; uid: number } | null;
  /** A draft this replaces, deleted once it's sent or saved again. */
  draftUid?: number | null;
}

/** Something in a mailbox changed: new mail, flags, a move. */
export interface MailChange {
  accountId: string;
  path: string;
}

export interface MailBridge {
  accounts(): Promise<MailAccount[]>;
  discover(email: string): Promise<MailSettings>;
  /** Signs in to both servers first; rejects with what went wrong. */
  addAccount(account: NewMailAccount): Promise<MailAccount>;
  updateAccount(id: string, patch: MailAccountPatch): Promise<MailAccount>;
  removeAccount(id: string): Promise<void>;
  mailboxes(accountId: string): Promise<MailboxInfo[]>;
  messages(accountId: string, path: string, options?: { before?: number; limit?: number; query?: string; filter?: MessageFilter }): Promise<MessagePage>;
  message(accountId: string, path: string, uid: number): Promise<MailMessage>;
  /**
   * The rest of a conversation, from the inbox, Sent and Archive (All Mail
   * on Gmail): every message with one of `messageIds` as its Message-ID or
   * among its References, or with the server's `threadId`; `since`
   * (milliseconds) bounds how far back to look. Oldest first.
   */
  conversation(accountId: string, options: { messageIds: string[]; threadId?: string | null; since?: number }): Promise<ConversationMessage[]>;
  attachment(accountId: string, path: string, uid: number, index: number): Promise<MailAttachment>;
  setFlags(accountId: string, path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>;
  /** Move to a mailbox by path, or to the account's archive, trash or junk. */
  move(accountId: string, path: string, uids: number[], to: string | { special: 'archive' | 'trash' | 'junk' | 'inbox' }): Promise<void>;
  /** To the trash; from the trash, gone for good. */
  remove(accountId: string, path: string, uids: number[]): Promise<void>;
  send(accountId: string, message: OutgoingMessage): Promise<void>;
  /** Resolves with the draft's uid in Drafts, when the server says. */
  saveDraft(accountId: string, message: OutgoingMessage): Promise<number | null>;
  /** The mailing lists in the inbox over the last `months` (default 6), most mail first. */
  subscriptions(accountId: string, options?: { months?: number }): Promise<SubscriptionScan>;
  /**
   * Leave these lists (by `MailSubscription.id`), each the best way it
   * offers, and with `trash` move their mail in the inbox to the Trash.
   */
  unsubscribe(accountId: string, ids: string[], options?: { trash?: boolean }): Promise<UnsubscribeResult[]>;
  /** Leave the list one message came from. */
  unsubscribeMessage(accountId: string, path: string, uid: number): Promise<UnsubscribeResult>;
  onChanged(cb: (change: MailChange) => void): () => void;
}

/** New unread mail in an inbox, for a notification. */
export interface MailArrival {
  accountId: string;
  /** The account's name in Mail's sidebar. */
  accountName: string;
  path: string;
  uid: number;
  from: MailAddress[];
  subject: string;
  preview: string | null;
  date: number;
}

/** Announced mail that's been read, moved or deleted: its notification goes. */
export interface MailRead {
  accountId: string;
  path: string;
  uids: number[];
}

/**
 * What the desktop has of it: the mailing lists, for `din mail`; and new
 * mail and each inbox's unread count, watched from the moment Din starts,
 * for notifications and Mail's Dock badge.
 */
export type MailDesktopBridge = Pick<MailBridge, 'accounts' | 'subscriptions' | 'unsubscribe'> & {
  /** Each account's unread mail in its inbox, as last counted. */
  unseen(): Promise<Record<string, number>>;
  onUnseen(cb: (unseen: Record<string, number>) => void): () => void;
  onArrived(cb: (arrival: MailArrival) => void): () => void;
  onRead(cb: (read: MailRead) => void): () => void;
};

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    mail?: MailDesktopBridge;
  }
}

/** The desktop's mail bridge (`din mail`), or undefined outside Electron. */
export function getMailDesktopBridge(): MailDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.mail;
}

/** How a list is left, in words, as Mail and `din mail` show it. */
export const UNSUBSCRIBE_METHODS: Record<UnsubscribeMethod, string> = {
  'one-click': 'One click',
  email: 'By email',
  web: 'Needs a web page',
};

/**
 * The mail bridge (`din.system.mail`, permission `mail`): IMAP and SMTP
 * accounts, run in Electron main by electron/mail.mts, for the Mail app
 * (src/apps/mail/). Types only, shared by both sides; main checks every
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
  attachment(accountId: string, path: string, uid: number, index: number): Promise<MailAttachment>;
  setFlags(accountId: string, path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>;
  /** Move to a mailbox by path, or to the account's archive, trash or junk. */
  move(accountId: string, path: string, uids: number[], to: string | { special: 'archive' | 'trash' | 'junk' | 'inbox' }): Promise<void>;
  /** To the trash; from the trash, gone for good. */
  remove(accountId: string, path: string, uids: number[]): Promise<void>;
  send(accountId: string, message: OutgoingMessage): Promise<void>;
  /** Resolves with the draft's uid in Drafts, when the server says. */
  saveDraft(accountId: string, message: OutgoingMessage): Promise<number | null>;
  onChanged(cb: (change: MailChange) => void): () => void;
}

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
  /** Kept for older copies of Din; Mail calls an account by its address. */
  name: string;
  /** The sender's name on outgoing mail. */
  fullName: string;
  email: string;
  imap: MailServer;
  smtp: MailServer;
  /** Plain text, added below new messages. */
  signature: string;
  /** Its color in Mail, kept on this computer; until it's given one, Mail picks one by its place in the list. */
  color?: LabelColor | null;
  /**
   * Whether verification codes in its new mail are offered in web pages'
   * code fields, and on their notifications (electron/verification-codes.mts);
   * on unless it's false.
   */
  fillCodes?: boolean;
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
  /** Null gives the account back the color Mail picks. */
  color?: LabelColor | null;
  fillCodes?: boolean;
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
  /** The account's server says DKIM passed for the From domain; undefined for summaries kept from before Mail looked. */
  senderVerified?: boolean;
  /**
   * Its labels, by `MailLabel.id`: Gmail's (leaving out the system ones,
   * and the label of the mailbox it was read from), or its IMAP keywords
   * elsewhere; undefined for summaries kept from before Mail looked.
   */
  labels?: string[];
  /**
   * Its inbox tab, as Gmail sorts it there (Gmail's own on Gmail, Mail's
   * guess from its headers elsewhere), before the user's rules and which
   * tabs are shown; for the inbox's messages, undefined for summaries kept
   * from before Mail looked.
   */
  category?: MailCategory;
  /**
   * The version of Mail's own sorting that guessed `category`
   * (electron/mail-categories.mts's SORTER_VERSION), so mail sorted by
   * older rules is sorted again; undefined for summaries kept from before.
   */
  sorted?: number;
}

/**
 * The inbox's tabs, Primary first: three of Gmail's five, its Updates and
 * Forums being Primary's.
 */
export const MAIL_CATEGORIES = ['primary', 'promotions', 'social'] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export const CATEGORY_NAMES: Record<MailCategory, string> = {
  primary: 'Primary',
  promotions: 'Promotions',
  social: 'Social',
};

export function isMailCategory(v: unknown): v is MailCategory {
  return typeof v === 'string' && (MAIL_CATEGORIES as readonly string[]).includes(v);
}

/** How the inbox is split up, for every account. */
export interface InboxTabs {
  /** The tabs shown besides Primary, in Gmail's order; none, and the inbox has no tabs. Mail for a tab not shown is in Primary. */
  tabs: Exclude<MailCategory, 'primary'>[];
  /** Which new mail gets a notification and counts on Mail's Dock tile: only Primary's (with tabs shown), or all of it. */
  notify: 'primary' | 'all';
}

/** The colors a label can have; one is picked from its id until it's given one. */
export const LABEL_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/**
 * How an account keeps labels: Gmail's own (each one a mailbox, which a
 * message can be in several of); IMAP keywords (RFC 9051), as Thunderbird's
 * tags are, on servers that take new ones; or not at all.
 */
export type LabelKind = 'gmail' | 'keywords' | 'none';

export interface MailLabel {
  /** What's kept on the message: Gmail's label (its mailbox's path), or the IMAP keyword. */
  id: string;
  name: string;
  /** Kept by Din, on this computer: neither IMAP nor Gmail's IMAP gives label colors. */
  color: LabelColor | null;
  /** Gmail's mailbox of the label's mail, or null for a keyword (searched for in every mailbox). */
  path: string | null;
}

export interface MailLabels {
  kind: LabelKind;
  /** By name. */
  labels: MailLabel[];
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
  /** Whether there are older ones; ask again with `before` set to the last uid (or `next`). */
  more: boolean;
  /** Where to ask for older ones from, when it isn't the last message's uid: a tab's page looks past mail of other tabs. */
  next?: number;
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

/**
 * What a rule looks at: the sender, the recipients (To or Cc), the subject,
 * the mailing list's List-Id, or any header by name.
 */
export const RULE_FIELDS = ['from', 'to', 'subject', 'list-id', 'header'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

/** How it's matched: contains the words, is exactly (an address, for From and To), or an address at a domain. */
export const RULE_MATCHES = ['contains', 'is', 'domain'] as const;
export type RuleMatch = (typeof RULE_MATCHES)[number];

export interface RuleCondition {
  field: RuleField;
  /** The header's name, for `header`. */
  header?: string;
  match: RuleMatch;
  /** Matched without regard to case. */
  value: string;
}

/**
 * What a rule does: move the message (to a mailbox by path, or the
 * account's junk, trash or archive), put a label on it, mark it read, star
 * it, or forward a copy (only the server can, so only where it runs the
 * rules).
 */
export type RuleAction =
  | { type: 'move'; to: string | { special: 'junk' | 'trash' | 'archive' } }
  | { type: 'label'; label: string }
  | { type: 'read' }
  | { type: 'flag' }
  | { type: 'forward'; to: string };

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Whether every condition must match, or any one. */
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** No later rule looks at mail this one matched. */
  stop: boolean;
}

/** A sender whose mail goes straight to Junk or the Trash: an address, or `@domain` for everyone there. */
export interface BlockedSender {
  sender: string;
  to: 'junk' | 'trash';
  /** When it was blocked, ms. */
  added: number;
}

/**
 * Whether the account's server runs the rules too (Sieve, RFC 5228, put
 * there over ManageSieve, RFC 5804): `active`, it does, from Din's own
 * script; `ready`, it can, and Din's script goes there with the first rule
 * or block; `inactive`, it could, but another script of the user's is the
 * active one, so Din's waits beside it until the user takes over;
 * `edited`, Din's script there was changed by something other than Din, so
 * it's left alone; `none`, the server has no ManageSieve (Gmail, iCloud,
 * Outlook, Yahoo, Proton…); `error`, it couldn't be reached last time; and
 * `unchecked`, not looked at yet. Whatever the server does, Din runs the
 * rules on new mail itself while it's running.
 */
export type RulesServerState = 'unchecked' | 'none' | 'ready' | 'active' | 'inactive' | 'edited' | 'error';

export interface RulesServer {
  state: RulesServerState;
  /** The ManageSieve server, host:port. */
  host: string | null;
  /** The script the server runs, when it isn't Din's. */
  activeScript: string | null;
  /** The Sieve extensions it has. */
  extensions: string[];
  /** When it was last looked at, ms. */
  checked: number | null;
  error: string | null;
}

export interface MailRules {
  blocked: BlockedSender[];
  /** In the order they run, after the blocked senders. */
  rules: MailRule[];
  server: RulesServer;
}

/** What running the rules over mail already in the inbox did. */
export interface RulesApplied {
  /** Messages looked at. */
  checked: number;
  /** Messages a rule or a block matched. */
  matched: number;
  /** Of those, moved out of the inbox. */
  moved: number;
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
  /**
   * A page of a mailbox's messages, newest first; `label` keeps those with
   * that keyword (not Gmail's labels, which are mailboxes), and `category`
   * the inbox's in that tab (with the user's rules, and Primary taking the
   * tabs not shown).
   */
  messages(accountId: string, path: string, options?: { before?: number; limit?: number; query?: string; filter?: MessageFilter; label?: string; category?: MailCategory }): Promise<MessagePage>;
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
  /** The account's labels, and how it keeps them. */
  labels(accountId: string): Promise<MailLabels>;
  /** A new label: a Gmail label, or a keyword that's on no message yet. */
  createLabel(accountId: string, label: { name: string; color?: LabelColor | null }): Promise<MailLabel>;
  /** Rename a label (on Gmail, on the server; a keyword stays, and only its name here changes) or change its color. */
  updateLabel(accountId: string, id: string, patch: { name?: string; color?: LabelColor | null }): Promise<MailLabel>;
  /** Take a label off every message that has it, in every mailbox, and forget it. The messages stay. */
  deleteLabel(accountId: string, id: string): Promise<void>;
  /** Put labels on messages (`add`) and take others off (`remove`), by `MailLabel.id`. */
  setLabels(accountId: string, path: string, uids: number[], change: { add?: string[]; remove?: string[] }): Promise<void>;
  /**
   * A sender's picture (a data: URL) from their domain's NIP-05 profile or
   * BIMI logo, or null; ask only for senders with `senderVerified`.
   * Looked up in main and kept for weeks (electron/mail-avatars.mts).
   */
  avatar(address: string): Promise<string | null>;
  /** Whether senders' pictures are looked up (on unless turned off). */
  avatarLookups(): Promise<boolean>;
  setAvatarLookups(on: boolean): Promise<void>;
  /** Which inbox tabs are shown, and which new mail notifies. */
  inboxTabs(): Promise<InboxTabs>;
  setInboxTabs(patch: Partial<InboxTabs>): Promise<InboxTabs>;
  /**
   * The dates of each tab's newest unread mail in the inbox (at most 100
   * each, newest first), from the messages Mail has seen, with the
   * user's rules and the tabs shown: for its "new" counts.
   */
  tabCounts(accountId: string): Promise<Record<MailCategory, number[]>>;
  /** The senders whose mail goes to a tab of the user's choosing, by address. */
  tabRules(accountId: string): Promise<Record<string, MailCategory>>;
  /** Send a sender's mail, what's in the inbox and what comes, to a tab; null goes back to how it's sorted. */
  setTabRule(accountId: string, address: string, category: MailCategory | null): Promise<void>;
  /** The account's blocked senders and rules, and whether its server runs them too. */
  rules(accountId: string): Promise<MailRules>;
  /** Add a rule, or change the one with its id (a new one goes last). */
  saveRule(accountId: string, rule: MailRule): Promise<MailRules>;
  deleteRule(accountId: string, id: string): Promise<MailRules>;
  /** Put the rules in this order, by id. */
  orderRules(accountId: string, ids: string[]): Promise<MailRules>;
  /** Send a sender's new mail (an address, or `@domain`) to Junk or the Trash. */
  block(accountId: string, sender: string, to?: 'junk' | 'trash'): Promise<MailRules>;
  unblock(accountId: string, sender: string): Promise<MailRules>;
  /** Run the rules and the blocks over what's in the inbox now: or one rule, by id, or (`blocked`) only the blocks. */
  applyRules(accountId: string, options?: { rule?: string; blocked?: boolean }): Promise<RulesApplied>;
  /**
   * Look at the server again and put the rules there; `takeOver` makes Din's
   * script the active one in place of the user's own (kept on the server,
   * and run after Din's where the server can include it), or in place of an
   * edited copy of Din's.
   */
  syncRules(accountId: string, options?: { takeOver?: boolean }): Promise<MailRules>;
  /** The Sieve script Din puts on the server for the account. */
  rulesScript(accountId: string): Promise<string>;
  /** Mark every message in a mailbox read; resolves with how many were unread. */
  markAllRead(accountId: string, path: string): Promise<number>;
  /** Move to a mailbox by path, or to the account's archive, trash or junk. */
  move(accountId: string, path: string, uids: number[], to: string | { special: 'archive' | 'trash' | 'junk' | 'inbox' }): Promise<void>;
  /** To the trash; from the trash, gone for good. */
  remove(accountId: string, path: string, uids: number[]): Promise<void>;
  /** Send it; `sentCopyProblem` says why no copy was kept in Sent, when the message went but that didn't. */
  send(accountId: string, message: OutgoingMessage): Promise<{ sentCopyProblem?: string } | void>;
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
  /** The inbox tab it's in. */
  category: MailCategory;
  /** The verification code in it, offered in web pages' code fields too, if it has one and its account fills them in. */
  code?: string | null;
}

/** Announced mail that's been read, moved or deleted: its notification goes. */
export interface MailRead {
  accountId: string;
  path: string;
  uids: number[];
}

/**
 * What the desktop has of it: the mailboxes and their messages (read
 * without marking them read), sending mail, the mailing lists, labels and inbox tabs, for
 * `din mail`; and new mail and each inbox's unread count, watched from the
 * moment Din starts, for notifications and Mail's Dock badge.
 */
export type MailDesktopBridge = Pick<
  MailBridge,
  'accounts' | 'mailboxes' | 'messages' | 'message' | 'send' | 'markAllRead' | 'avatarLookups' | 'setAvatarLookups' | 'subscriptions' | 'unsubscribe' | 'labels' | 'createLabel' | 'updateLabel' | 'deleteLabel' | 'inboxTabs' | 'setInboxTabs' | 'tabRules' | 'setTabRule' | 'move' | 'remove'
  | 'rules' | 'saveRule' | 'deleteRule' | 'orderRules' | 'block' | 'unblock' | 'applyRules' | 'syncRules' | 'rulesScript'
> & {
  /** Give an account its color in Mail, or (null) back the one Mail picks; nothing else of the account. */
  setAccountColor(id: string, color: LabelColor | null): Promise<MailAccount>;
  /** Whether an account's verification codes are offered in web pages' code fields; nothing else of the account. */
  setFillCodes(id: string, on: boolean): Promise<MailAccount>;
  /** Each account's unread mail in its inbox (only Primary's, when only Primary notifies), as last counted. */
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

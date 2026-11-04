// Mail (din.system.mail, for the Mail app in src/apps/mail/): IMAP and SMTP
// accounts, the way Apple Mail does them, behind the `mail:*` channels.
//
// Apps can't open sockets, so the accounts live here. Each account's
// settings are kept in userData/mail/accounts.json with its password sealed
// by safeStorage (the login keyring, see main.mts's --password-store; only
// base64 where there's none), and never go back to the app. Each
// account gets one IMAP connection for what the app asks (imapflow queues
// commands behind its mailbox locks), closed after a while without calls,
// and one more that idles on the inbox from the moment Din starts, Mail
// open or not, so new mail shows up as it arrives. That one reconnects
// when it drops (backing off while the server can't be reached, and at
// once when the computer wakes).
//
// New mail in an inbox is pushed to the desktop as `mail:arrived` (a
// MailArrival each, for a notification), and `mail:read` once it's read,
// moved or deleted (here or anywhere else), so its notification goes; and
// each inbox's unread count as `mail:unseen`, for Mail's Dock badge.
//
// What Mail has seen is kept on this computer (electron/mail-store.mts): the
// folders, each mailbox's uids, the summaries the list has shown, and the
// messages that have been opened. The app's reads are answered from that
// copy when it has them, so Mail opens instantly and reads offline, and the
// copy is synced behind it: when it's a minute old, and whenever the server
// says a mailbox changed (only the flags changed since last time, where the
// server has CONDSTORE). Anything that changes a mailbox, here or on the
// server, is pushed as `mail:changed` ({ accountId, path }) to the apps
// granted `mail`, once the copy has it.
//
// Sending is nodemailer over the account's SMTP server, with a copy
// appended to Sent (except where the server keeps one itself: Gmail,
// Outlook). Messages are parsed with mailparser, which also turns cid:
// pictures into data: URLs; the app sanitizes and sandboxes the HTML. A big
// message opens without its big attachments, which are fetched when asked for.
//
// Subscriptions finds the mailing lists in each inbox from a few headers of
// each message (List-Unsubscribe and its kin, never the bodies), kept in the
// stored copy so only new mail is looked at again, and leaves them: by
// RFC 8058's one click, else a message to the list's address, else by
// giving back the web page the user has to finish on (electron/mail-lists.mts).
//
// Labels are IMAP keywords (RFC 9051's flags without a backslash, which
// Thunderbird's tags are too), on servers that take new ones (\* in
// PERMANENTFLAGS); on Gmail, which shows only its own, they're Gmail's
// labels (X-GM-LABELS), each a mailbox a message can be in several of, so
// they're the same on Gmail's web page and phone app. IMAP has no list of a
// server's keywords, nor colors for them, so the labels made here, their
// names and colors are kept with the account, and the keywords found on
// mail with the stored copy. A keyword label's name can change without
// rewriting it on every message: the keyword stays, as Thunderbird's do.
//
// The inbox is split into Gmail's tabs (Primary, Promotions, Social,
// Updates, Forums). On Gmail each message's tab is Gmail's own, which IMAP
// gives only to a search (X-GM-RAW category:…), so it's asked for as
// summaries are fetched, and again for the newest mail at each sync, and
// a tab's pages are Gmail's search; elsewhere it's guessed from a few
// headers (electron/mail-categories.mts), and a tab's pages are read from
// the stored copy, fetching more summaries as they're needed (and fetching
// again those guessed by older rules, SORTER_VERSION). A sender the user
// moved to a tab goes there either way (kept with the account; IMAP can't
// change Gmail's own tabs); else mail from someone the user has written to
// (the addresses in Sent, looked through now and then and kept with the
// stored copy) is Primary unless it's a list's; and mail for a tab that
// isn't shown is in Primary. Only Primary's new mail is announced and counted
// on the Dock, unless the user asks for all of it.
//
// Types are src/lib/mail.ts. Runs as TypeScript directly via Node's native
// type stripping - erasable syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { app, ipcMain, net, powerMonitor, safeStorage } from 'electron';
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse, type MessageAddressObject, type MessageStructureObject, type SearchObject } from 'imapflow';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { MailStore, type Flags, type ListHeader } from './mail-store.mts';
import { avatar, avatarLookups, setAvatarLookups } from './mail-avatars.mts';
import { headerFields, httpsLink, LIST_HEADERS, listHeader, listKey, mailtoLink, methodOf, parseUnsubscribeMailto, postOneClick, senderVouched, webLink } from './mail-lists.mts';
import { CATEGORIES, CATEGORY_HEADERS, SORTER_VERSION, categorize, isAutomatedAddress, isCategory } from './mail-categories.mts';
import type {
  ConversationMessage,
  InboxTabs,
  LabelColor,
  LabelKind,
  MailAccount,
  MailAccountPatch,
  MailAddress,
  MailArrival,
  MailAttachment,
  MailboxInfo,
  MailCategory,
  MailLabel,
  MailLabels,
  MailMessage,
  MailServer,
  MailSettings,
  MailSubscription,
  MessageFilter,
  MessagePage,
  MessageSummary,
  NewMailAccount,
  OutgoingMessage,
  SpecialMailbox,
  SubscriptionScan,
  UnsubscribeInfo,
  UnsubscribeResult,
} from '../src/lib/mail.ts';

interface Deps {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}

interface StoredAccount extends MailAccount {
  /** `enc:` + safeStorage ciphertext (base64), or `plain:` where there's no keyring. */
  password: string;
  /** What Din keeps of the account's labels, by id. */
  labels?: SavedLabel[];
  /** The inbox tab each of these senders' mail goes to, by address (lowercase), as the user moved it. */
  tabRules?: Record<string, MailCategory>;
}

/** Gmail's own three, and Updates, so receipts and notifications aren't in Primary. */
const DEFAULT_TABS: InboxTabs = { tabs: ['promotions', 'social', 'updates'], notify: 'primary' };
let inboxTabs: InboxTabs = DEFAULT_TABS;

function isInboxTabs(v: unknown): v is InboxTabs {
  const t = v as InboxTabs;
  return typeof v === 'object' && v !== null && Array.isArray(t.tabs) && (t.notify === 'primary' || t.notify === 'all');
}

/** The tabs in Gmail's order, Primary left out (it's always there). */
function tabList(v: unknown[]): InboxTabs['tabs'] {
  return CATEGORIES.filter((c): c is InboxTabs['tabs'][number] => c !== 'primary' && v.includes(c));
}

function tabRulesOf(v: unknown): Record<string, MailCategory> | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const out: Record<string, MailCategory> = {};
  for (const [address, c] of Object.entries(v)) if (RULE_ADDRESS.test(address) && isCategory(c)) out[address] = c;
  return out;
}

/** A label's name (keywords only) and color, or a keyword deleted, which a server may go on listing. */
interface SavedLabel {
  id: string;
  name?: string;
  color?: LabelColor | null;
  deleted?: boolean;
}

function isSavedLabel(v: unknown): v is SavedLabel {
  const l = v as SavedLabel;
  return typeof v === 'object' && v !== null && typeof l.id === 'string' && (l.name === undefined || typeof l.name === 'string');
}

const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const MAX_SEND_BYTES = 35 * 1024 * 1024;
/** Connections close after this long without a call. */
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const PAGE = 50;
const PREVIEW_BYTES = 2048;
const PREVIEW_CHARS = 240;
/** Bigger messages are opened without their big attachments' bodies, fetched when saved. */
const SKIM_BYTES = 512 * 1024;
const SMALL_PART_BYTES = 64 * 1024;
const INLINE_PART_BYTES = 5 * 1024 * 1024;

let deps: Deps;
let accounts: StoredAccount[] = [];

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function storePath(): string {
  return path.join(app.getPath('userData'), 'mail', 'accounts.json');
}

function seal(password: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(password).toString('base64')}`;
  return `plain:${Buffer.from(password, 'utf8').toString('base64')}`;
}

function unseal(sealed: string): string {
  if (sealed.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'));
  if (sealed.startsWith('plain:')) return Buffer.from(sealed.slice(6), 'base64').toString('utf8');
  return '';
}

function load(): void {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    const list = (data as { accounts?: unknown }).accounts;
    accounts = Array.isArray(list) ? list.filter(isStoredAccount) : [];
    for (const a of accounts) {
      a.labels = Array.isArray(a.labels) ? a.labels.filter(isSavedLabel) : undefined;
      a.tabRules = tabRulesOf(a.tabRules);
    }
    const tabs = (data as { inboxTabs?: unknown }).inboxTabs;
    inboxTabs = isInboxTabs(tabs) ? { tabs: tabList(tabs.tabs), notify: tabs.notify } : DEFAULT_TABS;
  } catch {
    accounts = [];
  }
  // Passwords saved while there was no keyring are sealed once there is.
  if (safeStorage.isEncryptionAvailable() && accounts.some((a) => a.password.startsWith('plain:'))) {
    for (const a of accounts) if (a.password.startsWith('plain:')) a.password = seal(unseal(a.password));
    save();
  }
}

function save(): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts, inboxTabs }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isServer(v: unknown): v is MailServer {
  const s = v as MailServer;
  return (
    typeof v === 'object' && v !== null &&
    typeof s.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(s.host) &&
    Number.isInteger(s.port) && s.port > 0 && s.port < 65536 &&
    typeof s.secure === 'boolean' &&
    typeof s.user === 'string' && s.user.length > 0 && s.user.length <= 320
  );
}

function isStoredAccount(v: unknown): v is StoredAccount {
  const a = v as StoredAccount;
  return (
    typeof v === 'object' && v !== null &&
    typeof a.id === 'string' && typeof a.name === 'string' && typeof a.fullName === 'string' &&
    typeof a.email === 'string' && typeof a.password === 'string' && typeof a.signature === 'string' &&
    isServer(a.imap) && isServer(a.smtp)
  );
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function publicAccount(a: StoredAccount): MailAccount {
  const { password: _password, labels: _labels, tabRules: _tabRules, ...rest } = a;
  return rest;
}

function account(id: unknown): StoredAccount {
  const a = accounts.find((x) => x.id === id);
  if (!a) throw new Error('No such account');
  return a;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** A sender a tab rule names: an address with nothing Gmail's search syntax would read as more. */
const RULE_ADDRESS = /^[^\s@<>{}()"'\\:]+@[^\s@<>{}()"'\\:]+\.[^\s@<>{}()"'\\:]+$/;

// ---------------------------------------------------------------------------
// Finding an account's servers
// ---------------------------------------------------------------------------

type Provider = NonNullable<MailSettings['provider']>;

const PROVIDERS: Record<Provider, { imap: [string, number, boolean]; smtp: [string, number, boolean]; domains: string[]; mx?: RegExp }> = {
  gmail: { imap: ['imap.gmail.com', 993, true], smtp: ['smtp.gmail.com', 465, true], domains: ['gmail.com', 'googlemail.com'], mx: /\.google(mail)?\.com$/i },
  icloud: { imap: ['imap.mail.me.com', 993, true], smtp: ['smtp.mail.me.com', 587, false], domains: ['icloud.com', 'me.com', 'mac.com'], mx: /\.mail\.icloud\.com$/i },
  outlook: { imap: ['outlook.office365.com', 993, true], smtp: ['smtp.office365.com', 587, false], domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], mx: /\.(outlook|protection\.outlook)\.com$/i },
  yahoo: { imap: ['imap.mail.yahoo.com', 993, true], smtp: ['smtp.mail.yahoo.com', 465, true], domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], mx: /\.yahoodns\.net$/i },
  aol: { imap: ['imap.aol.com', 993, true], smtp: ['smtp.aol.com', 465, true], domains: ['aol.com'] },
  fastmail: { imap: ['imap.fastmail.com', 993, true], smtp: ['smtp.fastmail.com', 465, true], domains: ['fastmail.com', 'fastmail.fm'], mx: /\.messagingengine\.com$/i },
  // Proton Mail Bridge, on this computer.
  proton: { imap: ['127.0.0.1', 1143, false], smtp: ['127.0.0.1', 1025, false], domains: ['proton.me', 'protonmail.com', 'pm.me'], mx: /\.protonmail\.ch$/i },
};

function fromProvider(provider: Provider, email: string): MailSettings {
  const p = PROVIDERS[provider];
  const server = ([host, port, secure]: [string, number, boolean]): MailServer => ({ host, port, secure, user: email });
  return { imap: server(p.imap), smtp: server(p.smtp), provider, source: 'known' };
}

/** Thunderbird's database of providers' settings (autoconfig.thunderbird.net). */
async function ispdb(domain: string, email: string): Promise<MailSettings | null> {
  try {
    const response = await net.fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const xml = await response.text();
    const pick = (kind: 'incomingServer' | 'outgoingServer', type: string): MailServer | null => {
      const blocks = [...xml.matchAll(new RegExp(`<${kind} type="${type}">([\\s\\S]*?)</${kind}>`, 'g'))].map((m) => m[1]);
      const tag = (block: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim() ?? '';
      // TLS from the start over STARTTLS, and either over plain.
      const ranked = blocks
        .map((b) => ({ b, socket: tag(b, 'socketType') }))
        .filter((x) => x.socket === 'SSL' || x.socket === 'STARTTLS')
        .sort((x, y) => (x.socket === 'SSL' ? 0 : 1) - (y.socket === 'SSL' ? 0 : 1));
      const best = ranked[0];
      if (!best) return null;
      const host = tag(best.b, 'hostname');
      const port = Number(tag(best.b, 'port'));
      const user = tag(best.b, 'username')
        .replace('%EMAILADDRESS%', email)
        .replace('%EMAILLOCALPART%', email.split('@')[0])
        .replace('%EMAILDOMAIN%', domain);
      const server = { host, port, secure: best.socket === 'SSL', user: user || email };
      return isServer(server) ? server : null;
    };
    const imap = pick('incomingServer', 'imap');
    const smtp = pick('outgoingServer', 'smtp');
    return imap && smtp ? { imap, smtp, provider: null, source: 'ispdb' } : null;
  } catch {
    return null;
  }
}

async function discover(email: string): Promise<MailSettings> {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  for (const [provider, p] of Object.entries(PROVIDERS) as [Provider, (typeof PROVIDERS)[Provider]][]) {
    if (p.domains.includes(domain)) return fromProvider(provider, email);
  }
  const found = await ispdb(domain, email);
  if (found) return found;
  // A domain of its own whose mail a provider handles (Google Workspace, Microsoft 365).
  try {
    const mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    for (const record of mx) {
      for (const [provider, p] of Object.entries(PROVIDERS) as [Provider, (typeof PROVIDERS)[Provider]][]) {
        if (p.mx?.test(record.exchange)) return fromProvider(provider, email);
      }
    }
    const host = mx[0]?.exchange.split('.').slice(-2).join('.');
    if (host && host !== domain) {
      const viaMx = await ispdb(host, email);
      if (viaMx) return viaMx;
    }
  } catch {
    // No MX: fall through to a guess.
  }
  return {
    imap: { host: `imap.${domain}`, port: 993, secure: true, user: email },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true, user: email },
    provider: null,
    source: 'guess',
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function imapClient(server: MailServer, password: string, idle?: { autoIdleDelay: number; maxIdleTime: number }): ImapFlow {
  return new ImapFlow({
    ...idle,
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user: server.user, pass: password },
    logger: false,
    clientInfo: { name: 'Din Mail' },
    // Without TLS from the start, STARTTLS or nothing: a password never
    // crosses the network in the clear. Bridges on this computer (Proton's)
    // sign their own certificates, and may not offer it.
    doSTARTTLS: !server.secure && !isLocal(server.host) ? true : undefined,
    tls: isLocal(server.host) ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 30_000,
  });
}

function smtpTransport(server: MailServer, password: string) {
  return createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    requireTLS: !server.secure && !isLocal(server.host),
    auth: { user: server.user, pass: password },
    tls: isLocal(server.host) ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 30_000,
  });
}

/** What went wrong, in words for the user. */
function explain(error: unknown): Error {
  const e = error as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string; responseCode?: number };
  if (e?.authenticationFailed || e?.code === 'EAUTH' || e?.responseCode === 535) {
    return new Error('The user name or password is incorrect.');
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return new Error('The server couldn’t be found. Check its name, and that you’re online.');
  if (e?.code === 'ECONNREFUSED') return new Error('The server refused the connection. Check its port.');
  if (e?.code === 'ETIMEDOUT' || e?.code === 'CONNECT_TIMEOUT' || e?.code === 'ETIMEOUT') return new Error('The server didn’t answer in time.');
  const message = e?.message ?? '';
  if (/WRONG_VERSION_NUMBER|wrong version number|packet length too long/i.test(message)) {
    return new Error('The server doesn’t start with TLS on this port. Turn off “Use TLS from the start”, or try another port.');
  }
  if (/STARTTLS/i.test(message) || e?.code === 'NoStartTLS') return new Error('The server doesn’t offer STARTTLS on this port, so the password can’t be sent safely. Try TLS from the start, or another port.');
  if (/self[- ]signed|unable to verify|certificate/i.test(message)) return new Error('The server’s certificate isn’t trusted. Check the server’s name.');
  if (e?.code === 'ESOCKET' || /SSL|TLS/i.test(message)) return new Error('Couldn’t make a secure connection to the server.');
  return new Error(e?.responseText || e?.message || String(error));
}

interface Session {
  client: ImapFlow | null;
  connecting: Promise<ImapFlow> | null;
  watcher: ImapFlow | null;
  watching: boolean;
  /** The watcher's next try after it dropped, and how long it waits. */
  retry: NodeJS.Timeout | null;
  backoff: number;
  lastUse: number;
  /** Mailbox paths by special use, from the last listing. */
  specials: Map<SpecialMailbox, string>;
}

const sessions = new Map<string, Session>();

/** An account's session; `touch` when the app asked, keeping its connection up. */
function sessionOf(id: string, touch = true): Session {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { client: null, connecting: null, watcher: null, watching: false, retry: null, backoff: RETRY_MIN_MS, lastUse: 0, specials: new Map() }));
  if (touch) s.lastUse = Date.now();
  // Work Din does by itself (a sync for new mail) keeps it a minute or two.
  else s.lastUse = Math.max(s.lastUse, Date.now() - IDLE_CLOSE_MS + 60_000);
  return s;
}

const pending = new Map<string, NodeJS.Timeout>();

/** Tell the apps a mailbox changed, once per burst; an inbox is counted again. */
function changed(accountId: string, mailbox: string): void {
  const key = `${accountId}\0${mailbox}`;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    deps.sendToShell('mail:changed', { accountId, path: mailbox });
    const a = accounts.find((x) => x.id === accountId);
    if (a && isInbox(mailbox)) void countUnseen(a);
  }, 250));
}

function isInbox(mailbox: string): boolean {
  return mailbox.toUpperCase() === 'INBOX';
}

// ---------------------------------------------------------------------------
// New mail, for the desktop's notifications and Mail's Dock badge
// ---------------------------------------------------------------------------

/** Mail older than this when it's found isn't announced (it came while Din was off). */
const ARRIVAL_FRESH_MS = 30 * 60_000;
/** At most this many notifications for one burst of new mail. */
const ARRIVAL_MAX = 5;

/** Each inbox's unread count, by account. */
const unseen = new Map<string, number>();
/** The newest uid in each account's inbox as last synced, past which mail is new. */
const inboxNewest = new Map<string, number>();
/** The unread messages announced, by account: their uids in the inbox. */
const announced = new Map<string, Set<number>>();

/** The most unread mail whose tabs are looked at to count Primary's; any older counts as Primary. */
const UNSEEN_SORTED_MAX = 500;

/** Whether only Primary's new mail notifies and counts. */
function primaryOnly(): boolean {
  return inboxTabs.notify === 'primary' && inboxTabs.tabs.length > 0;
}

/** The addresses each account has written to, by account (the stored copy's, read once). */
const correspondents = new Map<string, Set<string>>();
/** When each account's Sent was last looked through for them. */
const correspondentsLooked = new Map<string, number>();
/** How often Sent is looked through for new ones (sending through Mail adds its recipients straight away). */
const CORRESPONDENTS_EVERY_MS = 6 * 60 * 60 * 1000;
/** How many of Sent's messages are looked through, newest first, the first time. */
const SENT_LOOKED_MAX = 3000;
const CORRESPONDENTS_MAX = 5000;

/** What's kept of who an account writes to: Sent's UIDVALIDITY, the newest uid looked at in it, and the addresses. */
interface KeptCorrespondents {
  validity: string;
  uid: number;
  addresses: string[];
}

function keptCorrespondents(a: StoredAccount): KeptCorrespondents | null {
  try {
    const v = JSON.parse(storeOf(a).getMeta('correspondents') ?? 'null') as KeptCorrespondents | null;
    return v && typeof v.validity === 'string' && typeof v.uid === 'number' && Array.isArray(v.addresses) ? v : null;
  } catch {
    return null;
  }
}

function correspondentsOf(a: StoredAccount): Set<string> {
  let found = correspondents.get(a.id);
  if (!found) correspondents.set(a.id, (found = new Set(keptCorrespondents(a)?.addresses.filter((x) => typeof x === 'string'))));
  return found;
}

/** Add these to who the account writes to (an address, not the account's own, nor one nobody reads); true when any were new. */
function noteCorrespondents(a: StoredAccount, found: Set<string>, list: string[]): boolean {
  let added = false;
  const own = a.email.toLowerCase();
  for (const x of list) {
    const address = x.trim().toLowerCase();
    if (found.has(address) || address === own || !RULE_ADDRESS.test(address) || isAutomatedAddress(address)) continue;
    found.add(address);
    added = true;
  }
  return added;
}

function keepCorrespondents(a: StoredAccount, found: Set<string>, validity: string, uid: number): void {
  storeOf(a).setMeta('correspondents', JSON.stringify({ validity, uid, addresses: [...found].slice(-CORRESPONDENTS_MAX) }));
}

/** The user just wrote to these: their mail is Primary from now on. */
function rememberCorrespondents(a: StoredAccount, recipients: string[]): void {
  const found = correspondentsOf(a);
  if (!noteCorrespondents(a, found, recipients)) return;
  const kept = keptCorrespondents(a);
  keepCorrespondents(a, found, kept?.validity ?? '', kept?.uid ?? 0);
  retabbed([a]);
}

/** Look through Sent's mail not looked at yet (at most every CORRESPONDENTS_EVERY_MS) for who the user writes to. */
async function lookForCorrespondents(a: StoredAccount): Promise<void> {
  if (Date.now() - (correspondentsLooked.get(a.id) ?? 0) < CORRESPONDENTS_EVERY_MS) return;
  correspondentsLooked.set(a.id, Date.now());
  const sent = await specialPath(a, 'sent');
  const added = await inMailbox(a, sent, async (client) => {
    const box = client.mailbox;
    if (!box || !accounts.includes(a)) return false;
    const validity = String(box.uidValidity);
    const kept = keptCorrespondents(a);
    const since = kept?.validity === validity ? kept.uid : 0;
    const found = correspondentsOf(a);
    const uids = box.exists > 0 ? ((await client.search(since ? { uid: `${since + 1}:*` } : { all: true }, { uid: true })) || []) : [];
    const newer = uids.filter((u) => u > since).sort((x, y) => y - x).slice(0, SENT_LOOKED_MAX);
    if (!newer.length) {
      if (!kept || kept.validity !== validity) keepCorrespondents(a, found, validity, since);
      return false;
    }
    let added = false;
    for await (const m of client.fetch(uidRanges(newer), { uid: true, envelope: true }, { uid: true })) {
      const e = m.envelope;
      if (noteCorrespondents(a, found, [...addresses(e?.to), ...addresses(e?.cc), ...addresses(e?.bcc)].map((x) => x.address))) added = true;
    }
    keepCorrespondents(a, found, validity, Math.max(since, newer[0]));
    return added;
  }, false);
  if (added) retabbed([a]);
}

/**
 * The tab an inbox message is in: the user's rule for its sender, else
 * Primary from someone the user writes to (but not a list's mail), else how
 * it's sorted; Primary for a tab not shown.
 */
function tabOf(a: StoredAccount, s: MessageSummary): MailCategory {
  const address = s.from[0]?.address.toLowerCase();
  const writesTo = !!address && !s.listUnsubscribe && correspondentsOf(a).has(address);
  const c = (address && a.tabRules?.[address]) || (writesTo ? 'primary' : s.category) || 'primary';
  return c === 'primary' || (inboxTabs.tabs as MailCategory[]).includes(c) ? c : 'primary';
}

/** Count an inbox's unread mail again (Primary's, when only it notifies), telling the desktop of the count and of announced mail now read. */
async function countUnseen(a: StoredAccount): Promise<void> {
  let uids: number[];
  let count: number;
  try {
    [uids, count] = await inMailbox(a, 'INBOX', async (client): Promise<[number[], number]> => {
      const found = (await client.search({ seen: false }, { uid: true })) || [];
      if (!primaryOnly() || !client.mailbox) return [found, found.length];
      // The newest unread mail's tabs, fetching the summaries not kept yet.
      const store = storeOf(a);
      checkValidity(a, store, 'INBOX', String(client.mailbox.uidValidity));
      const newest = [...found].sort((x, y) => y - x).slice(0, UNSEEN_SORTED_MAX);
      const kept = store.summaries('INBOX', newest);
      await fetchSummaries(client, store, 'INBOX', newest.filter((u) => stale(kept.get(u)?.summary, 'INBOX')));
      const now = store.summaries('INBOX', newest);
      const elsewhere = newest.filter((u) => {
        const s = now.get(u)?.summary;
        return !!s && tabOf(a, s) !== 'primary';
      }).length;
      return [found, found.length - elsewhere];
    }, false);
  } catch {
    return;
  }
  if (!accounts.includes(a)) return;
  if (unseen.get(a.id) !== count) {
    unseen.set(a.id, count);
    deps.sendToShell('mail:unseen', Object.fromEntries(unseen));
  }
  const told = announced.get(a.id);
  if (!told) return;
  const still = new Set(uids);
  const read = [...told].filter((u) => !still.has(u));
  if (!read.length) return;
  for (const u of read) told.delete(u);
  deps.sendToShell('mail:read', { accountId: a.id, path: 'INBOX', uids: read });
}

/** Announce the new unread mail among these uids, just stored (only Primary's, unless all of it notifies). */
function announce(a: StoredAccount, store: MailStore, uids: number[]): void {
  const now = Date.now();
  const fresh = [...store.summaries('INBOX', uids).values()]
    .map((k) => k.summary)
    .filter((m) => !m.seen && !m.draft && now - m.date < ARRIVAL_FRESH_MS && (!primaryOnly() || tabOf(a, m) === 'primary'))
    .sort((x, y) => y.uid - x.uid)
    .slice(0, ARRIVAL_MAX);
  if (!fresh.length) return;
  let told = announced.get(a.id);
  if (!told) announced.set(a.id, (told = new Set()));
  for (const m of fresh.reverse()) {
    told.add(m.uid);
    const arrival: MailArrival = {
      accountId: a.id,
      accountName: a.name,
      path: 'INBOX',
      uid: m.uid,
      from: m.from,
      subject: m.subject,
      preview: m.preview,
      date: m.date,
      category: tabOf(a, m),
    };
    deps.sendToShell('mail:arrived', arrival);
  }
}

/** Forget an account's counts and announcements (it's gone, or moved servers). */
function forgetArrivals(id: string): void {
  inboxNewest.delete(id);
  correspondents.delete(id);
  correspondentsLooked.delete(id);
  const told = announced.get(id);
  announced.delete(id);
  if (told?.size) deps.sendToShell('mail:read', { accountId: id, path: 'INBOX', uids: [...told] });
  if (unseen.delete(id)) deps.sendToShell('mail:unseen', Object.fromEntries(unseen));
}

/** The server says a mailbox changed: bring the stored copy up to date, which tells the app if anything did. */
function listen(a: StoredAccount, client: ImapFlow): void {
  const onChange = (e: { path?: string }) => {
    if (typeof e?.path === 'string') scheduleSync(a, e.path, 300);
  };
  client.on('exists', onChange);
  client.on('expunge', onChange);
  client.on('flags', onChange);
  client.on('error', () => {});
}

async function connection(a: StoredAccount, touch = true): Promise<ImapFlow> {
  const s = sessionOf(a.id, touch);
  if (s.client?.usable) {
    watch(a, s);
    return s.client;
  }
  if (!s.connecting) {
    const client = imapClient(a.imap, unseal(a.password));
    listen(a, client);
    client.on('close', () => {
      if (s.client === client) s.client = null;
    });
    s.connecting = client
      .connect()
      .then(() => {
        s.client = client;
        return client;
      })
      .catch((error: unknown) => {
        throw explain(error);
      })
      .finally(() => {
        s.connecting = null;
      });
  }
  const client = await s.connecting;
  watch(a, s);
  return client;
}

/** The watcher's first wait to reconnect, doubling to the last while it can't. */
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Keep a second connection idling on the inbox, for new mail, for as long
 * as the account is here. Each time it connects, the inbox is synced, for
 * mail that came while it wasn't.
 */
function watch(a: StoredAccount, s: Session): void {
  if (s.watching) return;
  s.watching = true;
  if (s.retry) clearTimeout(s.retry);
  s.retry = null;
  // It idles right away, and renews the IDLE now and then for servers that drop quiet ones.
  const client = imapClient(a.imap, unseal(a.password), { autoIdleDelay: 500, maxIdleTime: 5 * 60_000 });
  listen(a, client);
  s.watcher = client;
  client.on('close', () => {
    if (s.watcher !== client) return;
    s.watcher = null;
    s.watching = false;
    if (sessions.get(a.id) !== s || !accounts.includes(a)) return;
    s.retry = setTimeout(() => {
      s.retry = null;
      if (!s.watching) watch(a, s);
    }, s.backoff);
    s.retry.unref();
    s.backoff = Math.min(s.backoff * 2, RETRY_MAX_MS);
  });
  client
    .connect()
    .then(() => client.mailboxOpen('INBOX', { readOnly: true }))
    .then(() => {
      s.backoff = RETRY_MIN_MS;
      scheduleSync(a, 'INBOX', 0);
      void countUnseen(a);
    })
    .catch(() => {
      // The main connection reports problems; this one just tries again later.
      client.close();
    });
}

/** Watch every account's inbox. */
function watchAll(): void {
  for (const a of accounts) watch(a, sessionOf(a.id, false));
}

/** Connect every watcher again at once (the computer woke: their sockets are likely dead). */
function rewatchAll(): void {
  for (const a of accounts) {
    const s = sessionOf(a.id, false);
    const old = s.watcher;
    s.watcher = null;
    s.watching = false;
    s.backoff = RETRY_MIN_MS;
    old?.close();
    watch(a, s);
  }
}

/** Close the connection the app's calls use; the watcher stays. */
function closeClient(s: Session): void {
  const client = s.client;
  s.client = null;
  if (client) void client.logout().catch(() => client.close());
}

/** Close both of an account's connections, for good or until `watch` starts again. */
function closeSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.watching = true;
  if (s.retry) clearTimeout(s.retry);
  s.retry = null;
  for (const client of [s.client, s.watcher]) {
    if (client) void client.logout().catch(() => client.close());
  }
}

setInterval(() => {
  for (const s of sessions.values()) if (s.client && Date.now() - s.lastUse > IDLE_CLOSE_MS) closeClient(s);
}, 60_000).unref();

/**
 * Run with a mailbox selected (imapflow queues other callers behind the
 * lock). Always read-write, even to read: imapflow reopens a mailbox to
 * switch between EXAMINE and SELECT, which on a big one is slow, and
 * opening an unread message marks it read right away. Reads fetch with
 * BODY.PEEK, so they never set \Seen themselves.
 */
async function inMailbox<T>(a: StoredAccount, mailbox: string, fn: (client: ImapFlow) => Promise<T>, touch = true): Promise<T> {
  const client = await connection(a, touch);
  let lock;
  try {
    lock = await client.getMailboxLock(mailbox);
  } catch (error) {
    throw explain(error);
  }
  try {
    return await fn(client);
  } catch (error) {
    throw explain(error);
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

const SPECIAL: Record<string, SpecialMailbox> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
};

function noteSpecials(s: Session, list: MailboxInfo[]): void {
  s.specials.clear();
  for (const m of list) if (m.special && !s.specials.has(m.special)) s.specials.set(m.special, m.path);
}

function storedMailboxes(a: StoredAccount): MailboxInfo[] | null {
  try {
    const saved = storeOf(a).getMeta('mailboxes');
    return saved ? (JSON.parse(saved) as MailboxInfo[]) : null;
  } catch {
    return null;
  }
}

/**
 * The folders as last listed, when there's no connection yet: right away,
 * and listed again behind them (telling the app if they changed). Listed
 * on the connection when there is one, so counts the app has just changed
 * come back current; and from the stored list when the server can't be
 * reached.
 */
async function mailboxes(a: StoredAccount): Promise<MailboxInfo[]> {
  const s = sessionOf(a.id);
  const saved = storedMailboxes(a);
  if (saved && !s.client?.usable) {
    if (!s.specials.size) noteSpecials(s, saved);
    void listMailboxes(a)
      .then((list) => {
        if (JSON.stringify(list) !== JSON.stringify(saved)) changed(a.id, list.find((m) => m.special === 'inbox')?.path ?? 'INBOX');
      })
      .catch(() => {});
    return saved;
  }
  try {
    return await listMailboxes(a);
  } catch (error) {
    if (!saved) throw error;
    if (!s.specials.size) noteSpecials(s, saved);
    return saved;
  }
}

async function listMailboxes(a: StoredAccount): Promise<MailboxInfo[]> {
  const client = await connection(a);
  let list: ListResponse[];
  try {
    list = await client.list({ statusQuery: { messages: true, unseen: true } });
  } catch (error) {
    throw explain(error);
  }
  const out: MailboxInfo[] = list.map((m) => {
    const special = m.path.toUpperCase() === 'INBOX' ? 'inbox' : (m.specialUse && SPECIAL[m.specialUse]) || null;
    return {
      path: m.path,
      name: m.path.toUpperCase() === 'INBOX' ? 'Inbox' : m.name,
      parent: m.parentPath,
      delimiter: m.delimiter,
      special,
      selectable: !m.flags.has('\\Noselect') && !m.flags.has('\\NonExistent'),
      total: m.status?.messages ?? 0,
      unseen: m.status?.unseen ?? 0,
    };
  });
  noteSpecials(sessionOf(a.id), out);
  storeOf(a).setMeta('mailboxes', JSON.stringify(out));
  return out;
}

async function specialPath(a: StoredAccount, special: SpecialMailbox, create?: string): Promise<string> {
  const s = sessionOf(a.id);
  if (!s.specials.size) await mailboxes(a);
  const found = s.specials.get(special);
  if (found) return found;
  if (!create) throw new Error(`This account has no ${special} mailbox.`);
  const client = await connection(a);
  const made = await client.mailboxCreate(create).catch((error: unknown) => {
    throw explain(error);
  });
  s.specials.set(special, made.path);
  return made.path;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function addresses(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? [])
    .filter((x) => x.address || x.name)
    .map((x) => ({ name: x.name ?? '', address: x.address ?? '' }));
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const groups = Array.isArray(value) ? value : value ? [value] : [];
  const out: MailAddress[] = [];
  const walk = (list: AddressObject['value']) => {
    for (const x of list) {
      if (x.group) walk(x.group);
      else out.push({ name: x.name ?? '', address: x.address ?? '' });
    }
  };
  for (const g of groups) walk(g.value);
  return out;
}

/** The part to preview: the first plain text that isn't an attachment, else HTML. */
function previewPart(node: MessageStructureObject | undefined): MessageStructureObject | null {
  if (!node) return null;
  let html: MessageStructureObject | null = null;
  const walk = (n: MessageStructureObject): MessageStructureObject | null => {
    if (n.childNodes?.length) {
      for (const c of n.childNodes) {
        const found = walk(c);
        if (found) return found;
      }
      return null;
    }
    if (n.disposition === 'attachment') return null;
    if (n.type === 'text/plain') return n;
    if (n.type === 'text/html' && !html) html = n;
    return null;
  };
  return walk(node) ?? html;
}

function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachments);
  return node.disposition === 'attachment' || (!!(node.dispositionParameters?.filename ?? node.parameters?.name) && !node.type.startsWith('text/') && node.disposition !== 'inline');
}

function decodeQuotedPrintable(raw: string): Buffer {
  const soft = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === '=' && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = soft.charCodeAt(i);
      bytes.push(code & 0xff);
    }
  }
  return Buffer.from(bytes);
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '', zwj: '', shy: '' };

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function previewText(part: MessageStructureObject, raw: Buffer): string {
  let bytes = raw;
  const encoding = part.encoding?.toLowerCase();
  if (encoding === 'base64') {
    const clean = raw.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  } else if (encoding === 'quoted-printable') {
    bytes = decodeQuotedPrintable(raw.toString('latin1'));
  }
  let decoded: string;
  try {
    decoded = new TextDecoder(part.parameters?.charset || 'utf-8').decode(bytes);
  } catch {
    decoded = new TextDecoder('utf-8').decode(bytes);
  }
  if (part.type === 'text/html') decoded = htmlToText(decoded);
  return decoded
    .split(/\r?\n/)
    // Quoted replies and their "On … wrote:" lines say nothing new.
    .filter((line) => !/^\s*>/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s(On\s.{4,120}?\swrote:|-{2,}\s*Original Message\s*-{2,}|Begin forwarded message:).*$/i, '')
    .replace(/\uFFFD+$/, '')
    .trim()
    .slice(0, PREVIEW_CHARS);
}

// ---------------------------------------------------------------------------
// The stored copy
// ---------------------------------------------------------------------------

/** A mailbox's stored copy is brought up to date when it's read and older than this. */
const SYNC_AFTER_MS = 60_000;

const stores = new Map<string, MailStore>();

function storeFile(id: string): string {
  return path.join(app.getPath('userData'), 'mail', `${id}.db`);
}

function storeOf(a: StoredAccount): MailStore {
  let store = stores.get(a.id);
  if (!store) {
    fs.mkdirSync(path.dirname(storeFile(a.id)), { recursive: true, mode: 0o700 });
    stores.set(a.id, (store = new MailStore(storeFile(a.id))));
  }
  return store;
}

/** Throw an account's stored mail away: it's removed, or its servers changed. */
function dropStore(id: string): void {
  stores.get(id)?.close();
  stores.delete(id);
  MailStore.remove(storeFile(id));
  for (const key of parsed.keys()) if (key.startsWith(`${id}\0`)) parsed.delete(key);
}

/** A mailbox renumbered (new UIDVALIDITY): forget what was kept of it. */
function checkValidity(a: StoredAccount, store: MailStore, mailbox: string, validity: string): boolean {
  if (!store.checkValidity(mailbox, validity)) return false;
  for (const key of parsed.keys()) if (key.startsWith(`${a.id}\0${mailbox}\0`)) parsed.delete(key);
  return true;
}

function byDate(list: MessageSummary[]): MessageSummary[] {
  return list.sort((x, y) => y.date - x.date || y.uid - x.uid);
}

/**
 * A page of a mailbox from its stored copy, or null when it doesn't have
 * all of it. `fallback` (the server can't be reached) settles for what it
 * has, and filters it (to a tab's, with `keep`).
 */
function storedPage(store: MailStore, mailbox: string, before: number | undefined, limit: number, filter: MessageFilter = null, fallback = false, label = '', keep?: (s: MessageSummary) => boolean): MessagePage | null {
  const box = store.box(mailbox);
  if (!box) return null;
  if (!fallback) {
    const older = before ? box.uids.filter((u) => u < before) : box.uids;
    const page = older.slice(0, limit);
    const kept = store.summaries(mailbox, page);
    // Kept from before Mail read their References: fetched again, for conversations.
    if (kept.size < page.length || [...kept.values()].some((k) => stale(k.summary, mailbox))) return null;
    return { messages: byDate([...kept.values()].map((k) => k.summary)), total: box.uids.length, more: older.length > page.length };
  }
  const all = store
    .allSummaries(mailbox, before)
    .filter((s) => (filter === 'unread' ? !s.seen : filter === 'flagged' ? s.flagged : true) && (!label || !!s.labels?.includes(label)) && (!keep || keep(s)));
  return { messages: byDate(all.slice(0, limit)), total: filter || label || keep ? all.length : box.uids.length, more: all.length > limit };
}

/** Each of these inbox messages' tab, as Gmail's search sorts them (any it doesn't name are Primary). */
async function gmailCategories(client: ImapFlow, uids: number[]): Promise<Map<number, MailCategory>> {
  const out = new Map<number, MailCategory>(uids.map((u) => [u, 'primary']));
  if (!uids.length) return out;
  const range = uidRanges(uids);
  for (const c of CATEGORIES) {
    if (c === 'primary') continue;
    const found = await client.search({ uid: range, gmraw: `category:${c}` }, { uid: true });
    for (const u of found || []) if (out.has(u)) out.set(u, c);
  }
  return out;
}

/** Fetch and keep the summaries of these messages, with previews for those that have none yet. */
async function fetchSummaries(client: ImapFlow, store: MailStore, mailbox: string, uids: number[]): Promise<boolean> {
  if (!uids.length) return false;
  const fetched: FetchMessageObject[] = [];
  for await (const m of client.fetch(uidRanges(uids), { ...SUMMARY_FIELDS }, { uid: true })) {
    fetched.push(m);
  }
  const gmail = isGmail(client);
  const summaries = fetched.map((m) => summary(m, gmail));
  if (!gmail) noteKeywords(store, summaries.flatMap((s) => s.labels ?? []));
  if (gmail && isInbox(mailbox)) {
    const categories = await gmailCategories(client, summaries.map((s) => s.uid));
    for (const s of summaries) s.category = categories.get(s.uid);
  }
  const changed = store.putSummaries(mailbox, summaries);

  // Previews, a few KB of each message's text, fetched together for messages whose text is the same part.
  const kept = store.summaries(mailbox, fetched.map((m) => m.uid));
  const want = new Map<string, { part: MessageStructureObject; uids: number[] }>();
  for (const m of fetched) {
    if (kept.get(m.uid)?.previewed) continue;
    const part = previewPart(m.bodyStructure);
    if (!part) {
      store.setPreview(mailbox, m.uid, null);
      continue;
    }
    const id = part.part ?? '1';
    const group = `${id}\0${part.type}\0${part.encoding}\0${part.parameters?.charset ?? ''}`;
    const entry = want.get(group) ?? { part: { ...part, part: id }, uids: [] };
    entry.uids.push(m.uid);
    want.set(group, entry);
  }
  for (const { part, uids: some } of want.values()) {
    try {
      for await (const m of client.fetch(uidRanges(some), { uid: true, bodyParts: [{ key: part.part ?? '1', maxLength: PREVIEW_BYTES }] }, { uid: true })) {
        const raw = m.bodyParts ? [...m.bodyParts.values()][0] : undefined;
        store.setPreview(mailbox, m.uid, raw ? previewText(part, raw) : null);
      }
    } catch {
      // Previews are a nicety; the list still shows.
    }
  }
  return changed || want.size > 0;
}

/** A uid set in IMAP's shorthand: 1:5,7,9:12. */
function uidRanges(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((x, y) => x - y);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    out.push(start === sorted[i] ? String(start) : `${start}:${sorted[i]}`);
  }
  return out.join(',');
}

function sameList(x: number[], y: number[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function flagsOf(m: Pick<FetchMessageObject, 'flags' | 'labels'>, gmail: boolean): Flags {
  const f = m.flags ?? new Set<string>();
  return { seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), answered: f.has('\\Answered'), draft: f.has('\\Draft'), labels: labelsOf(m, gmail) };
}

/**
 * Bring a mailbox's stored copy up to date: its uids (new mail, and what
 * went), the flags of the messages kept (only what changed since last
 * time, where the server has CONDSTORE), and the newest page's summaries.
 * Tells the app when anything changed. Never keeps the connection up by
 * itself: only the app's asking does.
 */
async function sync(a: StoredAccount, mailbox: string): Promise<void> {
  const store = storeOf(a);
  let dirty = false;
  let arrived: number[] = [];
  let newestNow: number | null = null;
  await inMailbox(a, mailbox, async (client) => {
    const box = client.mailbox;
    if (!box) return;
    const validity = String(box.uidValidity);
    const renumbered = checkValidity(a, store, mailbox, validity);
    if (renumbered) dirty = true;
    const prev = store.box(mailbox);
    const uids = box.exists > 0 ? ((await client.search({ all: true }, { uid: true })) || []).sort((x, y) => y - x) : [];
    // New mail: uids past the newest one synced before (none the first
    // time, or after renumbering). Kept apart from the stored uids, which
    // the app's reads bring up to date too.
    if (isInbox(mailbox)) {
      const newest = renumbered ? undefined : (inboxNewest.get(a.id) ?? (prev ? (prev.uids[0] ?? 0) : undefined));
      if (newest !== undefined) arrived = uids.filter((u) => u > newest);
      newestNow = Math.max(uids[0] ?? 0, newest ?? 0);
    }
    if (!prev || !sameList(prev.uids, uids)) dirty = true;
    const present = new Set(uids);
    const stored = store.storedUids(mailbox);
    store.removeUids(mailbox, stored.filter((u) => !present.has(u)));
    const keep = stored.filter((u) => present.has(u));

    const gmail = noteMailbox(store, client);
    const condstore = client.enabled.has('CONDSTORE') && !!box.highestModseq;
    let modseq = condstore ? box.highestModseq! : null;
    if (keep.length) {
      const since = condstore && prev?.modseq ? BigInt(prev.modseq) : null;
      const range = since !== null ? '1:*' : uidRanges(keep);
      const kept = new Set(keep);
      for await (const m of client.fetch(range, { uid: true, flags: true, labels: true }, { uid: true, changedSince: since ?? undefined })) {
        if (m.modseq && modseq !== null && m.modseq > modseq) modseq = m.modseq;
        const flags = flagsOf(m, gmail);
        if (!gmail) noteKeywords(store, flags.labels ?? []);
        if (kept.has(m.uid) && store.patchFlags(mailbox, [m.uid], flags)) dirty = true;
      }
    }
    store.setBox(mailbox, { validity, modseq: modseq?.toString() ?? null, uids, synced: Date.now() });

    // A tab changed on Gmail's web page or app changes neither flags nor modseq: the newest mail's are asked for again.
    if (gmail && isInbox(mailbox) && keep.length) {
      const recent = new Set(uids.slice(0, GMAIL_TABS_SYNCED));
      if (store.setCategories(mailbox, await gmailCategories(client, keep.filter((u) => recent.has(u))))) dirty = true;
    }

    // Summaries kept from before Mail read References are fetched again, once; in the inbox, those
    // sorted by older rules too, as far back as RESORTED (the newest page is fetched either way).
    const newest = uids.slice(0, isInbox(mailbox) ? RESORTED : PAGE);
    const have = store.summaries(mailbox, newest);
    const again = newest.filter((u, i) => (have.has(u) || i < PAGE) && stale(have.get(u)?.summary, mailbox));
    if (await fetchSummaries(client, store, mailbox, again)) dirty = true;
  }, false);
  if (isInbox(mailbox)) void lookForCorrespondents(a).catch(() => {});
  if (newestNow !== null) inboxNewest.set(a.id, newestNow);
  if (arrived.length) announce(a, store, arrived);
  if (dirty) changed(a.id, mailbox);
}

const syncs = new Map<string, { timer: NodeJS.Timeout | null; running: boolean; again: boolean }>();

/** Sync a mailbox soon, once per burst, one at a time. */
function scheduleSync(a: StoredAccount, mailbox: string, delay: number): void {
  const key = `${a.id}\0${mailbox}`;
  let s = syncs.get(key);
  if (!s) syncs.set(key, (s = { timer: null, running: false, again: false }));
  const state = s;
  if (state.running) {
    state.again = true;
    return;
  }
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!accounts.some((x) => x.id === a.id)) return;
    state.running = true;
    void sync(a, mailbox)
      .catch(() => {
        // Offline, or the server's busy: the stored copy stands until next time.
      })
      .finally(() => {
        state.running = false;
        if (state.again) {
          state.again = false;
          scheduleSync(a, mailbox, delay);
        } else if (!state.timer) {
          syncs.delete(key);
        }
      });
  }, delay);
  state.timer.unref();
}

/** What's fetched for a message's summary. */
const SUMMARY_FIELDS: FetchQueryObject = {
  uid: true, flags: true, labels: true, envelope: true, bodyStructure: true, internalDate: true, size: true, threadId: true,
  headers: ['list-unsubscribe', 'references', 'authentication-results', 'received', ...CATEGORY_HEADERS],
};

/** How many of a Gmail inbox's newest messages have their tabs asked for again at each sync. */
const GMAIL_TABS_SYNCED = 500;

/** How many of the inbox's newest kept messages are fetched again at a sync when their tab was guessed by older rules. */
const RESORTED = 500;

/** How many of a long References list are kept, from each end: the root and the latest. */
const REFERENCES_KEPT = 10;

/** The Message-IDs in a header, `<a@b> <c@d>`, as `<a@b>`. */
function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]{1,500}>/g) ?? [];
}

/** Kept from before Mail read what conversations, senders' pictures, labels and (in the inbox) tabs need, or sorted by older rules: fetched again. */
function stale(s: MessageSummary | undefined, mailbox: string): boolean {
  return !s || !s.references || s.senderVerified === undefined || s.labels === undefined || (isInbox(mailbox) && (s.category === undefined || s.sorted !== SORTER_VERSION));
}

function keptReferences(ids: string[]): string[] {
  return ids.length > REFERENCES_KEPT * 2 ? [...ids.slice(0, REFERENCES_KEPT), ...ids.slice(-REFERENCES_KEPT)] : ids;
}

function from0Domain(m: FetchMessageObject): string {
  return m.envelope?.from?.[0]?.address?.split('@').pop()?.toLowerCase() ?? '';
}

function summary(m: FetchMessageObject, gmail: boolean): MessageSummary {
  const date = m.envelope?.date ?? m.internalDate;
  const raw = m.headers?.toString('latin1') ?? '';
  const headers = m.headers ? headerFields(raw) : null;
  return {
    uid: m.uid,
    messageId: m.envelope?.messageId ?? null,
    subject: m.envelope?.subject ?? '',
    from: addresses(m.envelope?.from),
    to: addresses(m.envelope?.to),
    cc: addresses(m.envelope?.cc),
    date: date ? new Date(date).getTime() || 0 : 0,
    ...flagsOf(m, gmail),
    hasAttachments: hasAttachments(m.bodyStructure),
    preview: null,
    size: m.size ?? 0,
    listUnsubscribe: headers ? !!headers.get('list-unsubscribe')?.some((v) => /\S/.test(v)) : undefined,
    threadId: m.threadId ?? null,
    inReplyTo: messageIds(m.envelope?.inReplyTo)[0] ?? null,
    references: keptReferences(messageIds(headers?.get('references')?.join(' '))),
    senderVerified: senderVouched(raw, from0Domain(m)),
    // Gmail's are asked of Gmail (fetchSummaries).
    category: gmail ? undefined : categorize(headers, addresses(m.envelope?.from)[0], m.envelope?.subject ?? ''),
    sorted: SORTER_VERSION,
  };
}

/**
 * A page of a mailbox's messages. Straight from the stored copy when it
 * has the whole page (syncing behind it when it's old); otherwise from the
 * server, keeping what comes back. Searches and filters ask the server,
 * and settle for the stored copy when it can't be reached.
 */
async function messages(a: StoredAccount, mailbox: string, before: number | undefined, limit: number, query: string, filter: MessageFilter, label: string, category: MailCategory | null): Promise<MessagePage> {
  const store = storeOf(a);
  sessionOf(a.id);
  // A search looks in every tab.
  if (category && !query && !label && isInbox(mailbox) && inboxTabs.tabs.length) {
    try {
      if ((await labelKind(a)) === 'gmail') return await serverPage(a, store, mailbox, before, limit, '', filter, '', category);
      return await tabPage(a, store, mailbox, before, limit, filter, category);
    } catch (error) {
      const local = storedPage(store, mailbox, before, limit, filter, true, '', (s) => tabOf(a, s) === category);
      if (local) return local;
      throw error;
    }
  }
  if (!query && !filter && !label) {
    const local = storedPage(store, mailbox, before, limit);
    if (local) {
      if (Date.now() - (store.box(mailbox)?.synced ?? 0) > SYNC_AFTER_MS) scheduleSync(a, mailbox, 0);
      return local;
    }
  }
  try {
    return await serverPage(a, store, mailbox, before, limit, query, filter, label);
  } catch (error) {
    const local = query ? null : storedPage(store, mailbox, before, limit, filter, true, label);
    if (local) return local;
    throw error;
  }
}

/**
 * Gmail's search for a tab's mail: its category (Primary's taking the tabs
 * not shown), and the senders the user moved there, without the ones they
 * moved elsewhere.
 */
function gmailTabSearch(a: StoredAccount, tab: MailCategory): string {
  const shown = new Set<MailCategory>(['primary', ...inboxTabs.tabs]);
  const categories = tab === 'primary' ? CATEGORIES.filter((c) => c === 'primary' || !shown.has(c)) : [tab];
  const into: string[] = [];
  const away: string[] = [];
  for (const [address, c] of Object.entries(a.tabRules ?? {})) ((shown.has(c) ? c : 'primary') === tab ? into : away).push(address);
  const any = [...categories.map((c) => `category:${c}`), ...into.map((x) => `from:${x}`)].join(' ');
  return `{${any}}${away.map((x) => ` -from:${x}`).join('')}`;
}

async function serverPage(a: StoredAccount, store: MailStore, mailbox: string, before: number | undefined, limit: number, query: string, filter: MessageFilter, label: string, category: MailCategory | null = null): Promise<MessagePage> {
  return inMailbox(a, mailbox, async (client) => {
    const box = client.mailbox;
    const validity = box ? String(box.uidValidity) : '';
    checkValidity(a, store, mailbox, validity);
    const gmail = noteMailbox(store, client);
    let uids: number[] = [];
    if (box && box.exists > 0) {
      const criteria: SearchObject = filter === 'unread' ? { seen: false } : filter === 'flagged' ? { flagged: true } : { all: true };
      // Gmail searches the way its web page does; elsewhere, the usual headers and the body.
      const raw = [gmail && category ? gmailTabSearch(a, category) : '', gmail ? query : ''].filter(Boolean).join(' ');
      if (raw) {
        criteria.gmraw = raw;
        delete criteria.all;
      }
      if (query && !gmail) {
        criteria.or = [{ subject: query }, { from: query }, { to: query }, { body: query }];
        delete criteria.all;
      }
      if (label) {
        criteria.keyword = label;
        delete criteria.all;
      }
      uids = (await client.search(criteria, { uid: true })) || [];
    }
    uids.sort((x, y) => y - x);
    if (!query && !filter && !label && !category && box) {
      // The whole mailbox's uids: keep them, and forget what's gone. Flags
      // kept from before stay as current as they were (the modseq too), for
      // the next sync to bring up to date.
      const present = new Set(uids);
      store.removeUids(mailbox, store.storedUids(mailbox).filter((u) => !present.has(u)));
      const prev = store.box(mailbox);
      const modseq = prev ? prev.modseq : client.enabled.has('CONDSTORE') && box.highestModseq ? box.highestModseq.toString() : null;
      store.setBox(mailbox, { validity, modseq, uids, synced: prev?.synced ?? Date.now() });
    }
    const older = before ? uids.filter((u) => u < before) : uids;
    const page = older.slice(0, limit);
    if (!page.length) return { messages: [], total: uids.length, more: false };
    await fetchSummaries(client, store, mailbox, page);
    const kept = store.summaries(mailbox, page);
    const out = page.map((u) => kept.get(u)?.summary).filter((s): s is MessageSummary => !!s);
    return { messages: byDate(out), total: uids.length, more: older.length > page.length };
  });
}

/** The most of an inbox a tab's page looks through for its mail, before handing back what it found. */
const TAB_SCAN_MAX = 1000;

/**
 * A page of an inbox tab's mail, where the server can't search for it: the
 * stored copy read newest first, fetching the summaries it hasn't kept,
 * until there's a page of the tab's or it's looked through TAB_SCAN_MAX
 * (`next` says where to go on from).
 */
async function tabPage(a: StoredAccount, store: MailStore, mailbox: string, before: number | undefined, limit: number, filter: MessageFilter, tab: MailCategory): Promise<MessagePage> {
  const synced = store.box(mailbox)?.synced;
  if (synced === undefined) await sync(a, mailbox);
  else if (Date.now() - synced > SYNC_AFTER_MS) scheduleSync(a, mailbox, 0);
  const box = store.box(mailbox);
  if (!box) return { messages: [], total: 0, more: false };
  const older = before ? box.uids.filter((u) => u < before) : box.uids;
  const wanted = (s: MessageSummary) => tabOf(a, s) === tab && (filter === 'unread' ? !s.seen : filter === 'flagged' ? s.flagged : true);
  const out: MessageSummary[] = [];
  let looked = 0;
  for (; looked < older.length && looked < TAB_SCAN_MAX && out.length < limit; looked += PAGE) {
    const chunk = older.slice(looked, looked + PAGE);
    let kept = store.summaries(mailbox, chunk);
    const missing = chunk.filter((u) => stale(kept.get(u)?.summary, mailbox));
    if (missing.length) {
      await inMailbox(a, mailbox, async (client) => {
        if (client.mailbox) checkValidity(a, store, mailbox, String(client.mailbox.uidValidity));
        await fetchSummaries(client, store, mailbox, missing);
      });
      kept = store.summaries(mailbox, chunk);
    }
    for (const u of chunk) {
      const s = kept.get(u)?.summary;
      if (s && wanted(s)) out.push(s);
    }
  }
  const last = older[Math.min(looked, older.length) - 1];
  return { messages: byDate(out), total: out.length, more: looked < older.length, next: last };
}

async function wholeMessage(client: ImapFlow, uid: number): Promise<Buffer> {
  const download = await client.download(String(uid), undefined, { uid: true });
  if (!('content' in download) || !download.content) throw new Error('That message is gone.');
  const chunks: Buffer[] = [];
  for await (const chunk of download.content) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Whether a big message's part is fetched to open it: its text, inline pictures, anything small. */
function wanted(n: MessageStructureObject): boolean {
  const size = n.size ?? 0;
  if (size <= SMALL_PART_BYTES) return true;
  const attached = n.disposition === 'attachment';
  if (n.type.startsWith('text/') && !attached) return true;
  return !!n.id && !attached && n.type.startsWith('image/') && size <= INLINE_PART_BYTES;
}

/**
 * A big message rebuilt from its parts, with the bodies of its big
 * attachments left out, so opening it doesn't wait on them. Each one left
 * out keeps its headers, plus X-Din-Part (where to fetch it from when it's
 * saved) and X-Din-Size. Null when its structure can't be rebuilt.
 */
async function skimmedMessage(client: ImapFlow, uid: number, root: MessageStructureObject | undefined): Promise<Buffer | null> {
  if (!root?.type.startsWith('multipart/')) return null;
  const isMultipart = (n: MessageStructureObject) => n.type.startsWith('multipart/') && !!n.childNodes?.length;
  const sections: string[] = [];
  const plan = (n: MessageStructureObject, top: boolean): boolean => {
    if (!top) {
      if (!n.part) return false;
      sections.push(`${n.part}.MIME`);
    }
    if (isMultipart(n)) return !!n.parameters?.boundary && n.childNodes!.every((c) => plan(c, false));
    if (wanted(n)) sections.push(n.part ?? '1');
    return true;
  };
  if (!isMultipart(root) || !plan(root, true)) return null;

  const m = await client.fetchOne(String(uid), { uid: true, headers: true, bodyParts: sections }, { uid: true });
  if (!m || !m.headers || !m.bodyParts) return null;
  const got = m.bodyParts;
  const out: Buffer[] = [];
  const headerBlock = (raw: Buffer, extra = '') => Buffer.from(`${raw.toString('latin1').replace(/(\r?\n)+$/, '')}\r\n${extra}\r\n`, 'latin1');
  const build = (n: MessageStructureObject, headers: Buffer): boolean => {
    if (isMultipart(n)) {
      out.push(headerBlock(headers));
      const boundary = n.parameters!.boundary;
      for (const c of n.childNodes!) {
        const h = got.get(`${c.part!.toLowerCase()}.mime`);
        if (!h) return false;
        out.push(Buffer.from(`\r\n--${boundary}\r\n`, 'latin1'));
        if (!build(c, h)) return false;
      }
      out.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'));
      return true;
    }
    const body = got.get(n.part!.toLowerCase());
    if (body) {
      out.push(headerBlock(headers), body);
      return true;
    }
    // Base64 in 76-character lines: 57 bytes to every 78.
    const size = n.encoding === 'base64' ? Math.floor(((n.size ?? 0) * 57) / 78) : n.size ?? 0;
    out.push(headerBlock(headers, `X-Din-Part: ${n.part}\r\nX-Din-Size: ${size}\r\n`));
    return true;
  };
  return build(root, m.headers) ? Buffer.concat(out) : null;
}

/** Recently opened messages, parsed, by account, mailbox and uid. */
const parsed = new Map<string, { summary: MessageSummary; mail: ParsedMail }>();

function remember(key: string, entry: { summary: MessageSummary; mail: ParsedMail }): void {
  parsed.delete(key);
  parsed.set(key, entry);
  while (parsed.size > 24) parsed.delete(parsed.keys().next().value as string);
}

/** A message, from memory, then the stored copy, then the server (keeping it). */
async function parsedMessage(a: StoredAccount, mailbox: string, uid: number): Promise<{ summary: MessageSummary; mail: ParsedMail }> {
  const key = `${a.id}\0${mailbox}\0${uid}`;
  const hit = parsed.get(key);
  if (hit) {
    remember(key, hit);
    return hit;
  }
  const store = storeOf(a);
  const kept = store.summaries(mailbox, [uid]).get(uid)?.summary;
  const stored = kept && store.body(mailbox, uid);
  if (kept && stored) {
    const entry = { summary: kept, mail: await simpleParser(stored) };
    remember(key, entry);
    return entry;
  }
  return inMailbox(a, mailbox, async (client) => {
    if (client.mailbox) checkValidity(a, store, mailbox, String(client.mailbox.uidValidity));
    const meta = await client.fetchOne(String(uid), { ...SUMMARY_FIELDS }, { uid: true });
    if (!meta) throw new Error('That message is gone.');
    if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) throw new Error('That message is too big to open here.');
    const raw = ((meta.size ?? 0) > SKIM_BYTES && (await skimmedMessage(client, uid, meta.bodyStructure))) || (await wholeMessage(client, uid));
    const mail = await simpleParser(raw);
    const entry = { summary: summary(meta, isGmail(client)), mail };
    if (store.box(mailbox)) {
      store.putSummaries(mailbox, [entry.summary]);
      store.putBody(mailbox, uid, raw);
    }
    remember(key, entry);
    return entry;
  });
}

async function message(a: StoredAccount, mailbox: string, uid: number): Promise<MailMessage> {
  const { summary: s, mail } = await parsedMessage(a, mailbox, uid);
  const list = parsedListHeader(mail, s);
  const references = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
  return {
    ...s,
    subject: mail.subject ?? s.subject,
    from: mail.from ? parsedAddresses(mail.from) : s.from,
    to: mail.to ? parsedAddresses(mail.to) : s.to,
    cc: mail.cc ? parsedAddresses(mail.cc) : s.cc,
    bcc: parsedAddresses(mail.bcc),
    replyTo: parsedAddresses(mail.replyTo),
    inReplyTo: mail.inReplyTo ?? null,
    references,
    html: typeof mail.html === 'string' ? mail.html : null,
    text: mail.text ?? '',
    attachments: mail.attachments.map((x, index) => ({
      index,
      filename: x.filename || (x.contentType === 'message/rfc822' ? 'Attached message.eml' : `Attachment ${index + 1}`),
      contentType: x.contentType,
      size: Number(x.headers.get('x-din-size')) || x.size,
      inline: x.related === true && !!x.cid,
    })),
    unsubscribe: list ? unsubscribeInfo(a, list) : null,
  };
}

/** The most of a conversation read from each mailbox, newest first. */
const CONVERSATION_MAX = 100;

/**
 * A conversation's messages: from All Mail by the server's thread id on
 * Gmail; elsewhere from the inbox, Sent and Archive, by the thread id
 * where the server has OBJECTID, else by Message-ID and References.
 */
async function conversation(a: StoredAccount, ids: string[], threadId: string | null, since: number | undefined): Promise<ConversationMessage[]> {
  const s = sessionOf(a.id);
  if (!s.specials.size) await mailboxes(a);
  const client = await connection(a);
  const gmail = client.capabilities.has('X-GM-EXT-1');
  const byThread = !!threadId && (gmail || client.capabilities.has('OBJECTID'));
  const all = s.specials.get('all');
  const where = gmail && byThread && all ? [all] : [...new Set(['INBOX', s.specials.get('sent'), s.specials.get('archive')].filter((p): p is string => !!p))];
  if (!byThread && !ids.length) return [];
  const store = storeOf(a);
  const out: ConversationMessage[] = [];
  for (const mailbox of where) {
    try {
      const found = await inMailbox(a, mailbox, async (c) => {
        if (c.mailbox) checkValidity(a, store, mailbox, String(c.mailbox.uidValidity));
        const criteria: SearchObject = byThread
          ? { threadId: threadId! }
          : { or: ids.flatMap((id): SearchObject[] => ['message-id', 'references', 'in-reply-to'].map((h) => ({ header: { [h]: id } }))) };
        if (since && !byThread) criteria.since = new Date(since);
        const uids = ((await c.search(criteria, { uid: true })) || []).sort((x, y) => y - x).slice(0, CONVERSATION_MAX);
        if (!uids.length) return [];
        const kept = store.summaries(mailbox, uids);
        await fetchSummaries(c, store, mailbox, uids.filter((u) => stale(kept.get(u)?.summary, mailbox)));
        const now = store.summaries(mailbox, uids);
        return uids.flatMap((u) => {
          const summary = now.get(u)?.summary;
          return summary ? [{ path: mailbox, summary }] : [];
        });
      });
      out.push(...found);
    } catch {
      // A mailbox that can't be searched leaves its part of the conversation out.
    }
  }
  // The same message in two mailboxes (a copy filed away) shows once.
  const seen = new Set<string>();
  return out
    .filter((m) => {
      const id = m.summary.messageId;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((x, y) => x.summary.date - y.summary.date);
}

async function attachment(a: StoredAccount, mailbox: string, uid: number, index: number): Promise<MailAttachment> {
  const { mail } = await parsedMessage(a, mailbox, uid);
  const x = mail.attachments[index];
  if (!x) throw new Error('That attachment is gone.');
  const part = x.headers.get('x-din-part');
  let content: Uint8Array = x.content;
  if (typeof part === 'string') {
    content = await inMailbox(a, mailbox, async (client) => {
      const download = await client.download(String(uid), part, { uid: true, decodeText: false });
      if (!('content' in download) || !download.content) throw new Error('That attachment is gone.');
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    });
  }
  return { filename: x.filename || `Attachment ${index + 1}`, contentType: x.contentType, content: new Uint8Array(content) };
}

function uidList(v: unknown): number[] {
  if (!Array.isArray(v) || !v.length || v.length > 10_000) throw new Error('No messages');
  for (const u of v) if (!Number.isInteger(u) || u <= 0) throw new Error('Bad uid');
  return v as number[];
}

async function setFlags(a: StoredAccount, mailbox: string, uids: number[], flags: { seen?: unknown; flagged?: unknown }): Promise<void> {
  await inMailbox(a, mailbox, async (client) => {
    const range = uids.join(',');
    const apply = (on: unknown, flag: string) =>
      on === true ? client.messageFlagsAdd(range, [flag], { uid: true }) : on === false ? client.messageFlagsRemove(range, [flag], { uid: true }) : null;
    await apply(flags.seen, '\\Seen');
    await apply(flags.flagged, '\\Flagged');
  });
  const patch: Partial<Flags> = {};
  if (typeof flags.seen === 'boolean') patch.seen = flags.seen;
  if (typeof flags.flagged === 'boolean') patch.flagged = flags.flagged;
  storeOf(a).patchFlags(mailbox, uids, patch);
  changed(a.id, mailbox);
}

/** Mark every message in a mailbox read, in one command; how many were unread. */
async function markAllRead(a: StoredAccount, mailbox: string): Promise<number> {
  const count = await inMailbox(a, mailbox, async (client) => {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    // All of it by range, not the unread by uid: a big inbox's list of them
    // is longer than servers take a command (Dovecot's is 64 KB), and
    // imapflow answers a refused STORE with false, not an error.
    if (uids.length && !(await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true, silent: true }))) throw new Error('The server didn’t mark them read');
    return uids.length;
  });
  const store = storeOf(a);
  store.patchFlags(mailbox, store.allSummaries(mailbox).filter((s) => !s.seen).map((s) => s.uid), { seen: true });
  changed(a.id, mailbox);
  return count;
}

async function move(a: StoredAccount, mailbox: string, uids: number[], to: unknown): Promise<void> {
  let dest: string;
  if (typeof to === 'string') dest = to;
  else {
    const special = (to as { special?: unknown })?.special;
    if (special === 'archive') {
      // Gmail archives by taking the inbox's label away: All Mail has it already.
      dest = await specialPath(a, 'archive').catch(() => specialPath(a, 'all').catch(() => specialPath(a, 'archive', 'Archive')));
    } else if (special === 'trash') dest = await specialPath(a, 'trash', 'Trash');
    else if (special === 'junk') dest = await specialPath(a, 'junk', 'Junk');
    else if (special === 'inbox') dest = 'INBOX';
    else throw new Error('Nowhere to move to');
  }
  if (dest === mailbox) return;
  await inMailbox(a, mailbox, (client) => client.messageMove(uids.join(','), dest, { uid: true }));
  storeOf(a).removeUids(mailbox, uids);
  changed(a.id, mailbox);
  changed(a.id, dest);
  scheduleSync(a, dest, 0);
}

async function remove(a: StoredAccount, mailbox: string, uids: number[]): Promise<void> {
  const trash = await specialPath(a, 'trash', 'Trash');
  if (mailbox === trash) {
    await inMailbox(a, mailbox, (client) => client.messageDelete(uids.join(','), { uid: true }));
    storeOf(a).removeUids(mailbox, uids);
    changed(a.id, mailbox);
  } else {
    await move(a, mailbox, uids, trash);
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const NO_LABELS = 'This account’s server can’t keep labels.';

function isGmail(client: ImapFlow): boolean {
  return client.capabilities.has('X-GM-EXT-1');
}

/** Thunderbird's first five tags, by the names it gives them. */
const THUNDERBIRD_TAGS: Record<string, string> = { $label1: 'Important', $label2: 'Work', $label3: 'Personal', $label4: 'To Do', $label5: 'Later' };

/**
 * Whether a keyword is a label someone gave a message, not one a client
 * keeps for itself: the registry's $ keywords ($Forwarded, $Junk,
 * $MDNSent, Apple Mail's $MailFlagBit…) and Thunderbird's junk marks.
 */
function isLabelKeyword(k: string): boolean {
  if (k.startsWith('\\')) return false;
  if (k.toLowerCase() in THUNDERBIRD_TAGS) return true;
  if (k.startsWith('$')) return false;
  return !/^(junk|nonjunk|notjunk|forwarded|redirected|old)$/i.test(k);
}

/** A message's labels: Gmail's own but its system ones (\Inbox, \Starred…), else its label keywords. */
function labelsOf(m: Pick<FetchMessageObject, 'flags' | 'labels'>, gmail: boolean): string[] {
  const list = gmail ? [...(m.labels ?? [])].filter((l) => !l.startsWith('\\')) : [...(m.flags ?? [])].filter(isLabelKeyword);
  return [...new Set(list)].sort();
}

/** IMAP's modified UTF-7 (RFC 3501 5.1.3), which keeps a keyword's non-ASCII in an atom, as Thunderbird does. */
function toUtf7(s: string): string {
  return s.replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const buf = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) buf.writeUInt16BE(run.charCodeAt(i), i * 2);
    return `&${buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  });
}

function fromUtf7(s: string): string {
  return s.replace(/&([A-Za-z0-9+,]*)-/g, (_, b64: string) => {
    if (!b64) return '&';
    const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
    return out;
  });
}

/** The keyword for a new label's name: an IMAP atom, not one of the $ ones, not taken (keywords ignore case). */
function keywordFor(name: string, taken: Set<string>): string {
  let base = toUtf7(name)
    .replace(/[\s(){%*"\\\]]/g, '_')
    .slice(0, 200);
  if (base.startsWith('$')) base = `_${base.slice(1)}`;
  let k = base;
  for (let n = 2; taken.has(k.toLowerCase()); n++) k = `${base}_${n}`;
  return k;
}

/** What a keyword Din didn't name is called. */
function keywordName(k: string): string {
  return THUNDERBIRD_TAGS[k.toLowerCase()] ?? fromUtf7(k);
}

/** The label keywords found on each account's mail, by its stored copy. */
const foundKeywords = new WeakMap<MailStore, Set<string>>();

function keywordsOf(store: MailStore): Set<string> {
  let found = foundKeywords.get(store);
  if (!found) {
    try {
      const kept: unknown = JSON.parse(store.getMeta('keywords') ?? '[]');
      found = new Set(Array.isArray(kept) ? kept.filter((k): k is string => typeof k === 'string') : []);
    } catch {
      found = new Set();
    }
    foundKeywords.set(store, found);
  }
  return found;
}

function noteKeywords(store: MailStore, words: Iterable<string>): void {
  const found = keywordsOf(store);
  const lower = new Set([...found].map((k) => k.toLowerCase()));
  let added = false;
  for (const w of words) {
    if (!isLabelKeyword(w) || lower.has(w.toLowerCase())) continue;
    found.add(w);
    lower.add(w.toLowerCase());
    added = true;
  }
  if (added) store.setMeta('keywords', JSON.stringify([...found]));
}

/**
 * Note what a selected mailbox says of labels: Gmail's, or whether the
 * server takes new keywords (\* in the inbox's PERMANENTFLAGS), and the
 * keywords its FLAGS list. True on Gmail.
 */
function noteMailbox(store: MailStore, client: ImapFlow): boolean {
  const gmail = isGmail(client);
  const box = client.mailbox;
  if (!box) return gmail;
  const kind: LabelKind | null = gmail ? 'gmail' : isInbox(box.path) ? (box.permanentFlags?.has('\\*') ? 'keywords' : 'none') : null;
  if (kind && store.getMeta('labelKind') !== kind) store.setMeta('labelKind', kind);
  if (!gmail) noteKeywords(store, box.flags ?? []);
  return gmail;
}

function isLabelKind(v: unknown): v is LabelKind {
  return v === 'gmail' || v === 'keywords' || v === 'none';
}

/** How the account keeps labels: as last seen, or from its inbox. */
async function labelKind(a: StoredAccount): Promise<LabelKind> {
  const store = storeOf(a);
  const kept = store.getMeta('labelKind');
  if (isLabelKind(kept)) return kept;
  await inMailbox(a, 'INBOX', async (client) => void noteMailbox(store, client));
  const now = store.getMeta('labelKind');
  return isLabelKind(now) ? now : 'none';
}

/** Gmail's labels among its mailboxes: all but the inbox and Gmail's own ([Gmail]/…). */
function gmailLabelBoxes(boxes: MailboxInfo[]): MailboxInfo[] {
  const system = boxes.find((b) => b.special === 'all')?.parent || '[Gmail]';
  return boxes.filter((b) => b.selectable && !b.special && !isInbox(b.path) && b.path !== system && !b.path.startsWith(`${system}${b.delimiter}`));
}

function savedLabel(a: StoredAccount, id: string): SavedLabel | undefined {
  return a.labels?.find((l) => l.id.toLowerCase() === id.toLowerCase());
}

/** Keep (or with `null`, forget) what Din knows of a label. */
function keepLabel(a: StoredAccount, id: string, patch: Omit<SavedLabel, 'id'> | null): void {
  const list = (a.labels ??= []);
  const at = list.findIndex((l) => l.id.toLowerCase() === id.toLowerCase());
  if (patch === null) {
    if (at >= 0) list.splice(at, 1);
  } else {
    const next: SavedLabel = { id };
    if (patch.name) next.name = patch.name;
    if (patch.color) next.color = patch.color;
    if (patch.deleted) next.deleted = true;
    if (at >= 0) list[at] = next;
    else list.push(next);
  }
  save();
}

async function labels(a: StoredAccount): Promise<MailLabels> {
  const kind = await labelKind(a);
  const color = (id: string) => savedLabel(a, id)?.color ?? null;
  let list: MailLabel[] = [];
  if (kind === 'gmail') {
    list = gmailLabelBoxes(await mailboxes(a)).map((b) => ({ id: b.path, name: b.path, color: color(b.path), path: b.path }));
  } else if (kind === 'keywords') {
    const ids = new Map<string, string>();
    for (const k of [...(a.labels ?? []).map((l) => l.id), ...keywordsOf(storeOf(a))]) {
      if (!savedLabel(a, k)?.deleted && !ids.has(k.toLowerCase())) ids.set(k.toLowerCase(), k);
    }
    list = [...ids.values()].map((id) => ({ id, name: savedLabel(a, id)?.name || keywordName(id), color: color(id), path: null }));
  }
  return { kind, labels: list.sort((x, y) => x.name.localeCompare(y.name)) };
}

function labelNameArg(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new Error('Give the label a name.');
  if (name.length > 100) throw new Error('That name is too long.');
  if (name.startsWith('\\')) throw new Error('A label’s name can’t start with \\.');
  return name;
}

const COLOR = /^[a-z]{1,16}$/;

function colorArg(v: unknown): LabelColor | null {
  return typeof v === 'string' && COLOR.test(v) ? (v as LabelColor) : null;
}

function labelIdArg(v: unknown): string {
  // Never a system flag: \Deleted isn't a label.
  if (typeof v !== 'string' || !v || v.length > 300 || v.startsWith('\\') || /[\r\n\0]/.test(v)) throw new Error('No such label');
  return v;
}

function labelIdList(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) throw new Error('Bad labels');
  return [...new Set(v.map(labelIdArg))];
}

async function createLabel(a: StoredAccount, input: unknown): Promise<MailLabel> {
  const i = (input ?? {}) as { name?: unknown; color?: unknown };
  const name = labelNameArg(i.name);
  const color = colorArg(i.color);
  const { kind, labels: list } = await labels(a);
  if (kind === 'none') throw new Error(NO_LABELS);
  if (list.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new Error(`There’s already a label called “${name}”.`);
  if (kind === 'gmail') {
    const client = await connection(a);
    const made = await client.mailboxCreate(name).catch((error: unknown) => {
      throw explain(error);
    });
    keepLabel(a, made.path, { color });
    return { id: made.path, name: made.path, color, path: made.path };
  }
  const id = keywordFor(name, new Set(list.map((l) => l.id.toLowerCase())));
  keepLabel(a, id, { name, color });
  return { id, name, color, path: null };
}

async function updateLabel(a: StoredAccount, id: string, patch: unknown): Promise<MailLabel> {
  const p = (patch ?? {}) as { name?: unknown; color?: unknown };
  const { kind, labels: list } = await labels(a);
  const label = list.find((l) => l.id === id);
  if (!label) throw new Error('That label is gone.');
  const next = { ...label };
  if (p.color !== undefined) next.color = colorArg(p.color);
  if (p.name !== undefined) {
    const name = labelNameArg(p.name);
    if (list.some((l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase())) throw new Error(`There’s already a label called “${name}”.`);
    if (kind === 'gmail' && name !== label.name) {
      // Gmail renames the label on every message, and the labels inside it.
      const delimiter = (await mailboxes(a)).find((b) => b.path === label.id)?.delimiter || '/';
      const client = await connection(a);
      const moved = await client.mailboxRename(label.id, name).catch((error: unknown) => {
        throw explain(error);
      });
      const store = storeOf(a);
      for (const l of list) {
        if (l.id !== label.id && !l.id.startsWith(`${label.id}${delimiter}`)) continue;
        const to = l.id === label.id ? moved.newPath : `${moved.newPath}${l.id.slice(label.id.length)}`;
        store.forget(l.id);
        store.relabel(l.id, to);
        const kept = savedLabel(a, l.id);
        keepLabel(a, l.id, null);
        if (kept?.color) keepLabel(a, to, { color: kept.color });
      }
      next.id = next.path = next.name = moved.newPath;
    } else {
      next.name = name;
    }
  }
  keepLabel(a, next.id, { name: kind === 'keywords' ? next.name : undefined, color: next.color });
  return next;
}

async function deleteLabel(a: StoredAccount, id: string): Promise<void> {
  const kind = await labelKind(a);
  const store = storeOf(a);
  if (kind === 'gmail') {
    // Gmail takes it off every message, which stay in All Mail.
    const client = await connection(a);
    await client.mailboxDelete(id).catch((error: unknown) => {
      throw explain(error);
    });
    store.forget(id);
    store.relabel(id, null);
    keepLabel(a, id, null);
    return;
  }
  if (kind !== 'keywords') throw new Error(NO_LABELS);
  const failed: string[] = [];
  for (const box of (await mailboxes(a)).filter((b) => b.selectable)) {
    try {
      const found = await inMailbox(a, box.path, async (client) => {
        if (!client.mailbox || !client.mailbox.exists) return false;
        const uids = (await client.search({ keyword: id }, { uid: true })) || [];
        if (!uids.length) return false;
        if (!(await client.messageFlagsRemove(uidRanges(uids), [id], { uid: true, silent: true }))) throw new Error('The server refused');
        return true;
      });
      if (found) changed(a.id, box.path);
    } catch {
      failed.push(box.name);
    }
  }
  store.relabel(id, null);
  // Servers go on listing a keyword in FLAGS once it's been used.
  keepLabel(a, id, { deleted: true });
  if (failed.length) throw new Error(`The label is deleted, but it couldn’t be taken off the messages in ${failed.join(', ')}.`);
}

async function setLabels(a: StoredAccount, mailbox: string, uids: number[], change: unknown): Promise<void> {
  const c = (change ?? {}) as { add?: unknown; remove?: unknown };
  const add = labelIdList(c.add);
  const remove = labelIdList(c.remove).filter((l) => !add.includes(l));
  if (!add.length && !remove.length) return;
  let gmail = false;
  await inMailbox(a, mailbox, async (client) => {
    gmail = isGmail(client);
    const range = uidRanges(uids);
    const options = { uid: true, useLabels: gmail };
    // imapflow answers a refused STORE, or keywords the mailbox won't take, with false.
    if (add.length && !(await client.messageFlagsAdd(range, add, options))) throw new Error(gmail ? 'Gmail didn’t add the label.' : 'The server didn’t keep the label.');
    if (remove.length && !(await client.messageFlagsRemove(range, remove, options))) throw new Error('The server didn’t take the label off.');
  });
  const store = storeOf(a);
  if (!gmail) noteKeywords(store, add);
  store.patchLabels(mailbox, uids, add, remove);
  // On Gmail a label is a mailbox: the messages joined or left it.
  if (gmail && remove.includes(mailbox)) store.removeUids(mailbox, uids);
  changed(a.id, mailbox);
  if (gmail) for (const l of [...add, ...remove]) if (l !== mailbox) scheduleSync(a, l, 0);
}

// ---------------------------------------------------------------------------
// Inbox tabs
// ---------------------------------------------------------------------------

/** Every inbox is sorted again: the app reads its lists again, and the Dock's counts are counted again. */
function retabbed(list: StoredAccount[]): void {
  for (const a of list) changed(a.id, 'INBOX');
}

function setInboxTabs(patch: unknown): InboxTabs {
  const p = (patch ?? {}) as { tabs?: unknown; notify?: unknown };
  const next = { ...inboxTabs };
  if (p.tabs !== undefined) {
    if (!Array.isArray(p.tabs)) throw new Error('Bad tabs');
    next.tabs = tabList(p.tabs);
  }
  if (p.notify !== undefined) {
    if (p.notify !== 'primary' && p.notify !== 'all') throw new Error('Bad notify');
    next.notify = p.notify;
  }
  inboxTabs = next;
  save();
  retabbed(accounts);
  return inboxTabs;
}

/** The dates of each tab's newest unread mail, from the inbox's stored copy. */
function tabCounts(a: StoredAccount): Record<MailCategory, number[]> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, [] as number[]])) as Record<MailCategory, number[]>;
  for (const s of storeOf(a).unreadSummaries('INBOX')) if (!s.draft) out[tabOf(a, s)].push(s.date);
  for (const c of CATEGORIES) out[c] = out[c].sort((x, y) => y - x).slice(0, 100);
  return out;
}

const TAB_RULES_MAX = 1000;

function setTabRule(a: StoredAccount, address: unknown, category: unknown): void {
  const sender = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (sender.length > 320 || !RULE_ADDRESS.test(sender)) throw new Error('That isn’t an email address.');
  if (category !== null && !isCategory(category)) throw new Error('No such tab');
  const rules = { ...a.tabRules };
  if (category === null) delete rules[sender];
  else rules[sender] = category;
  if (Object.keys(rules).length > TAB_RULES_MAX) throw new Error('That’s too many senders moved to tabs.');
  a.tabRules = rules;
  save();
  retabbed([a]);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function addressList(v: unknown): MailAddress[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is MailAddress => typeof x === 'object' && x !== null && typeof (x as MailAddress).address === 'string')
    .map((x) => ({ name: text(x.name, 200).replace(/[\r\n]/g, ' '), address: x.address.trim() }))
    .filter((x) => EMAIL.test(x.address))
    .slice(0, 500);
}

function outgoing(v: unknown): OutgoingMessage {
  const m = (v ?? {}) as Partial<OutgoingMessage>;
  const attachments = Array.isArray(m.attachments)
    ? m.attachments
        .filter((x) => x && x.content instanceof Uint8Array)
        .map((x) => ({ filename: text(x.filename, 255) || 'Attachment', contentType: text(x.contentType, 200) || 'application/octet-stream', content: x.content }))
    : [];
  const answering = m.answering && typeof m.answering.path === 'string' && Number.isInteger(m.answering.uid) ? { path: m.answering.path, uid: m.answering.uid } : null;
  return {
    to: addressList(m.to),
    cc: addressList(m.cc),
    bcc: addressList(m.bcc),
    subject: text(m.subject, 2000).replace(/[\r\n]+/g, ' '),
    text: text(m.text, 10_000_000),
    html: text(m.html, 20_000_000),
    attachments,
    inReplyTo: typeof m.inReplyTo === 'string' ? m.inReplyTo.slice(0, 1000) : null,
    references: Array.isArray(m.references) ? m.references.filter((r): r is string => typeof r === 'string').slice(-50) : [],
    answering,
    draftUid: Number.isInteger(m.draftUid) && (m.draftUid as number) > 0 ? (m.draftUid as number) : null,
  };
}

function composer(a: StoredAccount, m: OutgoingMessage, messageId: string): MailComposer {
  return new MailComposer({
    messageId,
    from: { name: a.fullName, address: a.email },
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    text: m.text,
    html: m.html || undefined,
    attachments: m.attachments.map((x) => ({ filename: x.filename, contentType: x.contentType, content: Buffer.from(x.content) })),
    inReplyTo: m.inReplyTo || undefined,
    references: m.references?.length ? m.references : undefined,
    date: new Date(),
  });
}

/** The message as sent; `keepBcc` for the copies kept in Sent and Drafts. */
async function buildRaw(a: StoredAccount, m: OutgoingMessage, messageId: string, keepBcc: boolean): Promise<Buffer> {
  const node = composer(a, m, messageId).compile();
  node.keepBcc = keepBcc;
  return new Promise((resolve, reject) => node.build((error, raw) => (error ? reject(error) : resolve(raw))));
}

function newMessageId(a: StoredAccount): string {
  return `<${randomUUID()}@${a.email.split('@')[1] ?? 'din.local'}>`;
}

/** Servers that file a copy in Sent themselves. */
function keepsSentCopy(server: MailServer): boolean {
  return /(^|\.)gmail\.com$|(^|\.)office365\.com$|(^|\.)outlook\.com$/i.test(server.host);
}

async function deleteDraft(a: StoredAccount, uid: number): Promise<void> {
  const drafts = await specialPath(a, 'drafts').catch(() => null);
  if (!drafts) return;
  await inMailbox(a, drafts, (client) => client.messageDelete(String(uid), { uid: true }))
    .then(() => storeOf(a).removeUids(drafts, [uid]))
    .catch(() => {});
  changed(a.id, drafts);
}

async function send(a: StoredAccount, m: OutgoingMessage): Promise<void> {
  const recipients = [...m.to, ...m.cc, ...m.bcc].map((x) => x.address);
  if (!recipients.length) throw new Error('Add someone to send it to.');
  const size = m.attachments.reduce((n, x) => n + x.content.byteLength, 0);
  if (size > MAX_SEND_BYTES) throw new Error('The attachments are too big to send by email.');
  const messageId = newMessageId(a);
  const raw = await buildRaw(a, m, messageId, false);
  const transport = smtpTransport(a.smtp, unseal(a.password));
  try {
    await transport.sendMail({ envelope: { from: a.email, to: recipients }, raw });
  } catch (error) {
    throw explain(error);
  } finally {
    transport.close();
  }
  // What's left is bookkeeping: the message has gone either way.
  if (!keepsSentCopy(a.smtp)) {
    try {
      const sent = await specialPath(a, 'sent', 'Sent');
      const client = await connection(a);
      await client.append(sent, await buildRaw(a, m, messageId, true), ['\\Seen']);
      changed(a.id, sent);
      scheduleSync(a, sent, 0);
    } catch {
      // No Sent copy, but the message went.
    }
  } else {
    void specialPath(a, 'sent').then((sent) => scheduleSync(a, sent, 2000)).catch(() => {});
  }
  rememberCorrespondents(a, recipients);
  if (m.answering) await setFlagsRaw(a, m.answering.path, m.answering.uid, '\\Answered').catch(() => {});
  if (m.draftUid) await deleteDraft(a, m.draftUid);
}

async function setFlagsRaw(a: StoredAccount, mailbox: string, uid: number, flag: string): Promise<void> {
  await inMailbox(a, mailbox, (client) => client.messageFlagsAdd(String(uid), [flag], { uid: true }));
  if (flag === '\\Answered') storeOf(a).patchFlags(mailbox, [uid], { answered: true });
  changed(a.id, mailbox);
}

async function saveDraft(a: StoredAccount, m: OutgoingMessage): Promise<number | null> {
  const drafts = await specialPath(a, 'drafts', 'Drafts');
  const client = await connection(a);
  let appended;
  try {
    appended = await client.append(drafts, await buildRaw(a, m, newMessageId(a), true), ['\\Draft', '\\Seen']);
  } catch (error) {
    throw explain(error);
  }
  if (m.draftUid) await deleteDraft(a, m.draftUid);
  changed(a.id, drafts);
  scheduleSync(a, drafts, 0);
  return appended && appended.uid ? appended.uid : null;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Lists may take a while to stop (US law gives them ten days); mail within this of leaving doesn't count against them. */
const UNSUBSCRIBE_GRACE_MS = 2 * DAY_MS;
const HEADER_CHUNK = 500;

/** When each list was left from here, by its key. */
function unsubscribedFrom(a: StoredAccount): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(storeOf(a).getMeta('unsubscribed') ?? '{}');
    return typeof saved === 'object' && saved !== null ? (saved as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function markUnsubscribed(a: StoredAccount, id: string): void {
  storeOf(a).setMeta('unsubscribed', JSON.stringify({ ...unsubscribedFrom(a), [id]: Date.now() }));
}

function unsubscribeInfo(a: StoredAccount, h: ListHeader): UnsubscribeInfo {
  const id = listKey(h);
  return { id, method: methodOf(h), verified: h.verified, unsubscribed: unsubscribedFrom(a)[id] ?? null };
}

function parsedListHeader(mail: ParsedMail, s: MessageSummary): ListHeader | null {
  const raw = mail.headerLines.filter((l) => LIST_HEADERS.includes(l.key)).map((l) => l.line).join('\r\n');
  return listHeader(headerFields(raw), s.from[0], s.date);
}

async function inboxPath(a: StoredAccount): Promise<string> {
  return specialPath(a, 'inbox').catch(() => 'INBOX');
}

/** The list headers of the inbox's mail since `from`: kept ones as they are, the rest fetched and kept. */
async function inboxListHeaders(a: StoredAccount, inbox: string, from: number): Promise<Map<number, ListHeader>> {
  const store = storeOf(a);
  const uids = await inMailbox(a, inbox, async (client) => {
    const box = client.mailbox;
    if (!box) return [];
    checkValidity(a, store, inbox, String(box.uidValidity));
    if (!box.exists) return [];
    return (await client.search({ since: new Date(from) }, { uid: true })) || [];
  });
  const kept = store.listHeaders(inbox, uids);
  const want = uids.filter((u) => !kept.has(u)).sort((x, y) => y - x);
  // A slice at a time, so the rest of Mail isn't kept waiting on the mailbox.
  for (let i = 0; i < want.length; i += HEADER_CHUNK) {
    const some = want.slice(i, i + HEADER_CHUNK);
    const found = await inMailbox(a, inbox, async (client) => {
      const out: [number, ListHeader | null][] = [];
      for await (const m of client.fetch(uidRanges(some), { uid: true, envelope: true, internalDate: true, headers: LIST_HEADERS }, { uid: true })) {
        const when = m.envelope?.date ?? m.internalDate;
        out.push([m.uid, listHeader(headerFields(m.headers?.toString('utf8') ?? ''), addresses(m.envelope?.from)[0], when ? new Date(when).getTime() || 0 : 0)]);
      }
      return out;
    });
    store.putListHeaders(inbox, found);
    for (const [uid, h] of found) kept.set(uid, h);
  }
  const out = new Map<number, ListHeader>();
  for (const [uid, h] of kept) if (h) out.set(uid, h);
  return out;
}

interface ListGroup {
  /** The newest message's headers. */
  newest: ListHeader;
  uids: number[];
  dates: number[];
}

function groupLists(headers: Map<number, ListHeader>): Map<string, ListGroup> {
  const groups = new Map<string, ListGroup>();
  for (const [uid, h] of headers) {
    const key = listKey(h);
    const g = groups.get(key);
    if (!g) groups.set(key, { newest: h, uids: [uid], dates: [h.date] });
    else {
      g.uids.push(uid);
      g.dates.push(h.date);
      if (h.date > g.newest.date) g.newest = h;
    }
  }
  return groups;
}

async function subscriptions(a: StoredAccount, months: number): Promise<SubscriptionScan> {
  const from = Date.now() - Math.round(months * 30.44 * DAY_MS);
  const inbox = await inboxPath(a);
  const groups = groupLists(await inboxListHeaders(a, inbox, from));
  const left = unsubscribedFrom(a);
  const list: MailSubscription[] = [];
  for (const [id, g] of groups) {
    const unsubscribed = left[id] ?? null;
    list.push({
      id,
      accountId: a.id,
      name: g.newest.name,
      address: g.newest.address,
      listId: g.newest.listId,
      count: g.uids.length,
      last: Math.max(...g.dates),
      method: methodOf(g.newest),
      verified: g.newest.verified,
      unsubscribed,
      since: unsubscribed === null ? 0 : g.dates.filter((d) => d > unsubscribed + UNSUBSCRIBE_GRACE_MS).length,
    });
  }
  list.sort((x, y) => y.count - x.count || y.last - x.last);
  return { subscriptions: list, from };
}

/** Write to a list's address from the account, as its mailto: link asks. */
async function sendUnsubscribe(a: StoredAccount, link: string): Promise<void> {
  const m = parseUnsubscribeMailto(link);
  if (!EMAIL.test(m.to)) throw new Error('The unsubscribe address isn’t valid.');
  await send(a, outgoing({ to: [{ name: '', address: m.to }], cc: [], bcc: [], subject: m.subject, text: m.body, html: '', attachments: [] }));
}

/** Leave a list the best way it offers, falling back to the next. */
async function leave(a: StoredAccount, h: ListHeader): Promise<Omit<UnsubscribeResult, 'trashed'>> {
  const id = listKey(h);
  let error: string | null = null;
  const https = httpsLink(h);
  if (h.oneClick && https) {
    try {
      await postOneClick(https);
      markUnsubscribed(a, id);
      return { id, status: 'done', method: 'one-click', url: null, error: null };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const mailto = mailtoLink(h);
  if (mailto) {
    try {
      await sendUnsubscribe(a, mailto);
      markUnsubscribed(a, id);
      return { id, status: 'done', method: 'email', url: null, error: null };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const web = webLink(h);
  if (web) return { id, status: 'page', method: 'web', url: web, error };
  return { id, status: 'failed', method: null, url: null, error: error ?? 'It doesn’t say how to unsubscribe.' };
}

/** A list's mail in the inbox: what Subscriptions has seen, and older mail the server finds. */
async function listMail(a: StoredAccount, inbox: string, g: ListGroup): Promise<number[]> {
  const found = await inMailbox(a, inbox, async (client) => {
    const criteria: SearchObject = g.newest.listId ? { header: { 'list-id': g.newest.listId } } : { from: g.newest.address };
    const uids = await client.search(criteria, { uid: true }).catch(() => false as const);
    return Array.isArray(uids) ? uids : [];
  });
  return [...new Set([...g.uids, ...found])];
}

/** Run over a list a few at a time. */
async function inBatches<T, R>(list: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < list.length; i += size) out.push(...(await Promise.all(list.slice(i, i + size).map(fn))));
  return out;
}

async function unsubscribe(a: StoredAccount, ids: string[], trash: boolean): Promise<UnsubscribeResult[]> {
  const inbox = await inboxPath(a);
  const groups = groupLists(storeOf(a).allListHeaders(inbox));
  const results = await inBatches(ids, 4, async (id): Promise<UnsubscribeResult> => {
    const g = groups.get(id);
    if (!g) return { id, status: 'failed', method: null, url: null, error: 'Mail hasn’t seen that list in the inbox.', trashed: 0 };
    return { ...(await leave(a, g.newest)), trashed: 0 };
  });
  if (trash) {
    for (const r of results) {
      const g = groups.get(r.id);
      if (!g) continue;
      try {
        const uids = await listMail(a, inbox, g);
        if (uids.length) await move(a, inbox, uids, { special: 'trash' });
        r.trashed = uids.length;
      } catch (e) {
        if (!r.error) r.error = `Its mail couldn’t be moved to the Trash: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  return results;
}

async function unsubscribeMessage(a: StoredAccount, mailbox: string, uid: number): Promise<UnsubscribeResult> {
  const { summary: s, mail } = await parsedMessage(a, mailbox, uid);
  const h = parsedListHeader(mail, s);
  if (!h) throw new Error('This message doesn’t say how to unsubscribe.');
  return { ...(await leave(a, h)), trashed: 0 };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function verify(imap: MailServer, smtp: MailServer, password: string): Promise<void> {
  const client = imapClient(imap, password);
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    const e = explain(error);
    throw new Error(`Incoming mail (${imap.host}): ${e.message}`, { cause: error });
  }
  void client.logout().catch(() => client.close());
  const transport = smtpTransport(smtp, password);
  try {
    await transport.verify();
  } catch (error) {
    const e = explain(error);
    throw new Error(`Outgoing mail (${smtp.host}): ${e.message}`, { cause: error });
  } finally {
    transport.close();
  }
}

async function addAccount(input: unknown): Promise<MailAccount> {
  const n = (input ?? {}) as NewMailAccount;
  const email = text(n.email, 320).trim();
  if (!EMAIL.test(email)) throw new Error('That isn’t an email address.');
  if (typeof n.password !== 'string' || !n.password) throw new Error('Enter the password.');
  if (!isServer(n.imap) || !isServer(n.smtp)) throw new Error('Check the server settings.');
  if (accounts.some((x) => x.email.toLowerCase() === email.toLowerCase())) throw new Error('That account is already set up.');
  await verify(n.imap, n.smtp, n.password);
  const stored: StoredAccount = {
    id: randomUUID(),
    name: text(n.name, 100).trim() || email.split('@')[1],
    fullName: text(n.fullName, 200).trim().replace(/[\r\n]/g, ' '),
    email,
    imap: { ...n.imap },
    smtp: { ...n.smtp },
    signature: '',
    password: seal(n.password),
  };
  accounts.push(stored);
  save();
  watch(stored, sessionOf(stored.id, false));
  return publicAccount(stored);
}

async function updateAccount(id: unknown, patch: unknown): Promise<MailAccount> {
  const a = account(id);
  const p = (patch ?? {}) as MailAccountPatch;
  const imap = p.imap === undefined ? a.imap : p.imap;
  const smtp = p.smtp === undefined ? a.smtp : p.smtp;
  if (!isServer(imap) || !isServer(smtp)) throw new Error('Check the server settings.');
  const servers = p.imap !== undefined || p.smtp !== undefined || typeof p.password === 'string';
  // The stored password goes only to the servers it was given for: another
  // host, port or user (or any SMTP change) needs it typed again, or whoever
  // could change the settings could send it anywhere.
  const sameServer = (x: typeof imap, y: typeof imap) => x.host === y.host && x.port === y.port && x.user === y.user;
  const typed = typeof p.password === 'string' && p.password ? p.password : null;
  if (!typed && (!sameServer(imap, a.imap) || !sameServer(smtp, a.smtp))) throw new Error('Enter the password for the new server settings.');
  const password = typed ?? unseal(a.password);
  if (servers) await verify(imap, smtp, password);
  if (typeof p.name === 'string') a.name = p.name.trim().slice(0, 100) || a.name;
  if (typeof p.fullName === 'string') a.fullName = p.fullName.trim().slice(0, 200).replace(/[\r\n]/g, ' ');
  if (typeof p.signature === 'string') a.signature = p.signature.slice(0, 10_000);
  const movedServer = a.imap.host !== imap.host || a.imap.port !== imap.port || a.imap.user !== imap.user;
  a.imap = { ...imap };
  a.smtp = { ...smtp };
  if (typeof p.password === 'string' && p.password) a.password = seal(p.password);
  save();
  if (servers) closeSession(a.id);
  // Another server numbers its messages its own way.
  if (movedServer) {
    a.labels = undefined;
    save();
    dropStore(a.id);
    forgetArrivals(a.id);
  }
  if (servers) watch(a, sessionOf(a.id, false));
  return publicAccount(a);
}

function mailboxArg(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 1000) throw new Error('No mailbox');
  return v;
}

export function registerMailHandlers(options: Deps): void {
  deps = options;
  const { assertShellSender } = options;
  load();

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertShellSender(event);
      return fn(...args);
    });
  };

  handle('mail:accounts', () => accounts.map(publicAccount));
  handle('mail:unseen', () => Object.fromEntries(unseen));
  handle('mail:discover', (email) => {
    if (typeof email !== 'string' || !EMAIL.test(email.trim())) throw new Error('That isn’t an email address.');
    return discover(email.trim());
  });
  handle('mail:addAccount', (input) => addAccount(input));
  handle('mail:updateAccount', (id, patch) => updateAccount(id, patch));
  handle('mail:removeAccount', (id) => {
    const a = account(id);
    accounts = accounts.filter((x) => x !== a);
    closeSession(a.id);
    dropStore(a.id);
    forgetArrivals(a.id);
    save();
  });
  handle('mail:mailboxes', (id) => mailboxes(account(id)));
  handle('mail:messages', (id, mailbox, opts) => {
    const o = (opts ?? {}) as { before?: unknown; limit?: unknown; query?: unknown; filter?: unknown; label?: unknown; category?: unknown };
    const filter = o.filter === 'unread' || o.filter === 'flagged' ? o.filter : null;
    const before = Number.isInteger(o.before) && (o.before as number) > 0 ? (o.before as number) : undefined;
    const limit = Number.isInteger(o.limit) ? Math.min(Math.max(o.limit as number, 1), 200) : PAGE;
    const label = o.label === undefined || o.label === '' ? '' : labelIdArg(o.label);
    const category = isCategory(o.category) ? o.category : null;
    return messages(account(id), mailboxArg(mailbox), before, limit, text(o.query, 500).trim(), filter, label, category);
  });
  handle('mail:message', (id, mailbox, uid) => {
    if (!Number.isInteger(uid)) throw new Error('Bad uid');
    return message(account(id), mailboxArg(mailbox), uid as number);
  });
  handle('mail:conversation', (id, opts) => {
    const o = (opts ?? {}) as { messageIds?: unknown; threadId?: unknown; since?: unknown };
    const ids = Array.isArray(o.messageIds) ? o.messageIds.filter((x): x is string => typeof x === 'string' && /^<[^<>\s]{1,500}>$/.test(x)).slice(0, 30) : [];
    const threadId = typeof o.threadId === 'string' && /^[\w.-]{1,200}$/.test(o.threadId) ? o.threadId : null;
    const since = typeof o.since === 'number' && o.since > 0 ? o.since : undefined;
    return conversation(account(id), [...new Set(ids)], threadId, since);
  });
  handle('mail:attachment', (id, mailbox, uid, index) => {
    if (!Number.isInteger(uid) || !Number.isInteger(index)) throw new Error('Bad attachment');
    return attachment(account(id), mailboxArg(mailbox), uid as number, index as number);
  });
  handle('mail:setFlags', (id, mailbox, uids, flags) =>
    setFlags(account(id), mailboxArg(mailbox), uidList(uids), (flags ?? {}) as { seen?: unknown; flagged?: unknown }),
  );
  handle('mail:labels', (id) => labels(account(id)));
  handle('mail:createLabel', (id, label) => createLabel(account(id), label));
  handle('mail:updateLabel', (id, labelId, patch) => updateLabel(account(id), labelIdArg(labelId), patch));
  handle('mail:deleteLabel', (id, labelId) => deleteLabel(account(id), labelIdArg(labelId)));
  handle('mail:setLabels', (id, mailbox, uids, change) => setLabels(account(id), mailboxArg(mailbox), uidList(uids), change));
  handle('mail:avatar', (address) => {
    if (typeof address !== 'string') throw new Error('No address');
    return avatar(address);
  });
  handle('mail:avatarLookups', () => avatarLookups());
  handle('mail:setAvatarLookups', (on) => setAvatarLookups(on === true));
  handle('mail:inboxTabs', () => inboxTabs);
  handle('mail:setInboxTabs', (patch) => setInboxTabs(patch));
  handle('mail:tabCounts', (id) => tabCounts(account(id)));
  handle('mail:tabRules', (id) => ({ ...account(id).tabRules }));
  handle('mail:setTabRule', (id, address, category) => setTabRule(account(id), address, category));
  handle('mail:markAllRead', (id, mailbox) => markAllRead(account(id), mailboxArg(mailbox)));
  handle('mail:move', (id, mailbox, uids, to) => move(account(id), mailboxArg(mailbox), uidList(uids), to));
  handle('mail:remove', (id, mailbox, uids) => remove(account(id), mailboxArg(mailbox), uidList(uids)));
  handle('mail:send', (id, m) => send(account(id), outgoing(m)));
  handle('mail:saveDraft', (id, m) => saveDraft(account(id), outgoing(m)));
  handle('mail:subscriptions', (id, opts) => {
    const months = (opts as { months?: unknown } | undefined)?.months;
    return subscriptions(account(id), typeof months === 'number' && months >= 1 && months <= 240 ? months : 6);
  });
  handle('mail:unsubscribe', (id, ids, opts) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((x) => typeof x === 'string' && x.length <= 1000)) throw new Error('No lists');
    return unsubscribe(account(id), [...new Set(ids as string[])], (opts as { trash?: unknown } | undefined)?.trash === true);
  });
  handle('mail:unsubscribeMessage', (id, mailbox, uid) => {
    if (!Number.isInteger(uid)) throw new Error('Bad uid');
    return unsubscribeMessage(account(id), mailboxArg(mailbox), uid as number);
  });

  // A moment after Din starts, out of its way.
  setTimeout(watchAll, 5000).unref();
  powerMonitor.on('resume', () => setTimeout(rewatchAll, 3000).unref());

  app.on('will-quit', () => {
    for (const id of [...sessions.keys()]) closeSession(id);
  });
}

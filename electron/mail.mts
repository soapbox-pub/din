// Mail (din.system.mail, for the Mail app in src/apps/mail/): IMAP and SMTP
// accounts, the way Apple Mail does them, behind the `mail:*` channels.
//
// Apps can't open sockets, so the accounts live here. Each account's
// settings are kept in userData/mail/accounts.json with its password sealed
// by safeStorage (the login keyring, see main.mts's --password-store; only
// base64 where there's none), and never go back to the app. Each
// account gets one IMAP connection for what the app asks (imapflow queues
// commands behind its mailbox locks) and one more that idles on the inbox,
// so new mail shows up as it arrives; both close after a while without
// calls, and the app's periodic refresh keeps them up while it's open.
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
// Types are src/lib/mail.ts. Runs as TypeScript directly via Node's native
// type stripping - erasable syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { app, ipcMain, net, safeStorage } from 'electron';
import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageAddressObject, type MessageStructureObject, type SearchObject } from 'imapflow';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { MailStore, type Flags } from './mail-store.mts';
import type {
  MailAccount,
  MailAccountPatch,
  MailAddress,
  MailAttachment,
  MailboxInfo,
  MailMessage,
  MailServer,
  MailSettings,
  MessageFilter,
  MessagePage,
  MessageSummary,
  NewMailAccount,
  OutgoingMessage,
  SpecialMailbox,
} from '../src/lib/mail.ts';

interface Deps {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}

interface StoredAccount extends MailAccount {
  /** `enc:` + safeStorage ciphertext (base64), or `plain:` where there's no keyring. */
  password: string;
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
  fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
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
  const { password: _password, ...rest } = a;
  return rest;
}

function account(id: unknown): StoredAccount {
  const a = accounts.find((x) => x.id === id);
  if (!a) throw new Error('No such account');
  return a;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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
  lastUse: number;
  /** Mailbox paths by special use, from the last listing. */
  specials: Map<SpecialMailbox, string>;
}

const sessions = new Map<string, Session>();

/** An account's session; `touch` when the app asked, keeping its connections up. */
function sessionOf(id: string, touch = true): Session {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { client: null, connecting: null, watcher: null, watching: false, lastUse: 0, specials: new Map() }));
  if (touch) s.lastUse = Date.now();
  return s;
}

const pending = new Map<string, NodeJS.Timeout>();

/** Tell the apps a mailbox changed, once per burst. */
function changed(accountId: string, mailbox: string): void {
  const key = `${accountId}\0${mailbox}`;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    deps.sendToShell('mail:changed', { accountId, path: mailbox });
  }, 250));
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

/** Keep a second connection idling on the inbox, for new mail. */
function watch(a: StoredAccount, s: Session): void {
  if (s.watching) return;
  s.watching = true;
  // It idles right away, and renews the IDLE now and then for servers that drop quiet ones.
  const client = imapClient(a.imap, unseal(a.password), { autoIdleDelay: 500, maxIdleTime: 5 * 60_000 });
  listen(a, client);
  s.watcher = client;
  let retry: NodeJS.Timeout | null = null;
  client.on('close', () => {
    if (s.watcher !== client) return;
    s.watcher = null;
    s.watching = false;
    // Reconnect while the app is still using the account.
    if (Date.now() - s.lastUse < IDLE_CLOSE_MS && accounts.some((x) => x.id === a.id)) {
      retry = setTimeout(() => {
        retry = null;
        if (!s.watching) watch(a, s);
      }, 15_000);
      retry.unref();
    }
  });
  client
    .connect()
    .then(() => client.mailboxOpen('INBOX', { readOnly: true }))
    .catch(() => {
      // The main connection reports problems; this one just stops.
      client.close();
    });
}

function closeSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.watching = true;
  for (const client of [s.client, s.watcher]) {
    if (client) void client.logout().catch(() => client.close());
  }
}

setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.lastUse > IDLE_CLOSE_MS) closeSession(id);
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
 * has, and filters it.
 */
function storedPage(store: MailStore, mailbox: string, before: number | undefined, limit: number, filter: MessageFilter = null, fallback = false): MessagePage | null {
  const box = store.box(mailbox);
  if (!box) return null;
  if (!fallback) {
    const older = before ? box.uids.filter((u) => u < before) : box.uids;
    const page = older.slice(0, limit);
    const kept = store.summaries(mailbox, page);
    if (kept.size < page.length) return null;
    return { messages: byDate([...kept.values()].map((k) => k.summary)), total: box.uids.length, more: older.length > page.length };
  }
  const all = store.allSummaries(mailbox, before).filter((s) => (filter === 'unread' ? !s.seen : filter === 'flagged' ? s.flagged : true));
  return { messages: byDate(all.slice(0, limit)), total: filter ? all.length : box.uids.length, more: all.length > limit };
}

/** Fetch and keep the summaries of these messages, with previews for those that have none yet. */
async function fetchSummaries(client: ImapFlow, store: MailStore, mailbox: string, uids: number[]): Promise<boolean> {
  if (!uids.length) return false;
  const fetched: FetchMessageObject[] = [];
  for await (const m of client.fetch(uidRanges(uids), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
    fetched.push(m);
  }
  const changed = store.putSummaries(mailbox, fetched.map(summary));

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

function flagsOf(flags: Set<string> | undefined): Flags {
  const f = flags ?? new Set<string>();
  return { seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), answered: f.has('\\Answered'), draft: f.has('\\Draft') };
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
  await inMailbox(a, mailbox, async (client) => {
    const box = client.mailbox;
    if (!box) return;
    const validity = String(box.uidValidity);
    if (checkValidity(a, store, mailbox, validity)) dirty = true;
    const prev = store.box(mailbox);
    const uids = box.exists > 0 ? ((await client.search({ all: true }, { uid: true })) || []).sort((x, y) => y - x) : [];
    if (!prev || !sameList(prev.uids, uids)) dirty = true;
    const present = new Set(uids);
    const stored = store.storedUids(mailbox);
    store.removeUids(mailbox, stored.filter((u) => !present.has(u)));
    const keep = stored.filter((u) => present.has(u));

    const condstore = client.enabled.has('CONDSTORE') && !!box.highestModseq;
    let modseq = condstore ? box.highestModseq! : null;
    if (keep.length) {
      const since = condstore && prev?.modseq ? BigInt(prev.modseq) : null;
      const range = since !== null ? '1:*' : uidRanges(keep);
      const kept = new Set(keep);
      for await (const m of client.fetch(range, { uid: true, flags: true }, { uid: true, changedSince: since ?? undefined })) {
        if (m.modseq && modseq !== null && m.modseq > modseq) modseq = m.modseq;
        if (kept.has(m.uid) && store.patchFlags(mailbox, [m.uid], flagsOf(m.flags))) dirty = true;
      }
    }
    store.setBox(mailbox, { validity, modseq: modseq?.toString() ?? null, uids, synced: Date.now() });

    const have = store.summaries(mailbox, uids.slice(0, PAGE));
    if (await fetchSummaries(client, store, mailbox, uids.slice(0, PAGE).filter((u) => !have.has(u)))) dirty = true;
  }, false);
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

function summary(m: FetchMessageObject): MessageSummary {
  const date = m.envelope?.date ?? m.internalDate;
  return {
    uid: m.uid,
    messageId: m.envelope?.messageId ?? null,
    subject: m.envelope?.subject ?? '',
    from: addresses(m.envelope?.from),
    to: addresses(m.envelope?.to),
    cc: addresses(m.envelope?.cc),
    date: date ? new Date(date).getTime() || 0 : 0,
    ...flagsOf(m.flags),
    hasAttachments: hasAttachments(m.bodyStructure),
    preview: null,
    size: m.size ?? 0,
  };
}

/**
 * A page of a mailbox's messages. Straight from the stored copy when it
 * has the whole page (syncing behind it when it's old); otherwise from the
 * server, keeping what comes back. Searches and filters ask the server,
 * and settle for the stored copy when it can't be reached.
 */
async function messages(a: StoredAccount, mailbox: string, before: number | undefined, limit: number, query: string, filter: MessageFilter): Promise<MessagePage> {
  const store = storeOf(a);
  sessionOf(a.id);
  if (!query && !filter) {
    const local = storedPage(store, mailbox, before, limit);
    if (local) {
      if (Date.now() - (store.box(mailbox)?.synced ?? 0) > SYNC_AFTER_MS) scheduleSync(a, mailbox, 0);
      return local;
    }
  }
  try {
    return await serverPage(a, store, mailbox, before, limit, query, filter);
  } catch (error) {
    const local = query ? null : storedPage(store, mailbox, before, limit, filter, true);
    if (local) return local;
    throw error;
  }
}

async function serverPage(a: StoredAccount, store: MailStore, mailbox: string, before: number | undefined, limit: number, query: string, filter: MessageFilter): Promise<MessagePage> {
  return inMailbox(a, mailbox, async (client) => {
    const box = client.mailbox;
    const validity = box ? String(box.uidValidity) : '';
    checkValidity(a, store, mailbox, validity);
    let uids: number[] = [];
    if (box && box.exists > 0) {
      const criteria: SearchObject = filter === 'unread' ? { seen: false } : filter === 'flagged' ? { flagged: true } : { all: true };
      if (query) {
        // Gmail searches the way its web page does; elsewhere, the usual headers and the body.
        if (client.capabilities.has('X-GM-EXT-1')) criteria.gmraw = query;
        else criteria.or = [{ subject: query }, { from: query }, { to: query }, { body: query }];
        delete criteria.all;
      }
      uids = (await client.search(criteria, { uid: true })) || [];
    }
    uids.sort((x, y) => y - x);
    if (!query && !filter && box) {
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
    const meta = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true });
    if (!meta) throw new Error('That message is gone.');
    if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) throw new Error('That message is too big to open here.');
    const raw = ((meta.size ?? 0) > SKIM_BYTES && (await skimmedMessage(client, uid, meta.bodyStructure))) || (await wholeMessage(client, uid));
    const mail = await simpleParser(raw);
    const entry = { summary: summary(meta), mail };
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
  };
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
  return publicAccount(stored);
}

async function updateAccount(id: unknown, patch: unknown): Promise<MailAccount> {
  const a = account(id);
  const p = (patch ?? {}) as MailAccountPatch;
  const imap = p.imap === undefined ? a.imap : p.imap;
  const smtp = p.smtp === undefined ? a.smtp : p.smtp;
  if (!isServer(imap) || !isServer(smtp)) throw new Error('Check the server settings.');
  const servers = p.imap !== undefined || p.smtp !== undefined || typeof p.password === 'string';
  const password = typeof p.password === 'string' && p.password ? p.password : unseal(a.password);
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
  if (movedServer) dropStore(a.id);
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
  handle('mail:discover', (email) => {
    if (typeof email !== 'string' || !EMAIL.test(email.trim())) throw new Error('That isn’t an email address.');
    return discover(email.trim());
  });
  handle('mail:addAccount', (input) => addAccount(input));
  handle('mail:updateAccount', (id, patch) => updateAccount(id, patch));
  handle('mail:removeAccount', (id) => {
    const a = account(id);
    closeSession(a.id);
    dropStore(a.id);
    accounts = accounts.filter((x) => x !== a);
    save();
  });
  handle('mail:mailboxes', (id) => mailboxes(account(id)));
  handle('mail:messages', (id, mailbox, opts) => {
    const o = (opts ?? {}) as { before?: unknown; limit?: unknown; query?: unknown; filter?: unknown };
    const filter = o.filter === 'unread' || o.filter === 'flagged' ? o.filter : null;
    const before = Number.isInteger(o.before) && (o.before as number) > 0 ? (o.before as number) : undefined;
    const limit = Number.isInteger(o.limit) ? Math.min(Math.max(o.limit as number, 1), 200) : PAGE;
    return messages(account(id), mailboxArg(mailbox), before, limit, text(o.query, 500).trim(), filter);
  });
  handle('mail:message', (id, mailbox, uid) => {
    if (!Number.isInteger(uid)) throw new Error('Bad uid');
    return message(account(id), mailboxArg(mailbox), uid as number);
  });
  handle('mail:attachment', (id, mailbox, uid, index) => {
    if (!Number.isInteger(uid) || !Number.isInteger(index)) throw new Error('Bad attachment');
    return attachment(account(id), mailboxArg(mailbox), uid as number, index as number);
  });
  handle('mail:setFlags', (id, mailbox, uids, flags) =>
    setFlags(account(id), mailboxArg(mailbox), uidList(uids), (flags ?? {}) as { seen?: unknown; flagged?: unknown }),
  );
  handle('mail:move', (id, mailbox, uids, to) => move(account(id), mailboxArg(mailbox), uidList(uids), to));
  handle('mail:remove', (id, mailbox, uids) => remove(account(id), mailboxArg(mailbox), uidList(uids)));
  handle('mail:send', (id, m) => send(account(id), outgoing(m)));
  handle('mail:saveDraft', (id, m) => saveDraft(account(id), outgoing(m)));

  app.on('will-quit', () => {
    for (const id of [...sessions.keys()]) closeSession(id);
  });
}

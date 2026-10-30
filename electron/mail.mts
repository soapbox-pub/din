// Mail (din.system.mail, for the Mail app in src/apps/mail/): IMAP and SMTP
// accounts, the way Apple Mail does them, behind the `mail:*` channels.
//
// Apps can't open sockets, so the accounts live here. Each account's
// settings are kept in userData/mail/accounts.json with its password sealed
// by safeStorage (the login keyring), and never go back to the app. Each
// account gets one IMAP connection for what the app asks (imapflow queues
// commands behind its mailbox locks) and one more that idles on the inbox,
// so new mail shows up as it arrives; both close after a while without
// calls, and the app's periodic refresh keeps them up while it's open.
// Anything that changes a mailbox, here or on the server, is pushed as
// `mail:changed` ({ accountId, path }) to the apps granted `mail`.
//
// Sending is nodemailer over the account's SMTP server, with a copy
// appended to Sent (except where the server keeps one itself: Gmail,
// Outlook). Messages are parsed with mailparser, which also turns cid:
// pictures into data: URLs; the app sanitizes and sandboxes the HTML.
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

function sessionOf(id: string): Session {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { client: null, connecting: null, watcher: null, watching: false, lastUse: 0, specials: new Map() }));
  s.lastUse = Date.now();
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

function listen(accountId: string, client: ImapFlow): void {
  const onChange = (e: { path?: string }) => {
    if (typeof e?.path === 'string') changed(accountId, e.path);
  };
  client.on('exists', onChange);
  client.on('expunge', onChange);
  client.on('flags', onChange);
  client.on('error', () => {});
}

async function connection(a: StoredAccount): Promise<ImapFlow> {
  const s = sessionOf(a.id);
  if (s.client?.usable) {
    watch(a, s);
    return s.client;
  }
  if (!s.connecting) {
    const client = imapClient(a.imap, unseal(a.password));
    listen(a.id, client);
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
  listen(a.id, client);
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

/** Run with a mailbox selected (imapflow queues other callers behind the lock). */
async function inMailbox<T>(a: StoredAccount, mailbox: string, fn: (client: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
  const client = await connection(a);
  let lock;
  try {
    lock = await client.getMailboxLock(mailbox, { readOnly });
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

async function mailboxes(a: StoredAccount): Promise<MailboxInfo[]> {
  const client = await connection(a);
  let list: ListResponse[];
  try {
    list = await client.list({ statusQuery: { messages: true, unseen: true } });
  } catch (error) {
    throw explain(error);
  }
  const s = sessionOf(a.id);
  s.specials.clear();
  const out: MailboxInfo[] = list.map((m) => {
    const special = m.path.toUpperCase() === 'INBOX' ? 'inbox' : (m.specialUse && SPECIAL[m.specialUse]) || null;
    if (special && !s.specials.has(special)) s.specials.set(special, m.path);
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

/** Previews already read, by account, mailbox, UIDVALIDITY and uid. */
const previews = new Map<string, string | null>();

function summary(m: FetchMessageObject): MessageSummary {
  const flags = m.flags ?? new Set<string>();
  const date = m.envelope?.date ?? m.internalDate;
  return {
    uid: m.uid,
    messageId: m.envelope?.messageId ?? null,
    subject: m.envelope?.subject ?? '',
    from: addresses(m.envelope?.from),
    to: addresses(m.envelope?.to),
    cc: addresses(m.envelope?.cc),
    date: date ? new Date(date).getTime() || 0 : 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    hasAttachments: hasAttachments(m.bodyStructure),
    preview: null,
    size: m.size ?? 0,
  };
}

async function messages(a: StoredAccount, mailbox: string, before: number | undefined, limit: number, query: string, filter: MessageFilter): Promise<MessagePage> {
  return inMailbox(a, mailbox, async (client) => {
    const box = client.mailbox;
    const validity = box ? String(box.uidValidity) : '';
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
    const older = before ? uids.filter((u) => u < before) : uids;
    const page = older.slice(0, limit);
    if (!page.length) return { messages: [], total: uids.length, more: false };

    const fetched: FetchMessageObject[] = [];
    for await (const m of client.fetch(page.join(','), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
      fetched.push(m);
    }

    // Previews, a few KB of each message's text, fetched together for messages whose text is the same part.
    const want = new Map<string, { part: MessageStructureObject; uids: number[] }>();
    for (const m of fetched) {
      const key = `${a.id}\0${mailbox}\0${validity}\0${m.uid}`;
      if (previews.has(key)) continue;
      const part = previewPart(m.bodyStructure);
      if (!part) {
        previews.set(key, null);
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
        for await (const m of client.fetch(some.join(','), { uid: true, bodyParts: [{ key: part.part ?? '1', maxLength: PREVIEW_BYTES }] }, { uid: true })) {
          const raw = m.bodyParts ? [...m.bodyParts.values()][0] : undefined;
          previews.set(`${a.id}\0${mailbox}\0${validity}\0${m.uid}`, raw ? previewText(part, raw) : null);
        }
      } catch {
        // Previews are a nicety; the list still shows.
      }
    }
    if (previews.size > 20_000) previews.clear();

    const out = fetched.map((m) => {
      const s = summary(m);
      s.preview = previews.get(`${a.id}\0${mailbox}\0${validity}\0${m.uid}`) ?? null;
      return s;
    });
    out.sort((x, y) => y.date - x.date || y.uid - x.uid);
    return { messages: out, total: uids.length, more: older.length > page.length };
  }, true);
}

/** Recently opened messages, parsed. */
const parsed = new Map<string, { summary: MessageSummary; mail: ParsedMail }>();

async function parsedMessage(a: StoredAccount, mailbox: string, uid: number): Promise<{ summary: MessageSummary; mail: ParsedMail }> {
  return inMailbox(a, mailbox, async (client) => {
    const key = `${a.id}\0${mailbox}\0${String(client.mailbox ? client.mailbox.uidValidity : '')}\0${uid}`;
    const hit = parsed.get(key);
    if (hit) {
      parsed.delete(key);
      parsed.set(key, hit);
      return hit;
    }
    const meta = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true });
    if (!meta) throw new Error('That message is gone.');
    if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) throw new Error('That message is too big to open here.');
    const download = await client.download(String(uid), undefined, { uid: true });
    if (!('content' in download) || !download.content) throw new Error('That message is gone.');
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk as Buffer);
    const mail = await simpleParser(Buffer.concat(chunks));
    const entry = { summary: summary(meta), mail };
    parsed.set(key, entry);
    while (parsed.size > 24) parsed.delete(parsed.keys().next().value as string);
    return entry;
  }, true);
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
      size: x.size,
      inline: x.related === true && !!x.cid,
    })),
  };
}

async function attachment(a: StoredAccount, mailbox: string, uid: number, index: number): Promise<MailAttachment> {
  const { mail } = await parsedMessage(a, mailbox, uid);
  const x = mail.attachments[index];
  if (!x) throw new Error('That attachment is gone.');
  return { filename: x.filename || `Attachment ${index + 1}`, contentType: x.contentType, content: new Uint8Array(x.content) };
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
  changed(a.id, mailbox);
  changed(a.id, dest);
}

async function remove(a: StoredAccount, mailbox: string, uids: number[]): Promise<void> {
  const trash = await specialPath(a, 'trash', 'Trash');
  if (mailbox === trash) {
    await inMailbox(a, mailbox, (client) => client.messageDelete(uids.join(','), { uid: true }));
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
  await inMailbox(a, drafts, (client) => client.messageDelete(String(uid), { uid: true })).catch(() => {});
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
    } catch {
      // No Sent copy, but the message went.
    }
  }
  if (m.answering) await setFlagsRaw(a, m.answering.path, m.answering.uid, '\\Answered').catch(() => {});
  if (m.draftUid) await deleteDraft(a, m.draftUid);
}

async function setFlagsRaw(a: StoredAccount, mailbox: string, uid: number, flag: string): Promise<void> {
  await inMailbox(a, mailbox, (client) => client.messageFlagsAdd(String(uid), [flag], { uid: true }));
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
  a.imap = { ...imap };
  a.smtp = { ...smtp };
  if (typeof p.password === 'string' && p.password) a.password = seal(p.password);
  save();
  if (servers) closeSession(a.id);
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

// Phones over Bluetooth, for Messages (phone.mts): the Message Access
// Profile, which iPhones offer to computers once "Show Notifications" is on
// for them, and most Android phones offer too.
//
// BlueZ's obexd does the protocol, on the session bus (D-Bus starts it on the
// first call). A MAP session to the paired phone lists its inbox (and sent
// folder, where there is one) every POLL_MS while it's up; obexd also hears
// the phone's own new-message events and turns them into listing changes, so
// polling is only the floor. A message's text is the listing's subject when
// that's all of it; a longer one is fetched whole only once it's read, since
// fetching reads it on an iPhone (which ignores setting it back to unread),
// so an unread one shows its first lines until it's opened. Sending
// pushes a bMessage to the outbox. Contacts come over the Phone Book Access
// Profile (the iPhone's "Sync Contacts"), in a session of their own.
//
// MAP carries no pictures or group conversations; that's the profile's limit,
// the same on Windows. Conversations are by the other person's number, since
// MAP has no threads.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DBusConnection, DBusError, unwrap, Variant, type Message } from './dbus.mts';
import { sessionBusAddress } from './native-display.mts';
import { bMessage, bMessageText, parseVCards } from './phone-vcard.mts';
import type { BackendMessage, PhoneConnection, PhoneHooks } from './phone.mts';

const OBEX = 'org.bluez.obex';
const CLIENT = 'org.bluez.obex.Client1';
const MAP = 'org.bluez.obex.MessageAccess1';
const MESSAGE = 'org.bluez.obex.Message1';
const PBAP = 'org.bluez.obex.PhonebookAccess1';
const TRANSFER = 'org.bluez.obex.Transfer1';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';

const POLL_MS = 20_000;
const SESSION_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 60_000;
/** Waits between tries while the phone is away: 30 s, doubling to 5 minutes. */
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Bluetooth changes try again at most this often. */
const POKE_MS = 10_000;
const CONTACTS_MS = 12 * 60 * 60_000;
/** Contacts that couldn't be fetched are tried again this often. */
const CONTACTS_RETRY_MS = 5 * 60_000;
/** How long the first inbox read waits for contacts, so new texts come with names. */
const CONTACTS_WAIT_MS = 20_000;
/** How many of each folder's newest messages a listing asks for. */
const LIST_COUNT = 60;

// ---------------------------------------------------------------------------
// The session bus, shared
// ---------------------------------------------------------------------------

let bus: DBusConnection | null = null;
let connecting: Promise<DBusConnection | null> | null = null;
let obexOwner: string | null = null;
/** Transfers that ended, in case one ends before anyone waits on it. */
const finished = new Map<string, string>();
const waiters = new Map<string, (status: string) => void>();
/** Sessions that went away, to their connection. */
const sessionGone = new Map<string, () => void>();

async function obex(): Promise<DBusConnection | null> {
  if (bus && obexOwner) return bus;
  connecting ??= (async () => {
    if (!bus) {
      const b = await DBusConnection.connect(await sessionBusAddress());
      if (!b) return null;
      b.onClose = () => {
        if (bus !== b) return;
        bus = null;
        obexOwner = null;
        unfollow = null;
        for (const gone of [...sessionGone.values()]) gone();
      };
      b.subscribe({ sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' }, (message) => {
        if (message.body[0] !== OBEX) return;
        follow(b, (message.body[2] as string) || null);
        if (!obexOwner) for (const gone of [...sessionGone.values()]) gone();
      });
      bus = b;
    }
    // Starts obexd if it isn't running.
    await bus.bus('StartServiceByName', 'su', [OBEX, 0]).catch(() => {});
    const owner = await bus
      .bus('GetNameOwner', 's', [OBEX])
      .then(([name]) => name as string)
      .catch(() => null);
    if (owner !== obexOwner) follow(bus, owner);
    return obexOwner ? bus : null;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

let unfollow: (() => void) | null = null;

/** Hear obexd's signals: transfers ending, sessions going away. */
function follow(b: DBusConnection, owner: string | null): void {
  unfollow?.();
  unfollow = null;
  obexOwner = owner;
  if (!owner) return;
  const subscriptions = [
    b.subscribe({ sender: owner, interface: PROPERTIES, member: 'PropertiesChanged' }, (message: Message) => {
      if (message.body[0] !== TRANSFER || !message.path) return;
      const status = unwrap((message.body[1] as Map<string, unknown>).get('Status'));
      if (status === 'complete' || status === 'error') transferEnded(message.path, status);
    }),
    b.subscribe({ sender: owner, interface: OBJECT_MANAGER, member: 'InterfacesRemoved' }, (message: Message) => {
      const [objectPath, ifaces] = message.body as [string, string[]];
      if (ifaces.includes('org.bluez.obex.Session1')) sessionGone.get(objectPath)?.();
    }),
  ];
  unfollow = () => subscriptions.forEach((unsubscribe) => unsubscribe());
}

function transferEnded(transfer: string, status: string): void {
  finished.set(transfer, status);
  setTimeout(() => finished.delete(transfer), 60_000);
  waiters.get(transfer)?.(status);
}

function waitTransfer(transfer: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (status: string) => {
      clearTimeout(timer);
      waiters.delete(transfer);
      if (status === 'complete') resolve();
      else reject(new Error(status === 'timeout' ? 'The phone took too long.' : 'The phone didn’t take it.'));
    };
    const timer = setTimeout(() => done('timeout'), TRANSFER_TIMEOUT_MS);
    const early = finished.get(transfer);
    if (early) return done(early);
    waiters.set(transfer, done);
  });
}

function call(member: string, objectPath: string, iface: string, signature = '', body: unknown[] = [], timeout?: number) {
  if (!bus || !obexOwner) return Promise.reject(new Error('Bluetooth messages aren’t running.'));
  return bus.call({ destination: OBEX, path: objectPath, interface: iface, member, signature, body, timeout });
}

function scratchFile(extension: string): string {
  return path.join(os.tmpdir(), `din-phone-${randomUUID()}.${extension}`);
}

/** Friendlier words for why a session couldn't start. */
function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const type = error instanceof DBusError ? error.type : '';
  if (/service record|not supported|NotSupported|profile/i.test(text + type)) {
    return 'The phone isn’t sharing its messages. On an iPhone, open Settings → Bluetooth, tap ⓘ beside this computer, and turn on Show Notifications.';
  }
  if (/refused|denied|NotAuthorized|Rejected/i.test(text + type)) {
    return 'The phone turned it down. On an iPhone, turn on Show Notifications for this computer in Settings → Bluetooth (ⓘ).';
  }
  if (/host is down|timed? ?out|unreachable|page|no route|connection reset|abort/i.test(text)) return 'The phone isn’t in range.';
  return `Bluetooth said: ${text}`;
}

/** MAP's timestamps: 20261101T153000, maybe with Z or an offset; local time without. */
function parseTimestamp(value: unknown): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/.exec(String(value ?? ''));
  if (!m) return Date.now();
  const [, y, mo, d, h, mi, s, zone] = m;
  if (!zone) return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (zone === 'Z') return utc;
  const sign = zone[0] === '-' ? -1 : 1;
  return utc - sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) * 60_000;
}

function digits(address: string): string {
  const d = address.replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

// ---------------------------------------------------------------------------
// A phone
// ---------------------------------------------------------------------------

interface Known {
  read: boolean;
  /** Only the listing's subject so far: the whole text waits until it's read. */
  partial: boolean;
  message: BackendMessage;
}

export class MapConnection implements PhoneConnection {
  private address: string;
  private hooks: PhoneHooks;
  private session: string | null = null;
  private stopped = false;
  private trying = false;
  private syncing: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  private lastTry = 0;
  private contactsAt = 0;
  private contactsTried = 0;
  private contactsPulling: Promise<void> | null = null;
  /** What's been reported, by MAP handle. */
  private known = new Map<string, Known>();

  constructor(address: string, hooks: PhoneHooks) {
    this.address = address;
    this.hooks = hooks;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.close();
  }

  refresh(): void {
    if (this.session) void this.sync();
    else void this.connect();
  }

  bluetoothChanged(): void {
    if (!this.session && !this.trying && Date.now() - this.lastTry > POKE_MS) void this.connect();
  }

  async send(addresses: string[], body: string): Promise<void> {
    const session = this.session;
    if (!session) throw new Error('The phone isn’t connected.');
    // MAP sends to one number at a time.
    for (const address of addresses) {
      const file = scratchFile('bmsg');
      await fs.writeFile(file, bMessage(address, body), { mode: 0o600 });
      try {
        const args = new Map([
          ['Transparent', new Variant('b', false)],
          ['Retry', new Variant('b', true)],
          ['Charset', new Variant('s', 'utf8')],
        ]);
        const [transfer] = await call('PushMessage', session, MAP, 'ssa{sv}', [file, 'outbox', args]);
        await waitTransfer(transfer as string);
      } finally {
        void fs.rm(file, { force: true });
      }
    }
  }

  markRead(ids: string[]): void {
    const session = this.session;
    if (!session) return;
    void (async () => {
      const whole: BackendMessage[] = [];
      for (const id of ids) {
        const handle = id.startsWith('bt:') ? id.slice(3) : null;
        if (!handle) continue;
        const objectPath = `${session}/message${handle}`;
        const known = this.known.get(handle);
        if (known?.partial) {
          // Fetching it is what reads it, on an iPhone.
          const body = await this.fetch(objectPath).catch(() => '');
          if (body) {
            known.partial = false;
            known.message = { ...known.message, body, read: true };
            whole.push(known.message);
          }
        } else {
          await call('Set', objectPath, PROPERTIES, 'ssv', [MESSAGE, 'Read', new Variant('b', true)]).catch(() => {});
        }
        if (known) known.read = true;
      }
      if (whole.length) this.hooks.messages(whole);
    })();
  }

  private close(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    sessionGone.delete(session);
    void call('RemoveSession', '/org/bluez/obex', CLIENT, 'o', [session]).catch(() => {});
  }

  private lost(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.session) sessionGone.delete(this.session);
    this.session = null;
    if (this.stopped) return;
    this.hooks.status({ status: 'offline', error: null });
    this.retryMs = RETRY_MIN_MS;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.session || this.trying) return;
    this.trying = true;
    this.lastTry = Date.now();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.hooks.status({ status: 'connecting' });
    try {
      if (!(await obex())) throw new Error('Bluetooth messages aren’t available on this computer.');
      const [session] = await call('CreateSession', '/org/bluez/obex', CLIENT, 'sa{sv}', [this.address, new Map([['Target', new Variant('s', 'map')]])], SESSION_TIMEOUT_MS);
      if (this.stopped) {
        void call('RemoveSession', '/org/bluez/obex', CLIENT, 'o', [session]).catch(() => {});
        return;
      }
      this.session = session as string;
      sessionGone.set(this.session, () => this.lost());
      await this.enterMessages();
      this.retryMs = RETRY_MIN_MS;
      this.hooks.status({ status: 'connected', error: null });
      // Contacts first, so texts announced on connecting come with names.
      await Promise.race([this.maybePullContacts(true), new Promise((resolve) => setTimeout(resolve, CONTACTS_WAIT_MS))]);
      await this.sync();
      this.pollTimer = setInterval(() => {
        void this.sync();
        void this.maybePullContacts(false);
      }, POLL_MS);
    } catch (error) {
      const away = !this.session;
      this.close();
      this.hooks.status({ status: 'offline', error: away && /in range/.test(explain(error)) ? null : explain(error) });
      this.scheduleRetry();
    } finally {
      this.trying = false;
    }
  }

  /** Into telecom/msg, where the folders are. */
  private async enterMessages(): Promise<void> {
    const session = this.session as string;
    try {
      await call('SetFolder', session, MAP, 's', ['/telecom/msg']);
    } catch {
      await call('SetFolder', session, MAP, 's', ['/']).catch(() => {});
      await call('SetFolder', session, MAP, 's', ['telecom']);
      await call('SetFolder', session, MAP, 's', ['msg']);
    }
  }

  private sync(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const found: BackendMessage[] = [];
        for (const folder of ['inbox', 'sent']) {
          const listed = await this.list(folder).catch((error) => {
            // A phone without a sent folder (an iPhone) says so; anything else is the session.
            if (folder === 'inbox') throw error;
            return [];
          });
          found.push(...listed);
        }
        if (found.length) this.hooks.messages(found);
      } catch (error) {
        if (this.session && /not connected|disconnected|closed|reset|NotConnected|No such/i.test(String(error))) this.lost();
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async list(folder: string): Promise<BackendMessage[]> {
    const session = this.session;
    if (!session) return [];
    const filter = new Map([
      ['MaxCount', new Variant('q', LIST_COUNT)],
      ['SubjectLength', new Variant('y', 255)],
    ]);
    const [listing] = await call('ListMessages', session, MAP, 'sa{sv}', [folder, filter], SESSION_TIMEOUT_MS);
    const out: BackendMessage[] = [];
    for (const [objectPath, rawProps] of listing as Map<string, Map<string, unknown>>) {
      const props = new Map([...rawProps].map(([k, v]) => [k, unwrap(v)]));
      const type = String(props.get('Type') ?? '');
      if (type === 'email') continue;
      const handle = objectPath.slice(objectPath.lastIndexOf('/message') + '/message'.length);
      const read = props.get('Read') === true;
      const known = this.known.get(handle);
      if (known && known.read === read && !(read && known.partial)) continue;
      const subject = String(props.get('Subject') ?? '');
      const size = Number(props.get('Size') ?? 0);
      // The listing's subject is the text, cut short (an iPhone's at 128 characters).
      const cut = !known?.message.body && (size > Buffer.byteLength(subject, 'utf8') + 2);
      let partial = known ? known.partial : cut;
      let body = known?.message.body ?? subject;
      // A whole text is fetched only once it's read: fetching reads it, on an
      // iPhone, and it can't be set back to unread.
      if (partial && read) {
        const whole = await this.fetch(objectPath).catch(() => '');
        if (whole) {
          body = whole;
          partial = false;
        }
      }
      const outgoing = folder !== 'inbox';
      const other = String((outgoing ? props.get('RecipientAddress') ?? props.get('Recipient') : props.get('SenderAddress') ?? props.get('Sender')) ?? '');
      const message: BackendMessage = {
        id: `bt:${handle}`,
        threadId: digits(other) || other || 'unknown',
        addresses: other ? [other] : [],
        sender: outgoing ? null : other || null,
        body: partial && !body.endsWith('…') ? `${body}…` : body,
        time: parseTimestamp(props.get('Timestamp')),
        outgoing,
        read: outgoing || read,
        images: [],
      };
      this.known.set(handle, { read, partial, message });
      out.push(message);
    }
    return out;
  }

  /** A message's whole text. */
  private async fetch(objectPath: string): Promise<string> {
    const file = scratchFile('bmsg');
    try {
      const [transfer] = await call('Get', objectPath, MESSAGE, 'sb', [file, false], SESSION_TIMEOUT_MS);
      await waitTransfer(transfer as string);
      return bMessageText(await fs.readFile(file, 'utf8'));
    } finally {
      void fs.rm(file, { force: true });
    }
  }

  /** Fetch contacts if they're stale, and failed ones again after a while. */
  private maybePullContacts(now: boolean): Promise<void> {
    if (this.contactsPulling) return this.contactsPulling;
    if (Date.now() - this.contactsAt < CONTACTS_MS) return Promise.resolve();
    if (!now && Date.now() - this.contactsTried < CONTACTS_RETRY_MS) return Promise.resolve();
    this.contactsTried = Date.now();
    this.contactsPulling = this.pullContacts().finally(() => {
      this.contactsPulling = null;
    });
    return this.contactsPulling;
  }

  private async pullContacts(): Promise<void> {
    if (!(await obex())) return;
    let session: string | null = null;
    const file = scratchFile('vcf');
    try {
      [session] = (await call('CreateSession', '/org/bluez/obex', CLIENT, 'sa{sv}', [this.address, new Map([['Target', new Variant('s', 'pbap')]])], SESSION_TIMEOUT_MS)) as [string];
      await call('Select', session, PBAP, 'ss', ['int', 'pb']);
      const filters = new Map([['Format', new Variant('s', 'vcard30')]]);
      const [transfer] = await call('PullAll', session, PBAP, 'sa{sv}', [file, filters], SESSION_TIMEOUT_MS);
      await waitTransfer(transfer as string);
      const contacts = parseVCards(await fs.readFile(file, 'utf8'));
      // None is what a phone with Sync Contacts off sends: ask again later.
      if (contacts.length) {
        this.contactsAt = Date.now();
        this.hooks.contacts(contacts);
      }
    } catch (error) {
      // Contacts are a nicety: the phone may not share them ("Sync Contacts" off).
      console.warn('phone: fetching contacts failed', error instanceof Error ? error.message : error);
    } finally {
      void fs.rm(file, { force: true });
      if (session) void call('RemoveSession', '/org/bluez/obex', CLIENT, 'o', [session]).catch(() => {});
    }
  }
}

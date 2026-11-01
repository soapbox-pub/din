// Phones (window.dinos.phone, and din.system.phone for Messages in
// src/apps/messages/): the user's text messages, read and answered from the
// computer, as Phone Link does on Windows.
//
// Two ways to reach a phone, behind one interface:
//
//   - Bluetooth (phone-map.mts): the Message Access Profile, through BlueZ's
//     obexd on the session bus. It's what an iPhone offers (once "Show
//     Notifications" is on for this computer in its Bluetooth settings), and
//     what Windows uses for iPhones too: new texts as they come and replies,
//     but no history from before, and no pictures or groups.
//   - KDE Connect (phone-kdeconnect.mts): its protocol, spoken here, to the
//     free KDE Connect app on an Android phone on the same network. Every
//     conversation with its history, pictures (as thumbnails) and groups.
//
// The phones and their messages live here. Each phone's messages are kept in
// userData/phone/<id>.json, sealed with safeStorage (the login keyring) so
// they're unreadable off this computer, and never go anywhere else: an
// iPhone can't send them again. A backend reports messages and contacts as
// it gets them; this file merges them, works out the conversations and their
// names, and pushes `phone:changed` (the phones), `phone:messages` (which
// conversations changed) and `phone:incoming` (a new text, for the desktop's
// notification) to the shell and to apps granted `phone`.
//
// Types are src/lib/phone.ts. Runs as TypeScript directly via Node's native
// type stripping - erasable syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import { bluetoothPhones, onBluetoothChanged } from './bluetooth.mts';
import { MapConnection } from './phone-map.mts';
import { KdeConnect } from './phone-kdeconnect.mts';
import type {
  PhoneCandidate,
  PhoneContact,
  PhoneConversation,
  PhoneDevice,
  PhoneKind,
  PhoneMessage,
  PhonePairing,
  PhoneState,
  PhoneStatus,
} from '../src/lib/phone.ts';

/** A message as a backend reports it; the hub adds the phone. */
export type BackendMessage = Omit<PhoneMessage, 'phoneId' | 'status'> & { status?: PhoneMessage['status'] };

export interface LiveStatus {
  status: PhoneStatus;
  error: string | null;
  battery: number | null;
  charging: boolean | null;
}

/** What a backend tells the hub about one phone. */
export interface PhoneHooks {
  status(patch: Partial<LiveStatus>): void;
  messages(messages: BackendMessage[]): void;
  contacts(contacts: PhoneContact[]): void;
}

/** One phone's connection, as the hub drives it. */
export interface PhoneConnection {
  stop(): void;
  send(addresses: string[], body: string): Promise<void>;
  /** Ask for what's new, connecting again if need be. */
  refresh(): void;
  /** Ask for a conversation's history (phones that have it). */
  loadThread?(threadId: string): void;
  /** Tell the phone these were read (phones that take it). */
  markRead?(ids: string[]): void;
  /** Something about Bluetooth's devices changed (the phone came in range, say). */
  bluetoothChanged?(): void;
}

interface StoredPhone {
  id: string;
  kind: PhoneKind;
  name: string;
  /** The Bluetooth address, or KDE Connect's device id. */
  address: string;
  /** KDE Connect: the phone's certificate (PEM), checked on every connection. */
  cert?: string;
  addedAt: number;
  lastSeen: number | null;
}

interface Thread {
  messages: PhoneMessage[];
  /** Incoming messages up to here count as read. */
  readUntil: number;
}

interface PhoneData {
  threads: Record<string, Thread>;
  /** Conversations deleted here, and up to when: older messages the phone sends again stay out. */
  hidden: Record<string, number>;
  contacts: PhoneContact[];
}

/** Messages kept per conversation, newest. */
const MAX_PER_THREAD = 1000;
/** A message counts as new (worth a notification) for this long after it was sent. */
const NEW_MS = 10 * 60_000;
/** How long a sent message waits to be matched by the phone's own copy. */
const ECHO_MS = 10 * 60_000;
const SAVE_DELAY_MS = 1000;
const EMIT_DELAY_MS = 100;
/** Settings looks for phones while it's open; this ends a search it forgot. */
const DISCOVERY_MS = 10 * 60_000;
/** A conversation's history is asked for at most this often. */
const HISTORY_INTERVAL_MS = 60_000;
const MAX_BODY = 5000;

type Deps = {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
};

let deps: Deps;
let phones: StoredPhone[] = [];
const data = new Map<string, PhoneData>();
const live = new Map<string, LiveStatus>();
const connections = new Map<string, PhoneConnection>();
const saveTimers = new Map<string, NodeJS.Timeout>();
const historyAsked = new Map<string, number>();
let kde: KdeConnect | null = null;
let bluetoothCandidates: PhoneCandidate[] = [];
let bluetoothAvailable = false;
let discoveryTimer: NodeJS.Timeout | null = null;
let nextLocal = 1;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function dir(): string {
  return path.join(app.getPath('userData'), 'phone');
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function seal(text: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(text).toString('base64')}`;
  return `plain:${Buffer.from(text, 'utf8').toString('base64')}`;
}

function unseal(sealed: string): string {
  if (sealed.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'));
  if (sealed.startsWith('plain:')) return Buffer.from(sealed.slice(6), 'base64').toString('utf8');
  return '';
}

function loadPhones(): void {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir(), 'phones.json'), 'utf8'));
    const list = (parsed as { phones?: unknown }).phones;
    phones = Array.isArray(list)
      ? list.filter((p): p is StoredPhone => typeof p?.id === 'string' && (p.kind === 'bluetooth' || p.kind === 'kdeconnect') && typeof p.address === 'string')
      : [];
  } catch {
    phones = [];
  }
}

function savePhones(): void {
  writeFile(path.join(dir(), 'phones.json'), JSON.stringify({ phones }, null, 2));
}

function dataFile(id: string): string {
  return path.join(dir(), `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function phoneData(id: string): PhoneData {
  let d = data.get(id);
  if (d) return d;
  d = { threads: {}, hidden: {}, contacts: [] };
  try {
    const parsed = JSON.parse(unseal(fs.readFileSync(dataFile(id), 'utf8'))) as Partial<PhoneData>;
    d = { threads: parsed.threads ?? {}, hidden: parsed.hidden ?? {}, contacts: parsed.contacts ?? [] };
  } catch {
    // None yet, or sealed with a keyring that's gone.
  }
  data.set(id, d);
  return d;
}

function scheduleSave(id: string): void {
  if (saveTimers.has(id)) return;
  saveTimers.set(id, setTimeout(() => flush(id), SAVE_DELAY_MS));
}

function flush(id: string): void {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  const d = data.get(id);
  if (!d || !phones.some((p) => p.id === id)) return;
  try {
    writeFile(dataFile(id), seal(JSON.stringify(d)));
  } catch (error) {
    console.error('phone: saving messages failed', error);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let emitTimer: NodeJS.Timeout | null = null;

function changed(): void {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    deps.sendToShell('phone:changed', state());
  }, EMIT_DELAY_MS);
}

function unread(thread: Thread): number {
  return thread.messages.filter((m) => !m.outgoing && !m.read && m.time > thread.readUntil).length;
}

function state(): PhoneState {
  const added = new Set(phones.map((p) => p.id));
  const devices: PhoneDevice[] = phones.map((p) => {
    const l = live.get(p.id);
    const d = phoneData(p.id);
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      status: l?.status ?? 'offline',
      error: l?.error ?? null,
      battery: l?.battery ?? null,
      charging: l?.charging ?? null,
      history: p.kind === 'kdeconnect',
      pictures: p.kind === 'kdeconnect',
      unread: Object.values(d.threads).reduce((n, t) => n + unread(t), 0),
      lastSeen: p.lastSeen,
    };
  });
  const candidates = [...bluetoothCandidates, ...(kde?.candidates() ?? [])].filter((c) => !added.has(c.id));
  const pairing: PhonePairing | null = kde?.pairing() ?? null;
  return {
    phones: devices,
    candidates,
    pairing,
    bluetooth: bluetoothAvailable,
    network: kde?.network() ?? { listening: false, error: null },
    name: KdeConnect.deviceName(),
  };
}

async function refreshBluetoothCandidates(): Promise<void> {
  const found = await bluetoothPhones().catch(() => null);
  bluetoothAvailable = found !== null;
  bluetoothCandidates = (found ?? []).map((p) => ({ id: bluetoothId(p.address), kind: 'bluetooth', name: p.name }));
  changed();
}

function bluetoothId(address: string): string {
  return `bt-${address.replace(/:/g, '').toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function contactName(contacts: PhoneContact[], address: string): string | null {
  const digits = phoneDigits(address);
  if (!digits) return null;
  for (const c of contacts) if (c.numbers.some((n) => phoneDigits(n) === digits)) return c.name;
  return null;
}

function nameOf(d: PhoneData, address: string): string {
  return contactName(d.contacts, address) ?? address;
}

function conversationName(d: PhoneData, addresses: string[]): string {
  return addresses.length ? addresses.map((a) => nameOf(d, a)).join(', ') : 'Unknown';
}

function phoneDigits(address: string): string {
  const digits = address.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function sameAddresses(a: string[], b: string[]): boolean {
  const key = (list: string[]) => list.map((x) => phoneDigits(x) || x.toLowerCase()).sort().join(',');
  return key(a) === key(b);
}

/** Merge what a backend reports; new texts from others are announced. */
function upsert(phoneId: string, incoming: BackendMessage[]): void {
  const d = phoneData(phoneId);
  const touched = new Set<string>();
  const announce: PhoneMessage[] = [];
  const now = Date.now();
  for (const m of incoming) {
    if (m.time <= (d.hidden[m.threadId] ?? -1)) continue;
    const message: PhoneMessage = { ...m, phoneId, body: m.body.slice(0, MAX_BODY), status: m.status ?? (m.outgoing ? 'sent' : null) };
    const thread = (d.threads[m.threadId] ??= { messages: [], readUntil: 0 });
    const at = thread.messages.findIndex((x) => x.id === message.id);
    if (at >= 0) {
      const before = thread.messages[at];
      if (JSON.stringify(before) === JSON.stringify(message)) continue;
      thread.messages[at] = message;
    } else {
      // The phone's own copy of a text sent from here replaces the one shown while it went.
      if (message.outgoing) {
        for (const [threadId, t] of Object.entries(d.threads)) {
          const echo = t.messages.findIndex(
            (x) => x.id.startsWith('local:') && x.body === message.body && sameAddresses(x.addresses, message.addresses) && Math.abs(x.time - message.time) < ECHO_MS,
          );
          if (echo < 0) continue;
          t.messages.splice(echo, 1);
          touched.add(threadId);
          if (t.messages.length === 0 && threadId !== m.threadId) delete d.threads[threadId];
          break;
        }
      }
      thread.messages.push(message);
      if (!message.outgoing && !message.read && now - message.time < NEW_MS && message.time > thread.readUntil) announce.push(message);
    }
    touched.add(m.threadId);
  }
  if (touched.size === 0) return;
  for (const threadId of touched) {
    const thread = d.threads[threadId];
    if (!thread) continue;
    thread.messages.sort((a, b) => a.time - b.time);
    if (thread.messages.length > MAX_PER_THREAD) thread.messages.splice(0, thread.messages.length - MAX_PER_THREAD);
  }
  scheduleSave(phoneId);
  deps.sendToShell('phone:messages', { phoneId, threadIds: [...touched] });
  changed();
  for (const message of announce.slice(-5)) {
    const thread = d.threads[message.threadId];
    const addresses = thread?.messages.at(-1)?.addresses ?? message.addresses;
    deps.sendToShell('phone:incoming', {
      message,
      name: conversationName(d, addresses),
      from: message.sender ? nameOf(d, message.sender) : '',
    });
  }
}

function conversations(phoneId?: string): PhoneConversation[] {
  const list: PhoneConversation[] = [];
  for (const p of phones) {
    if (phoneId && p.id !== phoneId) continue;
    const d = phoneData(p.id);
    for (const [threadId, thread] of Object.entries(d.threads)) {
      const last = thread.messages.at(-1);
      if (!last) continue;
      const addresses = last.addresses;
      list.push({ phoneId: p.id, threadId, addresses, name: conversationName(d, addresses), last, unread: unread(thread) });
    }
  }
  return list.sort((a, b) => b.last.time - a.last.time);
}

function messages(phoneId: string, threadId: string): PhoneMessage[] {
  const connection = connections.get(phoneId);
  const key = `${phoneId}\u0000${threadId}`;
  if (connection?.loadThread && !threadId.startsWith('new:') && Date.now() - (historyAsked.get(key) ?? 0) > HISTORY_INTERVAL_MS) {
    historyAsked.set(key, Date.now());
    connection.loadThread(threadId);
  }
  return phoneData(phoneId).threads[threadId]?.messages ?? [];
}

function markRead(phoneId: string, threadId: string): void {
  const d = phoneData(phoneId);
  const thread = d.threads[threadId];
  if (!thread) return;
  const ids = thread.messages.filter((m) => !m.outgoing && !m.read).map((m) => m.id);
  thread.readUntil = Math.max(thread.readUntil, thread.messages.at(-1)?.time ?? 0, Date.now());
  for (const m of thread.messages) if (!m.outgoing) m.read = true;
  if (ids.length) connections.get(phoneId)?.markRead?.(ids);
  scheduleSave(phoneId);
  deps.sendToShell('phone:messages', { phoneId, threadIds: [threadId] });
  changed();
}

function deleteConversation(phoneId: string, threadId: string): void {
  const d = phoneData(phoneId);
  const thread = d.threads[threadId];
  if (!thread) return;
  d.hidden[threadId] = thread.messages.at(-1)?.time ?? Date.now();
  delete d.threads[threadId];
  scheduleSave(phoneId);
  deps.sendToShell('phone:messages', { phoneId, threadIds: [threadId] });
  changed();
}

/** The conversation a text to these addresses goes in: one with exactly them, or a new one. */
function threadFor(phoneId: string, addresses: string[]): string {
  const d = phoneData(phoneId);
  for (const [threadId, thread] of Object.entries(d.threads)) {
    const last = thread.messages.at(-1);
    if (last && sameAddresses(last.addresses, addresses)) return threadId;
  }
  const p = phones.find((x) => x.id === phoneId);
  // Bluetooth phones' conversations are by number already (phone-map.mts).
  if (p?.kind === 'bluetooth' && addresses.length === 1) return phoneDigits(addresses[0]) || addresses[0];
  return `new:${addresses.map((a) => phoneDigits(a) || a).sort().join(',')}`;
}

async function send(phoneId: string, addresses: string[], body: string): Promise<string> {
  const connection = connections.get(phoneId);
  if (!connection || live.get(phoneId)?.status !== 'connected') throw new Error('The phone isn’t connected.');
  const threadId = threadFor(phoneId, addresses);
  const id = `local:${Date.now()}:${nextLocal++}`;
  const base: BackendMessage = { id, threadId, addresses, sender: null, body, time: Date.now(), outgoing: true, read: true, images: [], status: 'sending' };
  upsert(phoneId, [base]);
  try {
    await connection.send(addresses, body);
    upsertIfThere(phoneId, { ...base, status: 'sent' });
  } catch (error) {
    upsertIfThere(phoneId, { ...base, status: 'failed' });
    throw error;
  }
  return threadId;
}

/** Update a sent message, unless the phone's copy replaced it meanwhile. */
function upsertIfThere(phoneId: string, message: BackendMessage): void {
  const thread = phoneData(phoneId).threads[message.threadId];
  if (thread?.messages.some((m) => m.id === message.id)) upsert(phoneId, [message]);
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

function hooks(phoneId: string): PhoneHooks {
  return {
    status(patch) {
      const before = live.get(phoneId) ?? { status: 'offline', error: null, battery: null, charging: null };
      const next = { ...before, ...patch };
      live.set(phoneId, next);
      if (next.status === 'connected' && before.status !== 'connected') {
        const p = phones.find((x) => x.id === phoneId);
        if (p) {
          p.lastSeen = Date.now();
          savePhones();
        }
      }
      changed();
    },
    messages(list) {
      upsert(phoneId, list);
    },
    contacts(list) {
      const d = phoneData(phoneId);
      d.contacts = list;
      scheduleSave(phoneId);
      deps.sendToShell('phone:messages', { phoneId, threadIds: Object.keys(d.threads) });
      changed();
    },
  };
}

function start(p: StoredPhone): void {
  if (connections.has(p.id)) return;
  if (p.kind === 'bluetooth') {
    connections.set(p.id, new MapConnection(p.address, hooks(p.id)));
  } else if (kde && p.cert) {
    connections.set(p.id, kde.connection(p.address, p.cert, hooks(p.id)));
  }
}

function syncKde(): void {
  if (!kde) return;
  const paired = phones.filter((p) => p.kind === 'kdeconnect');
  kde.setActive(paired.length > 0);
}

function add(candidateId: string): Promise<void> | void {
  if (phones.some((p) => p.id === candidateId)) return;
  const bt = bluetoothCandidates.find((c) => c.id === candidateId);
  if (bt) {
    const address = bt.id.slice(3).match(/../g)?.join(':').toUpperCase() ?? '';
    const p: StoredPhone = { id: bt.id, kind: 'bluetooth', name: bt.name, address, addedAt: Date.now(), lastSeen: null };
    phones.push(p);
    savePhones();
    start(p);
    changed();
    return;
  }
  if (!kde) throw new Error('Android phones can’t be reached here.');
  return kde.pair(candidateId);
}

/** KDE Connect finished pairing with a phone. */
function paired(deviceId: string, name: string, cert: string): void {
  const id = KdeConnect.phoneId(deviceId);
  const existing = phones.find((p) => p.id === id);
  if (existing) {
    existing.cert = cert;
    existing.name = name;
    connections.get(id)?.stop();
    connections.delete(id);
  } else {
    phones.push({ id, kind: 'kdeconnect', name, address: deviceId, cert, addedAt: Date.now(), lastSeen: null });
  }
  savePhones();
  const p = phones.find((x) => x.id === id);
  if (p) start(p);
  syncKde();
  changed();
}

function forget(phoneId: string): void {
  const p = phones.find((x) => x.id === phoneId);
  if (!p) return;
  connections.get(phoneId)?.stop();
  connections.delete(phoneId);
  if (p.kind === 'kdeconnect') kde?.unpair(p.address);
  phones = phones.filter((x) => x !== p);
  savePhones();
  clearTimeout(saveTimers.get(phoneId));
  saveTimers.delete(phoneId);
  data.delete(phoneId);
  live.delete(phoneId);
  fs.rmSync(dataFile(phoneId), { force: true });
  syncKde();
  changed();
}

function discover(on: boolean): void {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = on ? setTimeout(() => discover(false), DISCOVERY_MS) : null;
  kde?.setDiscovering(on);
  if (on) void refreshBluetoothCandidates();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function phoneArg(id: unknown): string {
  if (typeof id !== 'string' || !phones.some((p) => p.id === id)) throw new Error('No such phone.');
  return id;
}

function threadArg(id: unknown): string {
  if (typeof id !== 'string' || !id || id.length > 500) throw new Error('No such conversation.');
  return id;
}

function addressesArg(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) throw new Error('Who is it to?');
  return v.map((a) => {
    if (typeof a !== 'string' || !a.trim() || a.length > 100 || /[\r\n]/.test(a)) throw new Error('That isn’t a phone number.');
    return a.trim();
  });
}

export function registerPhoneHandlers(options: Deps): void {
  deps = options;
  const { assertShellSender } = options;
  loadPhones();

  kde = new KdeConnect({
    changed,
    paired,
    unpaired: (deviceId) => {
      hooks(KdeConnect.phoneId(deviceId)).status({ status: 'offline', error: 'The phone removed the pairing. Forget it here and pair it again.' });
    },
  });

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertShellSender(event);
      return fn(...args);
    });
  };

  handle('phone:state', async () => {
    await refreshBluetoothCandidates();
    return state();
  });
  handle('phone:conversations', (phoneId) => conversations(phoneId === undefined || phoneId === null ? undefined : phoneArg(phoneId)));
  handle('phone:messages', (phoneId, threadId) => messages(phoneArg(phoneId), threadArg(threadId)));
  handle('phone:contacts', (phoneId) => phoneData(phoneArg(phoneId)).contacts);
  handle('phone:send', (phoneId, addresses, body) => {
    if (typeof body !== 'string' || !body.trim()) throw new Error('Write something to send.');
    if (body.length > MAX_BODY) throw new Error('That’s too long for a text.');
    return send(phoneArg(phoneId), addressesArg(addresses), body);
  });
  handle('phone:markRead', (phoneId, threadId) => markRead(phoneArg(phoneId), threadArg(threadId)));
  handle('phone:deleteConversation', (phoneId, threadId) => deleteConversation(phoneArg(phoneId), threadArg(threadId)));
  handle('phone:refresh', (phoneId) => connections.get(phoneArg(phoneId))?.refresh());
  handle('phone:discover', (on) => discover(on === true));
  handle('phone:add', (id) => {
    if (typeof id !== 'string') throw new Error('No such phone.');
    return add(id);
  });
  handle('phone:answer', (id, accept) => {
    if (typeof id !== 'string') throw new Error('No such pairing.');
    kde?.answer(id, accept === true);
  });
  handle('phone:forget', (phoneId) => forget(phoneArg(phoneId)));

  onBluetoothChanged(() => {
    void refreshBluetoothCandidates();
    for (const p of phones) if (p.kind === 'bluetooth') connections.get(p.id)?.bluetoothChanged?.();
  });

  // safeStorage needs the app to be ready, which it is by now.
  for (const p of phones) start(p);
  syncKde();
  void refreshBluetoothCandidates();

  app.on('will-quit', () => {
    for (const id of [...saveTimers.keys()]) flush(id);
    for (const c of connections.values()) c.stop();
    kde?.setActive(false);
    kde?.setDiscovering(false);
  });
}

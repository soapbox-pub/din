// Passwords: Din's password manager (window.dinos.passwords, the Passwords
// app's `passwords` bridge, and the Web Browser's autofill).
//
// The vault is a KeePass file, KDBX 4, at ~/.local/share/din/Passwords.kdbx,
// so KeePassXC, Strongbox and the rest open it too. Only this process ever
// holds it open: the desktop and the app get items through these handlers,
// and pages only the one login the user picks, filled by
// passwords-preload.cjs.
//
// Unlocking at login: deriving the vault's key from its password (Argon2,
// in passwords-kdf.mts's worker) gives a key that opens the file, and that
// key - not the password, which is usually the computer's - is kept in the
// login keyring (secret-service.mts), which the boot screen's password
// unlocks. Having it gives what having the file does with a lot of guessing;
// it can't be turned back into the password. To keep it valid the vault is
// saved with the same KDF salt each time (KeePass draws a new one), and a new
// one only when its password changes. A save by another app does draw one,
// and then the next unlock asks for the password once.
//
// Settings → Password re-keys the vault with the computer's other passwords
// (lock.mts calls computerPasswordChanged), when the vault's password is the
// computer's old one.
//
// Autofill: the preload reports focus on a login field. If the vault has
// logins for the frame's site (or could make one up, for a new password),
// the desktop draws the choices below the field, and the pick comes back
// here, where the login's site is checked against the frame's actual URL
// before anything is sent to it. A submitted login the vault doesn't have
// becomes an offer to save it, which the desktop shows.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, clipboard, ipcMain, webContents } from 'electron';
import type { WebContents, WebFrameMain } from 'electron';
import type { Kdbx, KdbxEntry, KdbxGroup } from 'kdbxweb';
import { getDomain } from 'tldts-experimental';
import type { KdfRequest } from './passwords-kdf.mts';
import { parseCsvExport, parseJsonExport, type ImportedItem, type ParsedExport } from './passwords-import.mts';
import { deleteSecret, lookupSecret, storeSecret } from './secret-service.mts';

const require = createRequire(import.meta.url);
const kdbxweb = require('kdbxweb') as typeof import('kdbxweb');

const KDF_WORKER = path.join(import.meta.dirname, `passwords-kdf${path.extname(import.meta.filename)}`);
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const VAULT_FILE = path.join(DATA_HOME, 'din', 'Passwords.kdbx');
const KEYRING_ATTRIBUTES = { application: 'din', 'din-secret': 'passwords-key', file: VAULT_FILE };

/** New vaults' Argon2id: 64 MiB, about half a second. */
const KDF_MEMORY = 64 * 1024 * 1024;
const KDF_ITERATIONS = 8;
const KDF_PARALLELISM = 2;

/** The tag KeePass apps show; Passwords' Favorites. */
const FAVORITE_TAG = 'Favorite';
const STANDARD_FIELDS = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes', 'otp']);
const MAX_TEXT = 64 * 1024;
const CLIPBOARD_CLEAR_MS = 90_000;
const OFFER_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// What the desktop and the app see (src/lib/passwords.ts mirrors these)
// ---------------------------------------------------------------------------

export interface PasswordsState {
  exists: boolean;
  locked: boolean;
  /** Where the vault is. */
  file: string;
  /** Whether it opens at login, from the login keyring. */
  autoUnlock: boolean;
  /** Sites (origins) the browser never offers to save a password for. */
  never: string[];
}

export interface PasswordSummary {
  id: string;
  title: string;
  username: string;
  url: string;
  groupId: string;
  kind: 'login' | 'note';
  favorite: boolean;
  /** Whether it has a verification code (TOTP). */
  otp: boolean;
  trashed: boolean;
  created: number;
  modified: number;
}

export interface PasswordField {
  name: string;
  value: string;
  protected: boolean;
}

export interface PasswordItem extends PasswordSummary {
  password: string;
  notes: string;
  /** An otpauth:// URI or a bare base32 secret, as KeePassXC keeps it. */
  otpUri: string;
  fields: PasswordField[];
  tags: string[];
}

export interface PasswordItemInput {
  id?: string;
  groupId?: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  otpUri: string;
  fields: PasswordField[];
  favorite: boolean;
}

export interface PasswordGroup {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  /** The recycle bin, which Passwords calls Recently Deleted. */
  trash: boolean;
}

export interface PasswordList {
  rootId: string;
  items: PasswordSummary[];
  groups: PasswordGroup[];
}

export interface GenerateOptions {
  /** `apple`: three hyphenated groups of six, like Safari's. */
  style?: 'apple' | 'random';
  length?: number;
  numbers?: boolean;
  symbols?: boolean;
}

type CopyField = 'username' | 'password' | 'otp' | 'url' | 'notes' | { field: string };

export interface ImportOptions {
  /** The file's name, which a KeePass file's folder is named after. */
  name: string;
  /** A KeePass file's password. */
  password?: string;
  /** A KeePass file's key file. */
  keyFile?: ArrayBuffer | Uint8Array;
}

export interface ImportResult {
  /** Where it came from: "KeePass", "Google Passwords", "Bitwarden"… */
  source: string;
  added: number;
  /** Already in the vault. */
  skipped: number;
  /** The folder a KeePass file's items went in; null when they went in at the top. */
  folderId: string | null;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

interface DerivedKey {
  /** The KDF salt it was derived with, base64. */
  salt: string;
  key: Uint8Array;
}

/** The open vault's derived key; KDF runs with its salt answer with it. */
let knownKey: DerivedKey | null = null;
/** The last key actually derived. */
let lastDerived: DerivedKey | null = null;
/** Derive for real even with `knownKey`'s salt (checking a password). */
let bypassKnownKey = false;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function runKdf(request: KdfRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(KDF_WORKER, { workerData: request });
    worker.once('message', (message: { key?: Uint8Array; error?: string }) => {
      void worker.terminate();
      if (message.key) resolve(message.key);
      else reject(new Error(message.error ?? 'Couldn\'t derive the key'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`The key derivation stopped (${code})`));
    });
  });
}

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
  if (version !== 0x13) throw new Error('This vault uses an old version of Argon2. Open it in KeePassXC and save it again.');
  const saltId = Buffer.from(salt).toString('base64');
  if (knownKey && !bypassKnownKey && knownKey.salt === saltId) return arrayBuffer(knownKey.key);
  const key = await runKdf({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memory,
    iterations,
    length,
    parallelism,
    type,
  });
  lastDerived = { salt: saltId, key };
  return arrayBuffer(key);
});

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

interface OpenVault {
  db: Kdbx;
  /** The file as last read or written here (mtime and size), to notice other apps' saves. */
  stamp: string | null;
}

let vault: OpenVault | null = null;
/** Locked by the user: stays so until the password is typed. */
let lockedByUser = false;
let settings: { autoUnlock: boolean; never: string[] } = { autoUnlock: true, never: [] };
let options: Options | null = null;

/** Vault operations, one at a time. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'passwords.json');
}

async function loadSettings(): Promise<void> {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Partial<typeof settings>;
    settings = {
      autoUnlock: saved.autoUnlock !== false,
      never: Array.isArray(saved.never) ? saved.never.filter((o): o is string => typeof o === 'string') : [],
    };
  } catch {
    // None yet.
  }
}

async function saveSettings(): Promise<void> {
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

async function fileStamp(): Promise<string | null> {
  try {
    const stat = await fs.stat(VAULT_FILE);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

async function readVaultFile(): Promise<ArrayBuffer> {
  const data = await fs.readFile(VAULT_FILE);
  return arrayBuffer(data);
}

async function writeVaultFile(data: ArrayBuffer): Promise<void> {
  await fs.mkdir(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
  const temp = `${VAULT_FILE}.${process.pid}.tmp`;
  const handle = await fs.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(Buffer.from(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, VAULT_FILE);
}

function kdfSalt(db: Kdbx): string | null {
  const salt = db.header.kdfParameters?.get('S');
  return salt instanceof ArrayBuffer ? Buffer.from(salt).toString('base64') : null;
}

function usesArgon2(db: Kdbx): boolean {
  if (db.versionMajor < 4) return false;
  const uuid = db.header.kdfParameters?.get('$UUID');
  if (!(uuid instanceof ArrayBuffer)) return false;
  const id = Buffer.from(uuid).toString('base64');
  return id === kdbxweb.Consts.KdfId.Argon2id || id === kdbxweb.Consts.KdfId.Argon2d;
}

function useOurKdf(db: Kdbx): void {
  if (db.versionMajor < 4) db.upgrade();
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  const params = db.header.kdfParameters;
  if (!params) return;
  const { ValueType } = kdbxweb.VarDictionary;
  params.set('M', ValueType.UInt64, new kdbxweb.Int64(KDF_MEMORY));
  params.set('I', ValueType.UInt64, new kdbxweb.Int64(KDF_ITERATIONS));
  params.set('P', ValueType.UInt32, KDF_PARALLELISM);
}

/** Vaults whose next save should draw a new KDF salt (a new password). */
const freshSalt = new WeakSet<Kdbx>();

/** Keep the KDF salt across saves, so the key in the keyring keeps opening the file. */
function pinKdfSalt(db: Kdbx): void {
  const header = db.header;
  const generate = header.generateSalts.bind(header);
  header.generateSalts = () => {
    const salt = header.kdfParameters?.get('S');
    generate();
    if (freshSalt.has(db)) {
      freshSalt.delete(db);
      return;
    }
    if (salt instanceof ArrayBuffer) header.kdfParameters?.set('S', kdbxweb.VarDictionary.ValueType.Bytes, salt);
  };
}

function exists(): Promise<boolean> {
  return fileStamp().then((stamp) => stamp !== null);
}

async function state(): Promise<PasswordsState> {
  return {
    exists: await exists(),
    locked: !vault,
    file: VAULT_FILE,
    autoUnlock: settings.autoUnlock,
    never: [...settings.never],
  };
}

let changeTimer: ReturnType<typeof setTimeout> | null = null;
function notifyChanged(): void {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    void state().then((s) => options?.sendToShell('passwords:changed', s));
  }, 50);
}

/** The keyring's copy of the open vault's key, refreshed. */
async function rememberKey(): Promise<void> {
  if (!settings.autoUnlock || !knownKey) return;
  const secret = Buffer.from(JSON.stringify({ salt: knownKey.salt, key: Buffer.from(knownKey.key).toString('base64') }));
  await storeSecret('Passwords (Din)', KEYRING_ATTRIBUTES, secret);
}

function isWrongKey(error: unknown): boolean {
  return error instanceof kdbxweb.KdbxError && error.code === kdbxweb.Consts.ErrorCodes.InvalidKey;
}

function opened(db: Kdbx, stamp: string | null): void {
  pinKdfSalt(db);
  vault = { db, stamp };
  lockedByUser = false;
  const salt = kdfSalt(db);
  if (lastDerived && lastDerived.salt === salt) knownKey = lastDerived;
  notifyChanged();
}

async function unlockWithPassword(password: string): Promise<void> {
  if (vault) return;
  knownKey = null;
  lastDerived = null;
  const stamp = await fileStamp();
  if (!stamp) throw new Error('There are no passwords to unlock yet');
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
  let db: Kdbx;
  try {
    db = await kdbxweb.Kdbx.load(await readVaultFile(), credentials);
  } catch (error) {
    if (isWrongKey(error)) throw new Error('That password is incorrect', { cause: error });
    throw error;
  }
  opened(db, stamp);
  if (!usesArgon2(db)) {
    // Older KeePass files use a KDF Din can't keep a key for; bring the file up to date.
    useOurKdf(db);
    await save();
  }
  void rememberKey();
}

type AutoUnlock = 'unlocked' | 'retry' | 'no';

async function unlockFromKeyring(): Promise<AutoUnlock> {
  if (vault) return 'unlocked';
  if (!settings.autoUnlock || lockedByUser || !(await exists())) return 'no';
  const found = await lookupSecret(KEYRING_ATTRIBUTES);
  if (found.state === 'locked' || found.state === 'unavailable') return 'retry';
  if (found.state !== 'found') return 'no';
  let key: DerivedKey;
  try {
    const parsed = JSON.parse(found.secret.toString()) as { salt?: unknown; key?: unknown };
    if (typeof parsed.salt !== 'string' || typeof parsed.key !== 'string') return 'no';
    key = { salt: parsed.salt, key: new Uint8Array(Buffer.from(parsed.key, 'base64')) };
  } catch {
    return 'no';
  }
  if (vault) return 'unlocked';
  knownKey = key;
  lastDerived = null;
  try {
    const stamp = await fileStamp();
    // The key stands in for the password: KDF runs with its salt answer with it.
    const db = await kdbxweb.Kdbx.load(await readVaultFile(), new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('')));
    lastDerived = key;
    opened(db, stamp);
    return 'unlocked';
  } catch (error) {
    knownKey = null;
    // Another app saved the vault with a new salt: the password opens it next.
    if (isWrongKey(error)) void deleteSecret(KEYRING_ATTRIBUTES);
    else console.warn('[passwords] unlocking from the keyring:', error);
    return 'no';
  }
}

/** At login, the keyring may still be locked for a few seconds: try a while. */
function scheduleAutoUnlock(attempt = 0): void {
  void serial(unlockFromKeyring).then(
    (result) => {
      if (result === 'retry' && attempt < 45) setTimeout(() => scheduleAutoUnlock(attempt + 1), 2000);
    },
    () => {},
  );
}

function lock(): void {
  vault = null;
  knownKey = null;
  lastDerived = null;
  lockedByUser = true;
  hideSuggestions();
  for (const offer of offers.values()) clearTimeout(offer.timer);
  offers.clear();
  notifyChanged();
}

async function create(password: string): Promise<void> {
  if (vault || (await exists())) throw new Error('There\'s already a vault');
  if (!password) throw new Error('A password is needed');
  knownKey = null;
  lastDerived = null;
  const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)), 'Passwords');
  useOurKdf(db);
  opened(db, null);
  await save();
}

/** Read in what another app saved meanwhile. */
async function mergeFromDisk(open: OpenVault): Promise<boolean> {
  try {
    const remote = await kdbxweb.Kdbx.load(await readVaultFile(), open.db.credentials);
    open.db.merge(remote);
    open.stamp = await fileStamp();
    return true;
  } catch (error) {
    console.warn('[passwords] reading another app\'s changes:', error);
    return false;
  }
}

async function refresh(): Promise<void> {
  if (!vault) return;
  const stamp = await fileStamp();
  if (stamp && stamp !== vault.stamp) await mergeFromDisk(vault);
}

async function save(): Promise<void> {
  const open = vault;
  if (!open) throw new Error('Passwords is locked');
  const stamp = await fileStamp();
  if (stamp && open.stamp !== stamp && !(await mergeFromDisk(open))) {
    throw new Error('Another app changed Passwords.kdbx with a different password. Lock Passwords and unlock it again.');
  }
  const data = await open.db.save();
  await writeVaultFile(data);
  open.stamp = await fileStamp();
  const salt = kdfSalt(open.db);
  if (lastDerived && lastDerived.salt === salt && knownKey?.salt !== salt) {
    knownKey = lastDerived;
    await rememberKey();
  }
  notifyChanged();
}

/** Whether `password` is the open vault's. */
async function isVaultPassword(password: string): Promise<boolean> {
  const open = vault;
  if (!open || !knownKey || !open.db.header.kdfParameters) return false;
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
  await credentials.ready;
  bypassKnownKey = true;
  let key: ArrayBuffer;
  try {
    key = await kdbxweb.KeyEncryptorKdf.encrypt(await credentials.getHash(), open.db.header.kdfParameters);
  } finally {
    bypassKnownKey = false;
  }
  const expected = Buffer.from(knownKey.key);
  const actual = Buffer.from(key);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function setVaultPassword(password: string): Promise<void> {
  const open = vault;
  if (!open) throw new Error('Passwords is locked');
  await open.db.credentials.setPassword(kdbxweb.ProtectedValue.fromString(password));
  freshSalt.add(open.db);
  await save();
}

/**
 * The computer's password changed (Settings → Password, lock.mts): the vault
 * follows if its password was the old one.
 */
export function computerPasswordChanged(old: string, next: string): Promise<void> {
  return serial(async () => {
    if (!(await exists())) return;
    const wasLocked = !vault;
    if (wasLocked) {
      try {
        await unlockWithPassword(old);
      } catch {
        return;
      }
    } else if (!(await isVaultPassword(old))) {
      return;
    }
    await setVaultPassword(next);
    if (wasLocked && lockedByUser) lock();
  }).catch((error: unknown) => console.warn('[passwords] following the new password:', error));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function fieldText(entry: KdbxEntry, name: string): string {
  const value = entry.fields.get(name);
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.getText();
}

function setField(entry: KdbxEntry, name: string, value: string, isProtected: boolean): void {
  entry.fields.set(name, isProtected ? kdbxweb.ProtectedValue.fromString(value) : value);
}

function otpOf(entry: KdbxEntry): string {
  return fieldText(entry, 'otp') || fieldText(entry, 'TOTP Seed');
}

/** The sites a login is for: its URL, and KeePass2Android's extra ones. */
function urlsOf(entry: KdbxEntry): string[] {
  const urls = [fieldText(entry, 'URL')];
  for (const name of entry.fields.keys()) {
    if (/^KP2A_URL(_\d+)?$/.test(name)) urls.push(fieldText(entry, name));
  }
  return urls.filter(Boolean);
}

function recycleBin(db: Kdbx): KdbxGroup | undefined {
  const id = db.meta.recycleBinUuid;
  return db.meta.recycleBinEnabled && id && !id.empty ? db.getGroup(id) : undefined;
}

function inTrash(db: Kdbx, group: KdbxGroup | undefined): boolean {
  const bin = recycleBin(db);
  for (let g = group; g; g = g.parentGroup) if (bin && g === bin) return true;
  return false;
}

function summary(db: Kdbx, entry: KdbxEntry): PasswordSummary {
  const username = fieldText(entry, 'UserName');
  const url = fieldText(entry, 'URL');
  const hasSecret = !!(username || url || fieldText(entry, 'Password'));
  // A note, or a card or such brought in from another app: fields and no login.
  const hasNote = !!fieldText(entry, 'Notes') || [...entry.fields.keys()].some((name) => !STANDARD_FIELDS.has(name));
  return {
    id: entry.uuid.id,
    title: fieldText(entry, 'Title'),
    username,
    url,
    groupId: entry.parentGroup?.uuid.id ?? '',
    kind: hasSecret || !hasNote ? 'login' : 'note',
    favorite: entry.tags.includes(FAVORITE_TAG),
    otp: !!otpOf(entry),
    trashed: inTrash(db, entry.parentGroup),
    created: entry.times.creationTime?.getTime() ?? 0,
    modified: entry.lastModTime,
  };
}

function item(db: Kdbx, entry: KdbxEntry): PasswordItem {
  const fields: PasswordField[] = [];
  for (const [name, value] of entry.fields) {
    if (STANDARD_FIELDS.has(name)) continue;
    fields.push({ name, value: typeof value === 'string' ? value : value.getText(), protected: typeof value !== 'string' });
  }
  return {
    ...summary(db, entry),
    password: fieldText(entry, 'Password'),
    notes: fieldText(entry, 'Notes'),
    otpUri: otpOf(entry),
    fields,
    tags: entry.tags.filter((t) => t !== FAVORITE_TAG),
  };
}

function openVault(): Kdbx {
  if (!vault) throw new Error('Passwords is locked');
  return vault.db;
}

function findEntry(db: Kdbx, id: unknown): KdbxEntry {
  if (typeof id === 'string') {
    for (const entry of db.getDefaultGroup().allEntries()) if (entry.uuid.id === id) return entry;
  }
  throw new Error('That item is gone');
}

function findGroup(db: Kdbx, id: unknown): KdbxGroup {
  const group = typeof id === 'string' ? db.getGroup(id) : undefined;
  if (!group) throw new Error('That folder is gone');
  return group;
}

function list(db: Kdbx): PasswordList {
  const root = db.getDefaultGroup();
  const bin = recycleBin(db);
  const groups: PasswordGroup[] = [];
  const walk = (group: KdbxGroup, depth: number) => {
    for (const child of group.groups) {
      groups.push({
        id: child.uuid.id,
        name: child.name ?? '',
        parentId: group === root ? null : group.uuid.id,
        depth,
        trash: child === bin,
      });
      if (child !== bin) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  const items = [...root.allEntries()].map((entry) => summary(db, entry));
  return { rootId: root.uuid.id, items, groups };
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error(`Not a usable ${name}`);
  return value;
}

function parseInput(raw: unknown): PasswordItemInput {
  if (!raw || typeof raw !== 'object') throw new Error('Not an item');
  const r = raw as Record<string, unknown>;
  const fields = Array.isArray(r.fields) ? r.fields : [];
  return {
    id: typeof r.id === 'string' ? r.id : undefined,
    groupId: typeof r.groupId === 'string' ? r.groupId : undefined,
    title: text(r.title, 'title'),
    username: text(r.username, 'username'),
    password: text(r.password, 'password'),
    url: text(r.url, 'website'),
    notes: text(r.notes, 'note'),
    otpUri: text(r.otpUri ?? '', 'verification code'),
    favorite: r.favorite === true,
    fields: fields.map((f: unknown) => {
      const field = (f ?? {}) as Record<string, unknown>;
      const name = text(field.name, 'field name').trim();
      if (!name || STANDARD_FIELDS.has(name)) throw new Error(`"${name}" can't be a field's name`);
      return { name, value: text(field.value, 'field'), protected: field.protected === true };
    }),
  };
}

function trimHistory(db: Kdbx, entry: KdbxEntry): void {
  const max = db.meta.historyMaxItems ?? 10;
  if (max >= 0 && entry.history.length > max) entry.removeHistory(0, entry.history.length - max);
}

function saveItem(db: Kdbx, input: PasswordItemInput): string {
  let entry: KdbxEntry;
  if (input.id) {
    entry = findEntry(db, input.id);
    entry.pushHistory();
    trimHistory(db, entry);
  } else {
    const group = input.groupId ? findGroup(db, input.groupId) : db.getDefaultGroup();
    entry = db.createEntry(inTrash(db, group) ? db.getDefaultGroup() : group);
  }
  setField(entry, 'Title', input.title, false);
  setField(entry, 'UserName', input.username, false);
  setField(entry, 'Password', input.password, true);
  setField(entry, 'URL', input.url, false);
  setField(entry, 'Notes', input.notes, false);
  if (input.otpUri.trim()) setField(entry, 'otp', input.otpUri.trim(), true);
  else entry.fields.delete('otp');
  const keep = new Set(input.fields.map((f) => f.name));
  for (const name of [...entry.fields.keys()]) {
    if (!STANDARD_FIELDS.has(name) && !keep.has(name)) entry.fields.delete(name);
  }
  for (const field of input.fields) setField(entry, field.name, field.value, field.protected);
  setFavorite(entry, input.favorite);
  entry.times.update();
  if (input.id && input.groupId && entry.parentGroup?.uuid.id !== input.groupId) {
    const group = findGroup(db, input.groupId);
    if (!inTrash(db, group)) db.move(entry, group);
  }
  return entry.uuid.id;
}

function setFavorite(entry: KdbxEntry, favorite: boolean): void {
  const has = entry.tags.includes(FAVORITE_TAG);
  if (favorite && !has) entry.tags = [...entry.tags, FAVORITE_TAG];
  if (!favorite && has) entry.tags = entry.tags.filter((t) => t !== FAVORITE_TAG);
}

function restore(db: Kdbx, entry: KdbxEntry): void {
  const previous = entry.previousParentGroup ? db.getGroup(entry.previousParentGroup) : undefined;
  db.move(entry, previous && !inTrash(db, previous) ? previous : db.getDefaultGroup());
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

const MAX_IMPORT = 32 * 1024 * 1024;
/** KDBX's first signature, 0x9AA2D903, little-endian. */
const KDBX_SIGNATURE = [0x03, 0xd9, 0xa2, 0x9a];

function bytesOf(value: unknown, name: string): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new Error(`Not a usable ${name}`);
}

/** What makes two items the same, so importing a file twice adds nothing the second time. */
function sameness(title: string, username: string, password: string, url: string, notes: string): string {
  if (!username && !password && !url) return `note\0${title}\0${notes}`;
  return `login\0${siteOf(url)?.host ?? url.trim()}\0${username}\0${password}`;
}

function entrySameness(entry: KdbxEntry): string {
  return sameness(fieldText(entry, 'Title'), fieldText(entry, 'UserName'), fieldText(entry, 'Password'), fieldText(entry, 'URL'), fieldText(entry, 'Notes'));
}

function liveSameness(db: Kdbx): Set<string> {
  const keys = new Set<string>();
  for (const entry of db.getDefaultGroup().allEntries()) {
    if (!inTrash(db, entry.parentGroup)) keys.add(entrySameness(entry));
  }
  return keys;
}

/** A folder by its path of names from the top, made if it's not there. */
function folderAt(db: Kdbx, names: string[]): KdbxGroup {
  const bin = recycleBin(db);
  let group = db.getDefaultGroup();
  for (const name of names) group = group.groups.find((g) => g !== bin && g.name === name) ?? db.createGroup(group, name);
  return group;
}

/** An item from another app's export into the vault, unless the vault has it. */
function addImported(db: Kdbx, item: ImportedItem, keys: Set<string>): boolean {
  const title = item.title || siteOf(item.url)?.host || '';
  const key = sameness(title, item.username, item.password, item.url, item.notes);
  if (keys.has(key)) return false;
  keys.add(key);
  const entry = db.createEntry(folderAt(db, item.folder));
  setField(entry, 'Title', title, false);
  setField(entry, 'UserName', item.username, false);
  setField(entry, 'Password', item.password, true);
  setField(entry, 'URL', item.url, false);
  setField(entry, 'Notes', item.notes, false);
  if (item.otp) setField(entry, 'otp', item.otp, true);
  for (const field of item.fields) {
    let name = field.name;
    for (let n = 2; STANDARD_FIELDS.has(name) || entry.fields.has(name); n++) name = `${field.name} ${n}`;
    setField(entry, name, field.value, field.protected);
  }
  entry.tags = [...new Set(item.tags.filter((t) => t !== FAVORITE_TAG))];
  setFavorite(entry, item.favorite);
  entry.times.update();
  if (item.created) entry.times.creationTime = item.created;
  if (item.modified) entry.times.lastModTime = item.modified;
  return true;
}

async function readKdbx(data: Uint8Array, opts: Record<string, unknown>): Promise<Kdbx> {
  const pw = typeof opts.password === 'string' && opts.password ? kdbxweb.ProtectedValue.fromString(password(opts.password)) : null;
  const keyFile = opts.keyFile ? arrayBuffer(bytesOf(opts.keyFile, 'key file')) : null;
  if (!pw && !keyFile) throw new Error('A KeePass file needs its password');
  const derived = lastDerived;
  // Even a copy of this vault, with its salt, is opened with what was typed.
  bypassKnownKey = true;
  try {
    return await kdbxweb.Kdbx.load(arrayBuffer(data), new kdbxweb.Credentials(pw, keyFile));
  } catch (error) {
    if (isWrongKey(error)) throw new Error(keyFile ? 'That password or key file is incorrect' : 'That password is incorrect', { cause: error });
    throw error;
  } finally {
    bypassKnownKey = false;
    lastDerived = derived;
  }
}

/** A KeePass file's items and folders, into a folder of their own named after the file. */
function copyKdbx(db: Kdbx, source: Kdbx, name: string, keys: Set<string>): { added: number; skipped: number; folder: KdbxGroup | null } {
  const sourceBin = recycleBin(source);
  const top = db.createGroup(db.getDefaultGroup(), path.basename(name, path.extname(name)) || source.meta.name || 'Imported');
  let added = 0;
  let skipped = 0;
  const copy = (from: KdbxGroup, to: KdbxGroup) => {
    for (const entry of from.entries) {
      const key = entrySameness(entry);
      if (keys.has(key)) {
        skipped++;
        continue;
      }
      keys.add(key);
      const modified = entry.times.lastModTime;
      db.importEntry(entry, to, source).times.lastModTime = modified;
      added++;
    }
    for (const child of from.groups) {
      if (child === sourceBin) continue;
      const group = db.createGroup(to, child.name ?? '');
      copy(child, group);
      // A folder left empty because the vault had all of it goes; one that was empty stays.
      if (group.entries.length === 0 && group.groups.length === 0 && [...child.allEntries()].length > 0) db.move(group, undefined);
    }
  };
  copy(source.getDefaultGroup(), top);
  if (added > 0) return { added, skipped, folder: top };
  db.move(top, undefined);
  return { added, skipped, folder: null };
}

/** Passwords' Import: a KeePass file, or another app's CSV or JSON export. */
async function importFile(raw: unknown, rawOpts: unknown): Promise<ImportResult> {
  const data = bytesOf(raw, 'file');
  if (data.byteLength > MAX_IMPORT) throw new Error('That file is too big to be a passwords export');
  const opts = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {}) as Record<string, unknown>;
  const name = typeof opts.name === 'string' ? opts.name.slice(0, 255) : '';
  openVault();
  if (KDBX_SIGNATURE.every((b, i) => data[i] === b)) {
    const source = await readKdbx(data, opts);
    await refresh();
    const db = openVault();
    const { added, skipped, folder } = copyKdbx(db, source, name, liveSameness(db));
    await save();
    return { source: 'KeePass', added, skipped, folderId: folder?.uuid.id ?? null };
  }
  const text = new TextDecoder().decode(data);
  const parsed: ParsedExport = /^\uFEFF?\s*[[{]/.test(text) ? parseJsonExport(text) : parseCsvExport(text);
  if (parsed.items.length === 0) throw new Error('There are no passwords in that file');
  await refresh();
  const db = openVault();
  const keys = liveSameness(db);
  let added = 0;
  for (const item of parsed.items) if (addImported(db, item, keys)) added++;
  if (added > 0) await save();
  return { source: parsed.source, added, skipped: parsed.items.length - added, folderId: null };
}

// ---------------------------------------------------------------------------
// Sites, codes, generating, copying
// ---------------------------------------------------------------------------

interface Site {
  protocol: string;
  host: string;
  /** The registrable domain, where there is one. */
  domain: string | null;
}

function siteOf(url: string): Site | null {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  return { protocol: parsed.protocol, host, domain: getDomain(host, { allowPrivateDomains: true }) };
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Whether a login saved for `saved` may be filled on `page`: the same host,
 * or the same registrable domain (one login for example.com and
 * accounts.example.com), and never from https to http.
 */
function siteMatches(saved: string, page: string): boolean {
  const s = siteOf(saved);
  const p = siteOf(page);
  if (!s || !p) return false;
  if (s.protocol === 'https:' && p.protocol === 'http:' && !isLocalHost(p.host)) return false;
  return s.host === p.host || (s.domain !== null && s.domain === p.domain);
}

function loginsFor(db: Kdbx, pageUrl: string): KdbxEntry[] {
  const bin = recycleBin(db);
  const logins: KdbxEntry[] = [];
  for (const entry of db.getDefaultGroup().allEntries()) {
    if (bin && inTrash(db, entry.parentGroup)) continue;
    if (urlsOf(entry).some((url) => siteMatches(url, pageUrl))) logins.push(entry);
  }
  // Exact hosts first, then by name.
  const host = siteOf(pageUrl)?.host;
  const exact = (e: KdbxEntry) => (urlsOf(e).some((u) => siteOf(u)?.host === host) ? 0 : 1);
  return logins.sort((a, b) => exact(a) - exact(b) || fieldText(a, 'Title').localeCompare(fieldText(b, 'Title')));
}

const LETTERS = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+-=?@^_~';

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

export function generatePassword(opts: GenerateOptions = {}): string {
  if (opts.style !== 'random') {
    // Safari's shape: xxxxxx-xxxxxx-xxxxxx, one capital, one digit.
    const chars = Array.from({ length: 18 }, () => pick(LETTERS));
    const upper = randomInt(18);
    let digit = randomInt(17);
    if (digit >= upper) digit++;
    chars[upper] = chars[upper].toUpperCase();
    chars[digit] = pick(DIGITS);
    return [chars.slice(0, 6), chars.slice(6, 12), chars.slice(12)].map((g) => g.join('')).join('-');
  }
  const length = Math.min(128, Math.max(8, Math.round(opts.length ?? 20)));
  const sets = [LETTERS, LETTERS.toUpperCase()];
  if (opts.numbers !== false) sets.push(DIGITS);
  if (opts.symbols) sets.push(SYMBOLS);
  const all = sets.join('');
  // One of each kind asked for, the rest from all of them, shuffled.
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The current code of an otpauth:// URI or bare secret (src/shared/totp.ts does the same for display). */
function totp(uri: string, now = Date.now()): string {
  let secret = uri;
  let digits = 6;
  let period = 30;
  let algorithm = 'sha1';
  if (uri.startsWith('otpauth://')) {
    const params = new URL(uri).searchParams;
    secret = params.get('secret') ?? '';
    digits = Number(params.get('digits')) || 6;
    period = Number(params.get('period')) || 30;
    algorithm = (params.get('algorithm') ?? 'SHA1').toLowerCase();
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hmac = createHmac(algorithm, base32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

let clipboardTimer: ReturnType<typeof setTimeout> | null = null;

/** Put a value on the clipboard; a secret is taken off again in a minute and a half, if it's still there. */
function copy(value: string, secret: boolean): void {
  clipboard.writeText(value);
  if (clipboardTimer) clearTimeout(clipboardTimer);
  clipboardTimer = null;
  if (!secret) return;
  clipboardTimer = setTimeout(() => {
    clipboardTimer = null;
    if (clipboard.readText() === value) clipboard.clear();
  }, CLIPBOARD_CLEAR_MS);
}

function copyField(entry: KdbxEntry, field: CopyField): void {
  if (field === 'username') return copy(fieldText(entry, 'UserName'), false);
  if (field === 'password') return copy(fieldText(entry, 'Password'), true);
  if (field === 'otp') return copy(totp(otpOf(entry)), true);
  if (field === 'url') return copy(fieldText(entry, 'URL'), false);
  if (field === 'notes') return copy(fieldText(entry, 'Notes'), false);
  if (field && typeof field === 'object' && typeof field.field === 'string' && entry.fields.has(field.field)) {
    return copy(fieldText(entry, field.field), typeof entry.fields.get(field.field) !== 'string');
  }
  throw new Error('Not a field');
}

// ---------------------------------------------------------------------------
// Autofill
// ---------------------------------------------------------------------------

type FieldKind = 'username' | 'password' | 'new-password';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Suggestions the desktop is showing below a field. */
interface Suggestion {
  requestId: number;
  contents: WebContents;
  frame: WebFrameMain;
  url: string;
  generated: string | null;
}

let suggestion: Suggestion | null = null;
let nextRequestId = 1;

/** Logins a page submitted that the vault doesn't have, waiting on the user. */
interface Offer {
  id: number;
  contents: WebContents;
  url: string;
  origin: string;
  username: string;
  password: string;
  updateId: string | null;
  timer: ReturnType<typeof setTimeout>;
}

const offers = new Map<number, Offer>();
let nextOfferId = 1;
const watched = new WeakSet<WebContents>();

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function sendToFrame(frame: WebFrameMain, channel: string, payload: unknown): void {
  try {
    if (!frame.detached) frame.send(channel, payload);
  } catch {
    // The frame went away.
  }
}

function sameFrame(a: WebFrameMain | null | undefined, b: WebFrameMain): boolean {
  return !!a && a.processId === b.processId && a.routingId === b.routingId;
}

function hideSuggestions(requestId?: number): void {
  const s = suggestion;
  if (!s || (requestId !== undefined && requestId !== s.requestId)) return;
  suggestion = null;
  options?.sendToShell('passwords:hide', { requestId: s.requestId });
  sendToFrame(s.frame, 'passwords:shown', { visible: false, highlighted: false });
}

function dropOffers(contents: WebContents): void {
  for (const [id, offer] of offers) {
    if (offer.contents !== contents) continue;
    clearTimeout(offer.timer);
    offers.delete(id);
    options?.sendToShell('passwords:offer-gone', { offerId: id });
  }
}

/** Suggestions go when their page does. */
function watch(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on('did-start-navigation', (event) => {
    if (suggestion?.contents === contents && !event.isSameDocument) hideSuggestions();
  });
  contents.once('destroyed', () => {
    if (suggestion?.contents === contents) hideSuggestions();
    dropOffers(contents);
  });
}

function parseRect(raw: unknown): Rect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 4 ? v : null);
  const x = n(r.x);
  const y = n(r.y);
  const width = n(r.width);
  const height = n(r.height);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

function webSender(event: Electron.IpcMainEvent): { contents: WebContents; frame: WebFrameMain; url: string } | null {
  const contents = event.sender;
  const frame = event.senderFrame;
  if (!frame || contents.isDestroyed() || !options?.isAutofillGuest(contents)) return null;
  const url = frame.url;
  return isWebUrl(url) ? { contents, frame, url } : null;
}

async function onField(event: Electron.IpcMainEvent, raw: unknown): Promise<void> {
  const sender = webSender(event);
  if (!sender) return;
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind === 'username' || r.kind === 'password' || r.kind === 'new-password' ? (r.kind as FieldKind) : null;
  const rect = parseRect(r.rect);
  if (!kind || !rect) return;
  await serial(refresh).catch(() => {});
  const db = vault?.db;
  if (!db && !(await exists())) return hideSuggestions();
  const items = db && kind !== 'new-password'
    ? loginsFor(db, sender.url).map((e) => ({ id: e.uuid.id, title: fieldText(e, 'Title'), username: fieldText(e, 'UserName') }))
    : [];
  const generated = db && kind === 'new-password' ? generatePassword() : null;
  if (db && items.length === 0 && !generated) return hideSuggestions();
  if (suggestion) hideSuggestions();
  watch(sender.contents);
  const requestId = nextRequestId++;
  suggestion = { requestId, contents: sender.contents, frame: sender.frame, url: sender.url, generated };
  options?.sendToShell('passwords:suggest', {
    requestId,
    wcId: sender.contents.id,
    mainFrame: sender.frame === sender.contents.mainFrame,
    rect,
    kind,
    site: siteOf(sender.url)?.host ?? '',
    items,
    locked: !db,
    generated,
  });
  sendToFrame(sender.frame, 'passwords:shown', { visible: true, highlighted: false });
}

function onSubmitted(event: Electron.IpcMainEvent, raw: unknown): void {
  const sender = webSender(event);
  const db = vault?.db;
  if (!sender || !db) return;
  const r = (raw ?? {}) as Record<string, unknown>;
  const username = typeof r.username === 'string' ? r.username.trim().slice(0, 1024) : '';
  const password = typeof r.password === 'string' && r.password.length <= 1024 ? r.password : '';
  if (!password) return;
  const origin = sender.frame.origin;
  if (settings.never.includes(origin)) return;
  const logins = loginsFor(db, sender.url);
  if (logins.some((e) => fieldText(e, 'UserName') === username && fieldText(e, 'Password') === password)) return;
  const update = logins.find((e) => fieldText(e, 'UserName') === username) ?? null;
  dropOffers(sender.contents);
  watch(sender.contents);
  const id = nextOfferId++;
  const offer: Offer = {
    id,
    contents: sender.contents,
    url: sender.url,
    origin,
    username,
    password,
    updateId: update ? update.uuid.id : null,
    timer: setTimeout(() => {
      offers.delete(id);
      options?.sendToShell('passwords:offer-gone', { offerId: id });
    }, OFFER_TTL_MS),
  };
  offers.set(id, offer);
  options?.sendToShell('passwords:offer', {
    offerId: id,
    wcId: sender.contents.id,
    site: siteOf(sender.url)?.host ?? '',
    username,
    update: !!update,
  });
}

/** What the desktop picked from the suggestions. */
type Choice = { type: 'login'; id: string } | { type: 'generated' } | { type: 'dismiss' };

function choose(requestId: unknown, raw: unknown): void {
  const s = suggestion;
  if (!s || requestId !== s.requestId) return;
  const choice = (raw ?? {}) as Choice;
  hideSuggestions();
  if (s.frame.detached || s.contents.isDestroyed()) return;
  // The frame may have moved on since it asked.
  const url = s.frame.url;
  if (choice.type === 'login') {
    const db = vault?.db;
    if (!db) return;
    const entry = findEntry(db, choice.id);
    if (!urlsOf(entry).some((saved) => siteMatches(saved, url))) return;
    sendToFrame(s.frame, 'passwords:fill', {
      username: fieldText(entry, 'UserName'),
      password: fieldText(entry, 'Password'),
      generated: false,
    });
  } else if (choice.type === 'generated' && s.generated && siteOf(url)?.host === siteOf(s.url)?.host) {
    sendToFrame(s.frame, 'passwords:fill', { username: null, password: s.generated, generated: true });
  }
}

/** Fill a login into whichever of a page's frames are on its site (the toolbar's Fill). */
function fillPage(wcId: unknown, id: unknown): number {
  const db = openVault();
  const contents = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
  if (!contents || contents.isDestroyed() || !options?.isAutofillGuest(contents)) return 0;
  const entry = findEntry(db, id);
  const urls = urlsOf(entry);
  let sent = 0;
  for (const frame of contents.mainFrame.framesInSubtree) {
    if (!isWebUrl(frame.url) || !urls.some((saved) => siteMatches(saved, frame.url))) continue;
    sendToFrame(frame, 'passwords:fill', {
      username: fieldText(entry, 'UserName'),
      password: fieldText(entry, 'Password'),
      generated: false,
    });
    sent++;
  }
  return sent;
}

async function answerOffer(offerId: unknown, answer: unknown, username: unknown): Promise<void> {
  const offer = typeof offerId === 'number' ? offers.get(offerId) : undefined;
  if (!offer) return;
  clearTimeout(offer.timer);
  offers.delete(offer.id);
  if (answer === 'never') {
    if (!settings.never.includes(offer.origin)) settings.never.push(offer.origin);
    await saveSettings();
    notifyChanged();
    return;
  }
  if (answer !== 'save') return;
  await serial(async () => {
    const db = openVault();
    await refresh();
    const name = typeof username === 'string' ? username.trim().slice(0, 1024) : offer.username;
    if (offer.updateId) {
      const entry = findEntry(db, offer.updateId);
      entry.pushHistory();
      trimHistory(db, entry);
      setField(entry, 'UserName', name, false);
      setField(entry, 'Password', offer.password, true);
      entry.times.update();
    } else {
      saveItem(db, {
        title: siteOf(offer.url)?.host ?? offer.origin,
        username: name,
        password: offer.password,
        url: offer.origin,
        notes: '',
        otpUri: '',
        fields: [],
        favorite: false,
      });
    }
    await save();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  /** Whether a call came from the desktop itself rather than an app's bridge port. */
  isBridgeEvent: (event: Electron.IpcMainInvokeEvent) => boolean;
  sendToShell: (channel: string, payload: unknown) => void;
  /** Web pages the browser autofills: tabs (private ones too) and installed web apps. */
  isAutofillGuest: (contents: WebContents) => boolean;
}

function password(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Not a usable password');
  return value;
}

export function registerPasswordsHandlers(opts: Options): void {
  options = opts;
  const { assertShellSender } = opts;
  /** The desktop's own channels, which no app's bridge reaches. */
  const assertDesktop = (event: Electron.IpcMainInvokeEvent) => {
    assertShellSender(event);
    if (opts.isBridgeEvent(event)) throw new Error('Not for apps');
  };
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(`passwords:${channel}`, (event, ...args: unknown[]) => {
      assertShellSender(event);
      return fn(...args);
    });
  };
  const edit = (fn: (db: Kdbx, ...args: unknown[]) => unknown) => (...args: unknown[]) =>
    serial(async () => {
      await refresh();
      const result = fn(openVault(), ...args);
      await save();
      return result;
    });

  void loadSettings().then(() => scheduleAutoUnlock());

  handle('state', () => serial(async () => {
    if (!vault) await unlockFromKeyring();
    return state();
  }));
  handle('create', (pw) => serial(() => create(password(pw))));
  handle('unlock', (pw) => serial(() => unlockWithPassword(password(pw))));
  handle('lock', () => lock());
  handle('setAutoUnlock', (on) => serial(async () => {
    settings.autoUnlock = on === true;
    await saveSettings();
    if (settings.autoUnlock) await rememberKey();
    else await deleteSecret(KEYRING_ATTRIBUTES);
    notifyChanged();
  }));
  handle('forgetNever', async (origin) => {
    settings.never = settings.never.filter((o) => o !== origin);
    await saveSettings();
    notifyChanged();
  });
  handle('changePassword', (old, next) => serial(async () => {
    if (!(await isVaultPassword(password(old)))) throw new Error('The current password is incorrect');
    await setVaultPassword(password(next));
  }));
  handle('list', () => serial(async () => {
    await refresh();
    return list(openVault());
  }));
  handle('get', (id) => serial(async () => {
    await refresh();
    const db = openVault();
    return item(db, findEntry(db, id));
  }));
  handle('save', edit((db, raw) => saveItem(db, parseInput(raw))));
  handle('setFavorite', edit((db, id, on) => {
    const entry = findEntry(db, id);
    setFavorite(entry, on === true);
    entry.times.update();
  }));
  handle('move', edit((db, id, groupId) => {
    const group = findGroup(db, groupId);
    if (inTrash(db, group)) throw new Error('Not a folder');
    db.move(findEntry(db, id), group);
  }));
  handle('trash', edit((db, id) => {
    const entry = findEntry(db, id);
    if (inTrash(db, entry.parentGroup)) db.move(entry, undefined);
    else db.remove(entry);
  }));
  handle('restore', edit((db, id) => restore(db, findEntry(db, id))));
  handle('deleteForever', edit((db, id) => db.move(findEntry(db, id), undefined)));
  handle('emptyTrash', edit((db) => {
    const bin = recycleBin(db);
    if (!bin) return;
    for (const group of [...bin.groups]) db.move(group, undefined);
    for (const entry of [...bin.entries]) db.move(entry, undefined);
  }));
  handle('createGroup', edit((db, name, parentId) => {
    const parent = parentId ? findGroup(db, parentId) : db.getDefaultGroup();
    return db.createGroup(parent, text(name, 'name').trim() || 'New Folder').uuid.id;
  }));
  handle('renameGroup', edit((db, id, name) => {
    const group = findGroup(db, id);
    group.name = text(name, 'name').trim() || group.name;
    group.times.update();
  }));
  handle('deleteGroup', edit((db, id) => {
    const group = findGroup(db, id);
    if (group === db.getDefaultGroup() || group === recycleBin(db)) throw new Error('That folder can\'t be deleted');
    if (inTrash(db, group)) db.move(group, undefined);
    else db.remove(group);
  }));
  handle('import', (data, opts) => serial(() => importFile(data, opts)));
  handle('generate', (raw) => generatePassword((raw ?? {}) as GenerateOptions));
  handle('copy', (id, field) => serial(async () => {
    const db = openVault();
    copyField(findEntry(db, id), field as CopyField);
  }));

  // The browser's: what the toolbar shows for a page, and the autofill.
  ipcMain.handle('passwords:site-logins', (event, url: unknown) => {
    assertDesktop(event);
    const db = vault?.db;
    if (!db || typeof url !== 'string' || !isWebUrl(url)) return [];
    return loginsFor(db, url).map((entry) => summary(db, entry));
  });
  ipcMain.handle('passwords:fill-page', (event, wcId: unknown, id: unknown) => {
    assertDesktop(event);
    return fillPage(wcId, id);
  });
  ipcMain.handle('passwords:choose', (event, requestId: unknown, choice: unknown) => {
    assertDesktop(event);
    choose(requestId, choice);
  });
  ipcMain.handle('passwords:highlight', (event, requestId: unknown, highlighted: unknown) => {
    assertDesktop(event);
    if (suggestion && suggestion.requestId === requestId) {
      sendToFrame(suggestion.frame, 'passwords:shown', { visible: true, highlighted: highlighted === true });
    }
  });
  ipcMain.handle('passwords:answer-offer', (event, offerId: unknown, answer: unknown, username: unknown) => {
    assertDesktop(event);
    return answerOffer(offerId, answer, username);
  });

  // From passwords-preload.cjs, in web pages' frames.
  ipcMain.on('passwords:field', (event, raw: unknown) => void onField(event, raw));
  ipcMain.on('passwords:blur', (event) => {
    if (suggestion && sameFrame(event.senderFrame, suggestion.frame)) hideSuggestions();
  });
  // The page lost the keyboard: maybe to a click on the suggestions, which
  // only the desktop knows (getFocusedWebContents still names the page then),
  // so it decides whether they stay.
  ipcMain.on('passwords:page-blur', (event) => {
    const s = suggestion;
    if (s && sameFrame(event.senderFrame, s.frame)) options?.sendToShell('passwords:page-blur', { requestId: s.requestId });
  });
  ipcMain.on('passwords:key', (event, key: unknown) => {
    const s = suggestion;
    if (!s || !sameFrame(event.senderFrame, s.frame)) return;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Escape') {
      options?.sendToShell('passwords:key', { requestId: s.requestId, key });
    }
  });
  ipcMain.on('passwords:submitted', (event, raw: unknown) => onSubmitted(event, raw));
}

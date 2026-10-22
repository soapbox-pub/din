// Din as a remote signer (NIP-46): apps on other devices, or programs on this
// one, connect to the user's account over relays with a bunker:// or
// nostrconnect:// link, and Din signs for them.
//
// The split follows window.nostr's (registerNostrBridge in main.mts). This
// side holds each connection's own key, listens on its relays, and unwraps
// and wraps the kind 24133 envelopes. What a client asks for is relayed to the
// shell renderer, where NostrBridgeHost asks the user, signs with the
// account's signer, and says what the user wanted remembered. Connections and
// what they were allowed are kept here, on this device only
// (userData/bunker.json), since they are bound to keys that never leave it.
//
// Each connection has its own key, so the client only learns the account's
// pubkey by asking, and revoking a connection deletes the key it talks to.
// A bunker:// secret is good for one client: whoever presents it first is the
// connection's client from then on. A nostrconnect:// link names its client,
// and accepting it (which only ever happens in the shell, with the user
// looking at it) grants the permissions it lists. Replies use the encryption
// the request came in, and every request gets an answer.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, ipcMain, safeStorage } from 'electron';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool, type SubCloser } from 'nostr-tools/pool';

const KIND = 24133;

/** How long a request may wait for the user, as in Tenna. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Requests older than this when they arrive are left alone: they were for a Din that wasn't running. */
const MAX_REQUEST_AGE_S = 10 * 60;

const HEX64 = /^[0-9a-f]{64}$/;

type Decision = 'allow' | 'deny';

/** What a client may do without being asked, keyed like the shell's site grants. */
interface BunkerGrants {
  /** 'nip04.encrypt' | 'nip04.decrypt' | 'nip44.encrypt' | 'nip44.decrypt'. */
  methods: Record<string, Decision>;
  /** signEvent, per kind. */
  kinds: Record<string, Decision>;
}

interface StoredConnection {
  /** The connection's own public key (hex): what the client talks to. */
  id: string;
  /** Its secret key: `enc:` + safeStorage ciphertext (base64), or `hex:` where there's no keyring. */
  key: string;
  /** The account (hex pubkey) this connection signs for. */
  account: string;
  relays: string[];
  /** A bunker:// link's secret, until a client presents it. */
  secret: string | null;
  /** The client's pubkey, once one has connected. */
  client: string | null;
  name?: string;
  url?: string;
  image?: string;
  createdAt: number;
  lastUsed: number | null;
  grants: BunkerGrants;
}

/** What the shell sees of a connection: everything but its key. */
export interface BunkerConnectionInfo {
  id: string;
  account: string;
  relays: string[];
  client: string | null;
  name?: string;
  url?: string;
  image?: string;
  createdAt: number;
  lastUsed: number | null;
  grants: BunkerGrants;
  /** The bunker:// link, while nobody has used it. */
  uri: string | null;
}

interface RelayRequest {
  method: string;
  params: unknown;
  origin: string;
  source: 'bunker';
  wcId: null;
  userActivated: boolean;
  account: string;
  client: unknown;
}

interface Reply {
  ok: boolean;
  result?: unknown;
  error?: string;
  remember?: unknown;
}

interface Deps {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  relay: (request: RelayRequest, timeoutMs?: number) => Promise<Reply>;
}

let deps: Deps;
let connections: StoredConnection[] = [];
const secretKeys = new Map<string, Uint8Array>();
const subscriptions = new Map<string, SubCloser>();
const seen = new Set<string>();
let pool: SimplePool | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'bunker.json');
}

function sealKey(secretKey: Uint8Array): string {
  const hex = Buffer.from(secretKey).toString('hex');
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(hex).toString('base64')}`;
  }
  return `hex:${hex}`;
}

function unsealKey(sealed: string): Uint8Array | null {
  try {
    const hex = sealed.startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'))
      : sealed.startsWith('hex:')
        ? sealed.slice(4)
        : '';
    return HEX64.test(hex) ? Uint8Array.from(Buffer.from(hex, 'hex')) : null;
  } catch {
    return null;
  }
}

function isDecision(value: unknown): value is Decision {
  return value === 'allow' || value === 'deny';
}

function decisions(value: unknown): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (isDecision(v)) out[k] = v;
  }
  return out;
}

function isRelayUrl(url: unknown): url is string {
  return typeof url === 'string' && /^wss?:\/\/[^\s]+$/i.test(url);
}

function load(): void {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { connections?: unknown }).connections)
      ? (parsed as { connections: Record<string, unknown>[] }).connections
      : [];
    connections = [];
    for (const c of list) {
      if (typeof c.id !== 'string' || !HEX64.test(c.id) || typeof c.key !== 'string') continue;
      if (typeof c.account !== 'string' || !HEX64.test(c.account)) continue;
      const secretKey = unsealKey(c.key);
      if (!secretKey || getPublicKey(secretKey) !== c.id) continue;
      secretKeys.set(c.id, secretKey);
      const grants = (c.grants ?? {}) as Record<string, unknown>;
      connections.push({
        id: c.id,
        key: c.key,
        account: c.account,
        relays: Array.isArray(c.relays) ? c.relays.filter(isRelayUrl) : [],
        secret: typeof c.secret === 'string' ? c.secret : null,
        client: typeof c.client === 'string' && HEX64.test(c.client) ? c.client : null,
        name: typeof c.name === 'string' ? c.name : undefined,
        url: typeof c.url === 'string' ? c.url : undefined,
        image: typeof c.image === 'string' ? c.image : undefined,
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
        lastUsed: typeof c.lastUsed === 'number' ? c.lastUsed : null,
        grants: { methods: decisions(grants.methods), kinds: decisions(grants.kinds) },
      });
    }
  } catch {
    connections = [];
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify({ connections }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('Failed to save bunker connections:', error);
  }
  deps.sendToShell('bunker:changed', list());
}

function bunkerUri(c: StoredConnection): string | null {
  if (c.client || !c.secret) return null;
  const params = new URLSearchParams();
  for (const relay of c.relays) params.append('relay', relay);
  params.set('secret', c.secret);
  return `bunker://${c.id}?${params}`;
}

function list(): BunkerConnectionInfo[] {
  return connections.map((c) => ({
    id: c.id,
    account: c.account,
    relays: c.relays,
    client: c.client,
    name: c.name,
    url: c.url,
    image: c.image,
    createdAt: c.createdAt,
    lastUsed: c.lastUsed,
    grants: c.grants,
    uri: bunkerUri(c),
  }));
}

// --- Relays ------------------------------------------------------------------

function getPool(): SimplePool {
  pool ??= new SimplePool({ enableReconnect: true });
  return pool;
}

/** Relay AUTH is signed with the connection's key, never the account's. */
function authFor(secretKey: Uint8Array) {
  return async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secretKey);
}

function listen(c: StoredConnection): void {
  subscriptions.get(c.id)?.close();
  const secretKey = secretKeys.get(c.id);
  if (!secretKey || c.relays.length === 0) return;
  const since = Math.floor(Date.now() / 1000) - MAX_REQUEST_AGE_S;
  subscriptions.set(
    c.id,
    getPool().subscribeMany(c.relays, { kinds: [KIND], '#p': [c.id], since }, {
      onevent: (event) => void receive(c.id, event),
      onauth: authFor(secretKey),
    }),
  );
}

function stopListening(id: string): void {
  subscriptions.get(id)?.close();
  subscriptions.delete(id);
}

async function send(c: StoredConnection, to: string, message: unknown, useNip04: boolean): Promise<void> {
  const secretKey = secretKeys.get(c.id);
  if (!secretKey) return;
  const plaintext = JSON.stringify(message);
  const content = useNip04
    ? nip04.encrypt(secretKey, to, plaintext)
    : nip44.encrypt(plaintext, nip44.getConversationKey(secretKey, to));
  const event = finalizeEvent(
    { kind: KIND, content, tags: [['p', to]], created_at: Math.floor(Date.now() / 1000) },
    secretKey,
  );
  const results = await Promise.allSettled(getPool().publish(c.relays, event, { onauth: authFor(secretKey) }));
  if (!results.some((r) => r.status === 'fulfilled')) {
    console.warn(`bunker: no relay took the reply for ${c.id.slice(0, 8)}`);
  }
}

// --- Requests ----------------------------------------------------------------

/** NIP-46 method -> the window.nostr method the shell decides on, and its params. */
function toBridgeCall(method: string, params: unknown[]): { method: string; params: Record<string, unknown> } | null {
  const str = (i: number) => (typeof params[i] === 'string' ? (params[i] as string) : '');
  switch (method) {
    case 'sign_event': {
      try {
        const event: unknown = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
        return { method: 'signEvent', params: { event } };
      } catch {
        return null;
      }
    }
    case 'nip04_encrypt':
      return { method: 'nip04.encrypt', params: { pubkey: str(0), plaintext: str(1) } };
    case 'nip04_decrypt':
      return { method: 'nip04.decrypt', params: { pubkey: str(0), ciphertext: str(1) } };
    case 'nip44_encrypt':
      return { method: 'nip44.encrypt', params: { pubkey: str(0), plaintext: str(1) } };
    case 'nip44_decrypt':
      return { method: 'nip44.decrypt', params: { pubkey: str(0), ciphertext: str(1) } };
    default:
      return null;
  }
}

/** Store a decision the user asked Din to remember for this client. */
function remember(c: StoredConnection, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const { method, kind, decision } = value as { method?: unknown; kind?: unknown; decision?: unknown };
  if (!isDecision(decision) || typeof method !== 'string') return;
  if (method === 'signEvent' && typeof kind === 'number') c.grants.kinds[String(kind)] = decision;
  else if (/^nip(04|44)\.(en|de)crypt$/.test(method)) c.grants.methods[method] = decision;
}

async function answer(c: StoredConnection, from: string, method: string, params: unknown[]): Promise<Reply> {
  if (method === 'connect') {
    if (c.client === from) return { ok: true, result: 'ack' };
    if (!c.client && c.secret && params[1] === c.secret) {
      c.client = from;
      c.secret = null;
      c.lastUsed = Date.now();
      save();
      return { ok: true, result: 'ack' };
    }
    return { ok: false, error: 'Invalid secret' };
  }

  // Everything else is for the connection's client alone.
  if (c.client !== from) return { ok: false, error: 'Not connected' };
  c.lastUsed = Date.now();

  switch (method) {
    case 'ping':
      return { ok: true, result: 'pong' };
    case 'get_public_key':
      return { ok: true, result: c.account };
    case 'switch_relays':
      return { ok: true, result: null };
    case 'logout':
      forget(c.id);
      return { ok: true, result: 'ack' };
  }

  const call = toBridgeCall(method, params);
  if (!call) return { ok: false, error: `Unsupported method: ${method}` };
  const reply = await deps.relay(
    {
      ...call,
      origin: `nip46:${c.id}`,
      source: 'bunker',
      wcId: null,
      userActivated: false,
      account: c.account,
      client: { id: c.id, name: c.name, url: c.url, image: c.image, grants: c.grants },
    },
    REQUEST_TIMEOUT_MS,
  );
  // The connection may have been revoked while the user was deciding.
  if (!connections.includes(c)) return { ok: false, error: 'Disconnected' };
  remember(c, reply.remember);
  save();
  if (reply.ok && method === 'sign_event') return { ok: true, result: JSON.stringify(reply.result) };
  return reply;
}

async function receive(id: string, event: Event): Promise<void> {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  if (seen.size > 2000) seen.delete(seen.values().next().value as string);

  const c = connections.find((x) => x.id === id);
  const secretKey = secretKeys.get(id);
  if (!c || !secretKey || event.kind !== KIND || !verifyEvent(event)) return;
  if (event.created_at < Math.floor(Date.now() / 1000) - MAX_REQUEST_AGE_S) return;

  const useNip04 = event.content.includes('?iv=');
  let request: { id?: unknown; method?: unknown; params?: unknown };
  try {
    const plaintext = useNip04
      ? nip04.decrypt(secretKey, event.pubkey, event.content)
      : nip44.decrypt(event.content, nip44.getConversationKey(secretKey, event.pubkey));
    request = JSON.parse(plaintext);
  } catch {
    return;
  }
  if (typeof request.id !== 'string' || typeof request.method !== 'string') return;
  // Somebody else's client, before it has connected: don't answer strangers.
  if (request.method !== 'connect' && c.client !== event.pubkey) return;

  const params = Array.isArray(request.params) ? request.params : [];
  let reply: Reply;
  try {
    reply = await answer(c, event.pubkey, request.method, params);
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await send(
    c,
    event.pubkey,
    reply.ok
      ? { id: request.id, result: typeof reply.result === 'string' ? reply.result : JSON.stringify(reply.result) }
      : { id: request.id, result: '', error: reply.error || 'Request failed' },
    useNip04,
  );
}

// --- Managing connections ------------------------------------------------------

function newConnection(account: string, relays: string[]): StoredConnection {
  const secretKey = generateSecretKey();
  const id = getPublicKey(secretKey);
  secretKeys.set(id, secretKey);
  return {
    id,
    key: sealKey(secretKey),
    account,
    relays,
    secret: null,
    client: null,
    createdAt: Date.now(),
    lastUsed: null,
    grants: { methods: {}, kinds: {} },
  };
}

function forget(id: string): void {
  stopListening(id);
  secretKeys.delete(id);
  connections = connections.filter((c) => c.id !== id);
  save();
}

/** A nostrconnect:// link's `perms`: `sign_event:1,nip44_encrypt,...`. */
function grantsFromPerms(perms: string | null): BunkerGrants {
  const grants: BunkerGrants = { methods: {}, kinds: {} };
  for (const perm of (perms ?? '').split(',')) {
    const [method, arg] = perm.trim().split(':');
    if (method === 'sign_event' && arg && /^\d+$/.test(arg)) grants.kinds[arg] = 'allow';
    const call = /^nip(04|44)_(en|de)crypt$/.test(method) ? method.replace('_', '.') : null;
    if (call) grants.methods[call] = 'allow';
  }
  return grants;
}

/** The parts of a nostrconnect:// link Din uses, or an error saying what's wrong with it. */
export function parseNostrConnect(uri: string): {
  client: string;
  relays: string[];
  secret: string;
  perms: string | null;
  name?: string;
  url?: string;
  image?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri.trim());
  } catch {
    throw new Error('That is not a nostrconnect:// link');
  }
  if (parsed.protocol !== 'nostrconnect:') throw new Error('That is not a nostrconnect:// link');
  const client = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!HEX64.test(client)) throw new Error('The link does not name an app key');
  const relays = parsed.searchParams.getAll('relay').filter(isRelayUrl);
  if (relays.length === 0) throw new Error('The link has no relays');
  const secret = parsed.searchParams.get('secret');
  if (!secret) throw new Error('The link has no secret');

  let name = parsed.searchParams.get('name') ?? undefined;
  let url = parsed.searchParams.get('url') ?? undefined;
  let image = parsed.searchParams.get('image') ?? undefined;
  // The older form some clients (rust-nostr, ngit) still send.
  const metadata = parsed.searchParams.get('metadata');
  if (metadata) {
    try {
      const m = JSON.parse(metadata) as Record<string, unknown>;
      if (!name && typeof m.name === 'string') name = m.name;
      if (!url && typeof m.url === 'string') url = m.url;
      if (!image && typeof m.icons === 'object' && Array.isArray(m.icons) && typeof m.icons[0] === 'string') image = m.icons[0];
    } catch {
      // Ignore a malformed metadata blob; the link still works.
    }
  }
  const safeUrl = (value: string | undefined) => (value && /^https:\/\//i.test(value) ? value.slice(0, 2000) : undefined);
  return {
    client,
    relays,
    secret,
    perms: parsed.searchParams.get('perms'),
    name: name?.slice(0, 100),
    url: safeUrl(url),
    image: safeUrl(image),
  };
}

function assertAccount(account: unknown): string {
  if (typeof account !== 'string' || !HEX64.test(account)) throw new Error('Invalid account');
  return account;
}

export function registerBunkerHandlers(d: Deps): void {
  deps = d;
  let loaded = false;
  const ensureLoaded = () => {
    if (loaded) return;
    loaded = true;
    load();
    for (const c of connections) listen(c);
  };
  // safeStorage needs the app to be ready, which it is by now.
  ensureLoaded();

  ipcMain.handle('bunker:list', (event) => {
    deps.assertShellSender(event);
    return list();
  });

  // A bunker:// link for any app to connect with, once.
  ipcMain.handle('bunker:create', (event, payload: { account?: unknown; relays?: unknown }) => {
    deps.assertShellSender(event);
    const account = assertAccount(payload?.account);
    const relays = Array.isArray(payload?.relays) ? [...new Set(payload.relays.filter(isRelayUrl))] : [];
    if (relays.length === 0) throw new Error('No relays to listen on');
    const c = newConnection(account, relays);
    c.secret = randomBytes(16).toString('hex');
    connections.push(c);
    save();
    listen(c);
    return list().find((x) => x.id === c.id);
  });

  // An app's nostrconnect:// link, which the user has looked at and accepted.
  ipcMain.handle('bunker:accept', async (event, payload: { account?: unknown; uri?: unknown }) => {
    deps.assertShellSender(event);
    const account = assertAccount(payload?.account);
    const link = parseNostrConnect(typeof payload?.uri === 'string' ? payload.uri : '');
    const c = newConnection(account, link.relays);
    c.client = link.client;
    c.name = link.name;
    c.url = link.url;
    c.image = link.image;
    c.grants = grantsFromPerms(link.perms);
    c.lastUsed = Date.now();
    connections.push(c);
    save();
    listen(c);
    // Tell the app it's connected: its own secret, from the connection's key.
    await send(c, link.client, { id: randomBytes(8).toString('hex'), result: link.secret }, false);
    return list().find((x) => x.id === c.id);
  });

  ipcMain.handle('bunker:parse', (event, uri: unknown) => {
    deps.assertShellSender(event);
    const link = parseNostrConnect(typeof uri === 'string' ? uri : '');
    return { ...link, secret: undefined, grants: grantsFromPerms(link.perms) };
  });

  ipcMain.handle('bunker:remove', (event, id: unknown) => {
    deps.assertShellSender(event);
    if (typeof id === 'string') forget(id);
  });

  // Settings can take a permission away (decision null) but grant none.
  ipcMain.handle('bunker:revoke', (event, payload: { id?: unknown; method?: unknown; kind?: unknown }) => {
    deps.assertShellSender(event);
    const c = connections.find((x) => x.id === payload?.id);
    if (!c) return;
    if (payload.method === 'signEvent' && typeof payload.kind === 'number') delete c.grants.kinds[String(payload.kind)];
    else if (typeof payload.method === 'string') delete c.grants.methods[payload.method];
    save();
  });
}

// Passkeys for web pages: Din is the authenticator, and Passwords keeps them.
//
// Chromium on Linux has no authenticator of its own (it makes one only on
// macOS and ChromeOS), and Electron draws none of the UI a security key's
// PIN or a phone needs, so a page's navigator.credentials.create() or get()
// waits minutes for nothing. Instead passkeys-preload.cjs gives pages a
// navigator.credentials whose public-key requests come here: the desktop
// asks the user, below the browser's toolbar (PasskeyPrompt.tsx), and the
// passkey is made, or signs, here, with its key kept in the Passwords vault
// as KeePassXC keeps one (passkeyVault in passwords.mts).
//
// A page never says where it is: its origin is the requesting frame's as
// main knows it, the client data it signs is built here from that, and the
// relying party it names has to be that origin's host or a registrable
// domain above it, as the WebAuthn spec and Chromium require. A frame from
// another site than its page gets Chromium's own WebAuthn, as does a request
// for a security key; the prompt's "Use a Security Key" hands a request back
// to it too.
//
// The user's click in the prompt is the user's presence; Din reports the
// user as verified as well, the vault being one they unlocked with their
// password (or their login, which did the same). Passkeys are "backed up"
// (BE and BS), as the vault is a file that can be synced or copied anywhere.
//
// Attestation is always "none". Passkeys are ES256 unless the site takes
// only EdDSA or RS256, which KeePassXC makes and uses too.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { ipcMain } from 'electron';
import type { WebContents, WebFrameMain } from 'electron';
import { parse as parseHost } from 'tldts-experimental';
import { passkeyVault, type StoredPasskey } from './passwords.mts';

/** Din's AAGUID: which authenticator made a passkey, for sites that show it. */
const AAGUID = Buffer.from('d1a0c5e2b6f84a3c9e7d5b2f1c8a4e60', 'hex');
const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;
const SUPPORTED_ALGORITHMS = [ES256, EDDSA, RS256];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

/** How long a request may wait on the user, whatever the page asks for. */
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_CHALLENGE = 1024;
const MAX_CREDENTIALS = 64;
const MAX_NAME = 256;

// ---------------------------------------------------------------------------
// CBOR, as much as an attestation object and a COSE key need (CTAP2's
// canonical form: maps are written in the order given, which is the
// canonical one for every map here).
// ---------------------------------------------------------------------------

type Cbor = number | string | Uint8Array | CborMap;

class CborMap {
  entries: [Cbor, Cbor][];
  constructor(entries: [Cbor, Cbor][]) {
    this.entries = entries;
  }
}

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  return Buffer.concat([cborHead(5, value.entries.length), ...value.entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function jwkBytes(key: KeyObject, name: 'x' | 'y' | 'n' | 'e'): Buffer {
  const value = key.export({ format: 'jwk' })[name];
  if (typeof value !== 'string') throw new Error('Not a usable key');
  return Buffer.from(value, 'base64url');
}

interface NewKey {
  privateKeyPem: string;
  /** The public key as COSE, for the attested credential data. */
  cose: Buffer;
  /** The public key as SPKI DER, for getPublicKey(). */
  spki: Buffer;
}

function makeKey(alg: number): NewKey {
  let pair: { publicKey: KeyObject; privateKey: KeyObject };
  let cose: CborMap;
  if (alg === EDDSA) {
    pair = generateKeyPairSync('ed25519');
    cose = new CborMap([[1, 1], [3, EDDSA], [-1, 6], [-2, jwkBytes(pair.publicKey, 'x')]]);
  } else if (alg === RS256) {
    pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
    cose = new CborMap([[1, 3], [3, RS256], [-1, jwkBytes(pair.publicKey, 'n')], [-2, jwkBytes(pair.publicKey, 'e')]]);
  } else {
    pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    cose = new CborMap([[1, 2], [3, ES256], [-1, 1], [-2, jwkBytes(pair.publicKey, 'x')], [-3, jwkBytes(pair.publicKey, 'y')]]);
  }
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cose: cbor(cose),
    spki: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
}

/** A WebAuthn signature: DER for ECDSA, PKCS#1 v1.5 for RSA, plain for Ed25519. */
function signWith(privateKeyPem: string, data: Buffer): Buffer {
  const key = createPrivateKey(privateKeyPem);
  return key.asymmetricKeyType === 'ed25519' ? sign(null, data, key) : sign('sha256', data, key);
}

function authenticatorData(rpId: string, flags: number, attested?: Buffer): Buffer {
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4), ...(attested ? [attested] : [])]);
}

function flagsOf(passkey: Pick<StoredPasskey, 'backupEligible' | 'backedUp'>): number {
  return FLAG_UP | FLAG_UV | (passkey.backupEligible ? FLAG_BE : 0) | (passkey.backedUp ? FLAG_BS : 0);
}

// ---------------------------------------------------------------------------
// Pages' requests
// ---------------------------------------------------------------------------

/** What the page gets back: a credential, an error to throw, or "ask Chromium". */
type PageResult =
  | { credential: Record<string, unknown> }
  | { error: { name: string; message: string } }
  | { native: true };

class RequestError extends Error {
  type: string;
  constructor(type: string, message: string) {
    super(message);
    this.type = type;
  }
}

const notAllowed = () => ({ error: { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' } });

interface CreateOptions {
  challenge: Buffer;
  rpId: string;
  rpName: string;
  userId: Buffer;
  userName: string;
  displayName: string;
  alg: number;
  exclude: Set<string>;
  credProps: boolean;
}

interface GetOptions {
  challenge: Buffer;
  rpId: string;
  allow: Set<string>;
}

type Parsed = ({ kind: 'create' } & CreateOptions) | ({ kind: 'get' } & GetOptions);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function bytes(value: unknown, what: string, max: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new RequestError('TypeError', `${what} is not a BufferSource`);
  const out = Buffer.from(value, 'base64url');
  if (out.length > max) throw new RequestError('TypeError', `${what} is too long`);
  return out;
}

function name(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').trim().slice(0, MAX_NAME) : '';
}

function credentialIds(value: unknown): Set<string> {
  const list = Array.isArray(value) ? value.slice(0, MAX_CREDENTIALS) : [];
  const ids = new Set<string>();
  for (const raw of list) {
    const c = record(raw);
    if (c.type === 'public-key') ids.add(b64(bytes(c.id, 'A credential ID', 1023)));
  }
  return ids;
}

function timeoutOf(value: unknown): number {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, ms));
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * The relying party a page may name: its own host, or a domain above it
 * that's registrable (not a public suffix like co.uk or github.io).
 */
function relyingParty(requested: unknown, host: string): string {
  if (requested === undefined || requested === null) return host;
  if (typeof requested !== 'string') throw new RequestError('TypeError', 'rp.id is not a string');
  const rpId = requested.toLowerCase();
  if (rpId === host) return rpId;
  if (!host.endsWith(`.${rpId}`)) throw new RequestError('SecurityError', 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.');
  const { domain, isIp } = parseHost(rpId, { allowPrivateDomains: true });
  if (isIp || !domain || (rpId !== domain && !rpId.endsWith(`.${domain}`))) {
    throw new RequestError('SecurityError', 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.');
  }
  return rpId;
}

function parseCreate(raw: unknown, host: string): ({ kind: 'create' } & CreateOptions) | 'native' {
  const r = record(raw);
  const selection = record(r.authenticatorSelection);
  // A security key, by name: Chromium's.
  if (selection.authenticatorAttachment === 'cross-platform') return 'native';
  const rp = record(r.rp);
  const user = record(r.user);
  const userId = bytes(user.id, 'user.id', 64);
  if (userId.length === 0) throw new RequestError('TypeError', 'user.id is empty');
  const challenge = bytes(r.challenge, 'challenge', MAX_CHALLENGE);
  const params = Array.isArray(r.pubKeyCredParams) ? r.pubKeyCredParams.slice(0, 32).map(record) : [];
  // None given means the defaults, ES256 then RS256.
  const algs = params.length === 0 ? [ES256, RS256] : params.filter((p) => p.type === 'public-key').map((p) => Number(p.alg));
  const alg = algs.find((a) => SUPPORTED_ALGORITHMS.includes(a));
  if (alg === undefined) throw new RequestError('NotSupportedError', 'None of the requested algorithms are supported.');
  return {
    kind: 'create',
    challenge,
    rpId: relyingParty(rp.id, host),
    rpName: name(rp.name),
    userId,
    userName: name(user.name),
    displayName: name(user.displayName),
    alg,
    exclude: credentialIds(r.excludeCredentials),
    credProps: record(r.extensions).credProps === true,
  };
}

function parseGet(raw: unknown, host: string): { kind: 'get' } & GetOptions {
  const r = record(raw);
  return {
    kind: 'get',
    challenge: bytes(r.challenge, 'challenge', MAX_CHALLENGE),
    rpId: relyingParty(r.rpId, host),
    allow: credentialIds(r.allowCredentials),
  };
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: Buffer, origin: string): Buffer {
  // Chromium's order, which some sites' parsers expect.
  return Buffer.from(JSON.stringify({ type, challenge: b64(challenge), origin, crossOrigin: false }));
}

// ---------------------------------------------------------------------------
// Waiting on the user
// ---------------------------------------------------------------------------

/** What the desktop shows for a request (src/lib/passkeys.ts mirrors this). */
export interface PasskeyRequestView {
  requestId: number;
  wcId: number;
  kind: 'create' | 'get';
  /** The relying party: the site the passkey is for. */
  site: string;
  /** What the site calls itself, when making one. */
  rpName: string;
  /** The account a new passkey is for. */
  username: string;
  vault: 'open' | 'locked' | 'missing';
  /** Signing in: the vault's passkeys the site may use. */
  accounts: { id: string; username: string; title: string }[];
  /** Making one: the vault already has one of the site's for this account (it asked not to make another). */
  excluded: boolean;
  /** Making one: it replaces the vault's passkey for this account. */
  replaces: boolean;
}

/** What the user chose. */
export type PasskeyAnswer =
  | { type: 'create' }
  | { type: 'get'; id: string }
  | { type: 'security-key' }
  | { type: 'cancel' };

interface Pending {
  id: number;
  /** passkeys-preload's own name for it, to cancel it by. */
  token: string;
  contents: WebContents;
  frame: WebFrameMain;
  origin: string;
  request: Parsed;
  view: PasskeyRequestView | null;
  settle: (result: PageResult) => void;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
}

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  isBridgeEvent: (event: Electron.IpcMainInvokeEvent) => boolean;
  sendToShell: (channel: string, payload: unknown) => void;
  /** Web pages that get passkeys: tabs (private ones too) and installed web apps. */
  isPasskeyGuest: (contents: WebContents) => boolean;
}

let options: Options | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;
const watched = new WeakSet<WebContents>();

function sameFrame(a: WebFrameMain, b: WebFrameMain): boolean {
  return a.processId === b.processId && a.routingId === b.routingId;
}

function finish(p: Pending, result: PageResult): void {
  if (!pending.has(p.id)) return;
  pending.delete(p.id);
  clearTimeout(p.timer);
  options?.sendToShell('passkeys:gone', { requestId: p.id });
  p.settle(result);
}

function watch(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const drop = () => {
    for (const p of [...pending.values()]) if (p.contents === contents) finish(p, notAllowed());
  };
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) drop();
  });
  contents.once('destroyed', drop);
}

async function viewOf(p: Pending): Promise<PasskeyRequestView> {
  const vault = await passkeyVault.status();
  const passkeys = vault === 'open' ? ((await passkeyVault.find(p.request.rpId)) ?? []) : [];
  const r = p.request;
  const view: PasskeyRequestView = {
    requestId: p.id,
    wcId: p.contents.id,
    kind: r.kind,
    site: r.rpId,
    rpName: r.kind === 'create' ? r.rpName : '',
    username: r.kind === 'create' ? r.userName || r.displayName : '',
    vault,
    accounts: [],
    excluded: false,
    replaces: false,
  };
  if (r.kind === 'get') {
    view.accounts = passkeys
      .filter((k) => r.allow.size === 0 || r.allow.has(k.credentialId))
      .map((k) => ({ id: k.credentialId, username: k.username, title: k.title }));
  } else {
    view.excluded = passkeys.some((k) => r.exclude.has(k.credentialId));
    view.replaces = passkeys.some((k) => k.userHandle === b64(r.userId));
  }
  return view;
}

async function show(p: Pending): Promise<void> {
  const view = await viewOf(p);
  if (!pending.has(p.id)) return;
  p.view = view;
  options?.sendToShell('passkeys:request', view);
}

async function create(p: Pending, r: CreateOptions): Promise<PageResult> {
  const known = (await passkeyVault.find(r.rpId)) ?? [];
  if (known.some((k) => r.exclude.has(k.credentialId))) {
    return { error: { name: 'InvalidStateError', message: 'The authenticator was previously registered.' } };
  }
  const key = makeKey(r.alg);
  const credentialId = randomBytes(32);
  const flags = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT;
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length);
  const authData = authenticatorData(r.rpId, flags, Buffer.concat([AAGUID, length, credentialId, key.cose]));
  const attestationObject = cbor(new CborMap([['fmt', 'none'], ['attStmt', new CborMap([])], ['authData', authData]]));
  await passkeyVault.store({
    rpId: r.rpId,
    rpName: r.rpName,
    origin: p.origin,
    username: r.userName || r.displayName,
    credentialId: b64(credentialId),
    userHandle: b64(r.userId),
    privateKeyPem: key.privateKeyPem,
  });
  return {
    credential: {
      id: b64(credentialId),
      response: {
        clientDataJSON: b64(clientData('webauthn.create', r.challenge, p.origin)),
        attestationObject: b64(attestationObject),
        authenticatorData: b64(authData),
        publicKey: b64(key.spki),
        publicKeyAlgorithm: r.alg,
        transports: ['hybrid', 'internal'],
      },
      clientExtensionResults: r.credProps ? { credProps: { rk: true } } : {},
    },
  };
}

async function signIn(p: Pending, r: GetOptions, id: string): Promise<PageResult> {
  const passkey = ((await passkeyVault.find(r.rpId)) ?? []).find((k) => k.credentialId === id);
  if (!passkey || (r.allow.size > 0 && !r.allow.has(id))) return notAllowed();
  const authData = authenticatorData(r.rpId, flagsOf(passkey));
  const data = clientData('webauthn.get', r.challenge, p.origin);
  const signature = signWith(passkey.privateKeyPem, Buffer.concat([authData, sha256(data)]));
  return {
    credential: {
      id,
      response: {
        clientDataJSON: b64(data),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: passkey.userHandle || null,
      },
      clientExtensionResults: {},
    },
  };
}

async function answer(requestId: unknown, raw: unknown): Promise<void> {
  const p = typeof requestId === 'number' ? pending.get(requestId) : undefined;
  if (!p || p.busy) return;
  const choice = record(raw) as PasskeyAnswer;
  // The page may have gone elsewhere since it asked.
  if (p.frame.detached || p.contents.isDestroyed() || p.frame.origin !== p.origin) return finish(p, notAllowed());
  if (choice.type === 'security-key') return finish(p, { native: true });
  if (choice.type === 'cancel') {
    // Told it has one already, the user went along: the site hears it's registered.
    if (p.request.kind === 'create' && p.view?.excluded) {
      return finish(p, { error: { name: 'InvalidStateError', message: 'The authenticator was previously registered.' } });
    }
    return finish(p, notAllowed());
  }
  p.busy = true;
  try {
    if (choice.type === 'create' && p.request.kind === 'create') finish(p, await create(p, p.request));
    else if (choice.type === 'get' && p.request.kind === 'get' && typeof choice.id === 'string') finish(p, await signIn(p, p.request, choice.id));
  } catch (error) {
    console.warn('[passkeys]', error);
    finish(p, notAllowed());
  } finally {
    p.busy = false;
  }
}

/** A request from a page's frame, checked and shown to the user; resolves with what the page gets. */
function request(event: Electron.IpcMainInvokeEvent, kind: 'create' | 'get', token: unknown, raw: unknown): Promise<PageResult> | PageResult {
  const contents = event.sender;
  const frame = event.senderFrame;
  if (!frame || !options || contents.isDestroyed() || !options.isPasskeyGuest(contents)) return notAllowed();
  if (typeof token !== 'string' || token.length > 64) return notAllowed();
  const origin = frame.origin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return notAllowed();
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(host))) {
    return { error: { name: 'SecurityError', message: 'Public-key credentials are only available to HTTPS origins.' } };
  }
  // A frame from another site: Chromium's, with its permissions policy.
  if (frame.origin !== contents.mainFrame.origin) return { native: true };
  let parsed: Parsed;
  try {
    const result = kind === 'create' ? parseCreate(raw, host) : parseGet(raw, host);
    if (result === 'native') return { native: true };
    parsed = result;
  } catch (error) {
    if (error instanceof RequestError) return { error: { name: error.type, message: error.message } };
    throw error;
  }
  // One at a time in a tab: a new one replaces the last.
  for (const p of [...pending.values()]) if (p.contents === contents) finish(p, notAllowed());
  watch(contents);
  return new Promise<PageResult>((settle) => {
    const id = nextId++;
    const p: Pending = {
      id,
      token,
      contents,
      frame,
      origin,
      request: parsed,
      view: null,
      settle,
      timer: setTimeout(() => finish(p, notAllowed()), timeoutOf(record(raw).timeout)),
      busy: false,
    };
    pending.set(id, p);
    void show(p).catch((error: unknown) => {
      console.warn('[passkeys] showing a request:', error);
      finish(p, notAllowed());
    });
  });
}

export function registerPasskeyHandlers(opts: Options): void {
  options = opts;
  const assertDesktop = (event: Electron.IpcMainInvokeEvent) => {
    opts.assertShellSender(event);
    if (opts.isBridgeEvent(event)) throw new Error('Not for apps');
  };

  // From passkeys-preload.cjs, in web pages' frames.
  ipcMain.handle('passkeys:create', (event, token: unknown, raw: unknown) => request(event, 'create', token, raw));
  ipcMain.handle('passkeys:get', (event, token: unknown, raw: unknown) => request(event, 'get', token, raw));
  // The page gave up on it (its AbortSignal).
  ipcMain.on('passkeys:cancel', (event, token: unknown) => {
    const frame = event.senderFrame;
    if (!frame) return;
    for (const p of [...pending.values()]) {
      if (p.token === token && sameFrame(p.frame, frame)) finish(p, { error: { name: 'AbortError', message: 'The operation was aborted.' } });
    }
  });

  // The desktop's.
  ipcMain.handle('passkeys:answer', (event, requestId: unknown, choice: unknown) => {
    assertDesktop(event);
    return answer(requestId, choice);
  });
  // The desktop (re)loaded: what's still waiting.
  ipcMain.handle('passkeys:pending', (event) => {
    assertDesktop(event);
    return [...pending.values()].flatMap((p) => (p.view ? [p.view] : []));
  });

  // Unlocking the vault (or a passkey arriving from another app) changes what's offered.
  passkeyVault.onChanged(() => {
    for (const p of pending.values()) {
      if (!p.busy) void show(p).catch(() => {});
    }
  });
}

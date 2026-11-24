// Sealing: how Din keeps its secrets on disk (Mail's account passwords, the
// bunker's keys, phone pairings, stream keys, Passwords' vault key).
//
// On DinOS they're sealed with a key from dindaemon (os/dindaemon.py), which
// runs as its own user and gives the key to Din's main process alone, so
// nothing else running as `din` can open them. Elsewhere, or while dindaemon
// can't be reached, it's Electron's safeStorage, the login keyring, which any
// program of the user's can ask for its key; and with no keyring, plain.
//
// A sealed value says what sealed it: `din:` (AES-256-GCM with dindaemon's
// key; base64 of IV, tag and ciphertext), `enc:` (safeStorage) or `plain:`
// (base64). needsReseal tells a stored value from what sealing now would do
// better, so each kind of secret moves up when it's next loaded.
//
// The key is asked for once, at startup (startSealing, which main.mts awaits
// before anything reads a secret), and kept in this process's memory, which
// nothing else `din` runs can read (DinOS's ptrace scope, and Electron's
// inspector fuse in os/packages.nix).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import net from 'node:net';
import { safeStorage } from 'electron';

const SOCKET = process.env.DIN_DINDAEMON_SOCKET;
/** dindaemon starts with the system, before Din; a while for it, at boot. */
const WAIT_MS = 10_000;
const RETRY_MS = 250;
const ASK_TIMEOUT_MS = 2_000;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let key: Buffer | null = null;
let ready: Promise<void> | null = null;

/** One question to dindaemon: the key, or why not. */
function askKey(socketPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(ASK_TIMEOUT_MS, () => fail(new Error('dindaemon didn’t answer')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write('{"method":"key"}\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 4096) return fail(new Error('dindaemon’s answer is too long'));
      const end = data.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      try {
        const reply = JSON.parse(data.slice(0, end)) as { key?: unknown; error?: unknown };
        const bytes = typeof reply.key === 'string' ? Buffer.from(reply.key, 'base64') : null;
        if (bytes?.length === KEY_BYTES) return resolve(bytes);
        reject(new Error(typeof reply.error === 'string' ? `dindaemon: ${reply.error}` : 'dindaemon gave no key'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('end', () => fail(new Error('dindaemon hung up')));
  });
}

/** Get dindaemon's key, where there is one. Resolves either way. */
export function startSealing(): Promise<void> {
  ready ??= (async () => {
    if (!SOCKET) return;
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try {
        key = await askKey(SOCKET);
        return;
      } catch (error) {
        // Refused is final: only Din's main process is answered.
        const refused = error instanceof Error && error.message.startsWith('dindaemon: ');
        if (refused || Date.now() > deadline) {
          console.warn('[sealing] no key from dindaemon; secrets are sealed with the login keyring for now:', error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  })();
  return ready;
}

/** What a value sealed now would be sealed with. */
export function sealingMethod(): 'dindaemon' | 'keyring' | 'plain' {
  if (key) return 'dindaemon';
  return safeStorage.isEncryptionAvailable() ? 'keyring' : 'plain';
}

const RANK = { 'din:': 2, 'enc:': 1, 'plain:': 0 } as const;

function rankOf(sealed: string): number | null {
  for (const [prefix, rank] of Object.entries(RANK)) if (sealed.startsWith(prefix)) return rank;
  return null;
}

export function seal(secret: string): string {
  if (key) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `din:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
  }
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(secret).toString('base64')}`;
  return `plain:${Buffer.from(secret, 'utf8').toString('base64')}`;
}

/** The secret in a sealed value. Throws when it can't be opened. */
export function unseal(sealed: string): string {
  if (sealed.startsWith('din:')) {
    if (!key) throw new Error('It was saved with dindaemon’s key, which Din can’t get right now');
    const data = Buffer.from(sealed.slice(4), 'base64');
    if (data.length < IV_BYTES + TAG_BYTES) throw new Error('It’s damaged');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new Error('It was saved with a key that’s gone', { cause: error });
    }
  }
  if (sealed.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'));
    } catch (error) {
      // Chromium writes a new keyring key when it can't read the old one, which is then gone.
      throw new Error('It was saved with a login keyring key that’s gone', { cause: error });
    }
  }
  if (sealed.startsWith('plain:')) return Buffer.from(sealed.slice(6), 'base64').toString('utf8');
  throw new Error('It’s in a form Din doesn’t know');
}

/** Whether sealing this value again now would keep it better. */
export function needsReseal(sealed: string): boolean {
  const rank = rankOf(sealed);
  const method = sealingMethod();
  return rank !== null && rank < (method === 'dindaemon' ? RANK['din:'] : method === 'keyring' ? RANK['enc:'] : RANK['plain:']);
}

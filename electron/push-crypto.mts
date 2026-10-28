// The cryptography of Web Push, for web-push.mts: a subscription's keys, and
// decrypting what a site's server sent to it.
//
// Messages come encrypted to the subscription's P-256 key and authentication
// secret (RFC 8291), as `aes128gcm` (RFC 8188), or as the older `aesgcm`
// draft some servers still send, whose salt and sender key come in headers
// the push service passes along. Firefox's PushCrypto.sys.mjs is the model.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';

/** A subscription's own keys, as stored (base64url). */
export interface SubscriptionKeys {
  /** The uncompressed P-256 public key the site encrypts to (65 bytes). */
  p256dh: string;
  /** Its private half (32 bytes). */
  privateKey: string;
  /** The authentication secret (16 bytes). */
  auth: string;
}

/** The encryption headers a push service passes along with a message. */
export interface PushHeaders {
  encoding?: string;
  encryption?: string;
  crypto_key?: string;
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/** Decodes base64url (padding and the standard alphabet allowed); null if it isn't. */
export function fromBase64url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(text)) return null;
  return Buffer.from(text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
}

export function generateSubscriptionKeys(): SubscriptionKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: base64url(ecdh.getPublicKey()),
    privateKey: base64url(ecdh.getPrivateKey()),
    auth: base64url(crypto.randomBytes(16)),
  };
}

/** Whether `key` is an uncompressed P-256 point, as an applicationServerKey must be. */
export function isServerKey(key: Uint8Array): boolean {
  if (key.length !== 65 || key[0] !== 0x04) return false;
  try {
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: base64url(key.subarray(1, 33)), y: base64url(key.subarray(33)) },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

export class PushDecryptError extends Error {}

const AES128GCM_AUTH_INFO = Buffer.from('WebPush: info\0');
const AES128GCM_KEY_INFO = Buffer.from('Content-Encoding: aes128gcm\0');
const AES128GCM_NONCE_INFO = Buffer.from('Content-Encoding: nonce\0');
const AESGCM_AUTH_INFO = Buffer.from('Content-Encoding: auth\0');
const AESGCM_KEY_INFO = Buffer.from('Content-Encoding: aesgcm\0');
const AESGCM_NONCE_INFO = Buffer.from('Content-Encoding: nonce\0');
const P256DH_INFO = Buffer.from('P-256\0');
const TAG_LENGTH = 16;

function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

function sharedSecret(keys: SubscriptionKeys, senderKey: Uint8Array): Buffer {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
  try {
    return ecdh.computeSecret(senderKey);
  } catch {
    throw new PushDecryptError('Invalid sender key');
  }
}

/** The nonce for record `index`: the base with the index XORed into its low 48 bits. */
function recordNonce(base: Buffer, index: number): Buffer {
  const nonce = Buffer.from(base);
  for (let i = 0; i < 6; i++) nonce[nonce.length - 1 - i] ^= Math.floor(index / 256 ** i) & 0xff;
  return nonce;
}

function decryptRecord(key: Buffer, nonce: Buffer, record: Buffer): Buffer {
  if (record.length < TAG_LENGTH) throw new PushDecryptError('Truncated record');
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - TAG_LENGTH));
  try {
    return Buffer.concat([decipher.update(record.subarray(0, record.length - TAG_LENGTH)), decipher.final()]);
  } catch {
    throw new PushDecryptError('Bad encryption');
  }
}

function records(ciphertext: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < ciphertext.length; at += size) out.push(ciphertext.subarray(at, at + size));
  return out;
}

function decryptAes128gcm(keys: SubscriptionKeys, payload: Buffer): Buffer {
  // salt (16) | rs (4) | idlen (1) | keyid (idlen): the sender's public key.
  if (payload.length < 21) throw new PushDecryptError('Truncated header');
  const salt = payload.subarray(0, 16);
  const rs = payload.readUInt32BE(16);
  const idLength = payload[20];
  if (rs < 18) throw new PushDecryptError('Record size too small');
  if (idLength !== 65) throw new PushDecryptError('Invalid sender key');
  if (payload.length <= 21 + idLength) throw new PushDecryptError('Truncated payload');
  const senderKey = payload.subarray(21, 21 + idLength);
  const ciphertext = payload.subarray(21 + idLength);

  const ikm = sharedSecret(keys, senderKey);
  const receiverKey = Buffer.from(keys.p256dh, 'base64url');
  const prk = hkdf(
    Buffer.from(keys.auth, 'base64url'),
    ikm,
    Buffer.concat([AES128GCM_AUTH_INFO, receiverKey, senderKey]),
    32,
  );
  const key = hkdf(salt, prk, AES128GCM_KEY_INFO, 16);
  const nonce = hkdf(salt, prk, AES128GCM_NONCE_INFO, 12);

  const chunks = records(ciphertext, rs);
  return Buffer.concat(
    chunks.map((record, index) => {
      const plain = decryptRecord(key, recordNonce(nonce, index), record);
      // Content, then a delimiter (2 on the last record, 1 before), then zeros.
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      if (end < 0 || plain[end] !== (index === chunks.length - 1 ? 2 : 1)) {
        throw new PushDecryptError('Bad padding');
      }
      return plain.subarray(0, end);
    }),
  );
}

/** One `a=b;c="d"` entry of a header's list, as parameters. */
function headerParams(entry: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of entry.split(';')) {
    const at = part.indexOf('=');
    if (at >= 0) params[part.slice(0, at).trim()] = part.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return params;
}

/** The `dh` of the Crypto-Key entry with `keyid`, or of the first with one. */
function cryptoKeyDh(value: string, keyid: string | undefined): string | null {
  let first: string | null = null;
  for (const entry of value.split(',')) {
    const params = headerParams(entry);
    if (!params.dh) continue;
    if (keyid && params.keyid === keyid) return params.dh;
    first ??= params.dh;
  }
  return first;
}

function decryptAesgcm(keys: SubscriptionKeys, headers: PushHeaders, payload: Buffer): Buffer {
  if (!headers.encryption) throw new PushDecryptError('Missing Encryption header');
  if (!headers.crypto_key) throw new PushDecryptError('Missing Crypto-Key header');
  const params = headerParams(headers.encryption.split(',', 1)[0]);
  const dh = cryptoKeyDh(headers.crypto_key, params.keyid);
  const senderKey = dh ? fromBase64url(dh) : null;
  if (!senderKey || senderKey.length !== 65) throw new PushDecryptError('Invalid sender key');
  const salt = params.salt ? fromBase64url(params.salt) : null;
  if (!salt || salt.length !== 16) throw new PushDecryptError('Invalid salt');
  const rs = params.rs ? Number(params.rs) : 4096;
  if (!Number.isInteger(rs) || rs < 2) throw new PushDecryptError('Invalid record size');
  // Records here don't count their tag, and can't end on a record boundary.
  const size = rs + TAG_LENGTH;
  if (payload.length % size === 0) throw new PushDecryptError('Truncated payload');

  const ikm = sharedSecret(keys, senderKey);
  const receiverKey = Buffer.from(keys.p256dh, 'base64url');
  const prk = hkdf(Buffer.from(keys.auth, 'base64url'), ikm, AESGCM_AUTH_INFO, 32);
  const context = Buffer.concat([
    P256DH_INFO,
    Buffer.from([0, receiverKey.length]),
    receiverKey,
    Buffer.from([0, senderKey.length]),
    senderKey,
  ]);
  const key = hkdf(salt, prk, Buffer.concat([AESGCM_KEY_INFO, context]), 16);
  const nonce = hkdf(salt, prk, Buffer.concat([AESGCM_NONCE_INFO, context]), 12);

  return Buffer.concat(
    records(payload, size).map((record, index) => {
      const plain = decryptRecord(key, recordNonce(nonce, index), record);
      // A two-byte padding length, that many zeros, then content.
      if (plain.length < 2) throw new PushDecryptError('Bad padding');
      const pad = plain.readUInt16BE(0);
      if (pad > plain.length - 2) throw new PushDecryptError('Bad padding');
      for (let i = 2; i < 2 + pad; i++) if (plain[i] !== 0) throw new PushDecryptError('Bad padding');
      return plain.subarray(2 + pad);
    }),
  );
}

/**
 * A message's plaintext, or null when it carried none. Throws
 * PushDecryptError when it can't be read.
 */
export function decryptPushMessage(keys: SubscriptionKeys, headers: PushHeaders | null, payload: Buffer | null): Buffer | null {
  if (!payload || payload.length === 0) return null;
  const encoding = headers?.encoding;
  if (encoding === 'aes128gcm') return decryptAes128gcm(keys, payload);
  if (encoding === 'aesgcm') return decryptAesgcm(keys, headers ?? {}, payload);
  throw new PushDecryptError(`Unsupported encoding: ${encoding ?? '(none)'}`);
}

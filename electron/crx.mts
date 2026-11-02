// Chrome extension packages (.crx, version 3): what NIP-82 publishes an
// extension as (`application/x-chrome-extension`).
//
// A CRX3 is "Cr24", the version (3), a protobuf header holding signatures
// and the extension's id, then a zip of the extension's files. The id is
// the first 16 bytes of the SHA-256 of a signing key's SubjectPublicKeyInfo,
// each hex digit spelled a-p, so whoever holds that key decides which
// extension it is. Din reads them (checking every signature, and that one is
// by the key the id names) and writes them, signed with ECDSA P-256 as
// Chrome's own packer can.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';

const MAGIC = 'Cr24';
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');

export class CrxError extends Error {}

interface KeyProof {
  publicKey: Buffer;
  signature: Buffer;
  algorithm: 'rsa' | 'ecdsa';
}

// ---------------------------------------------------------------------------
// The little protobuf CRX3 needs
// ---------------------------------------------------------------------------

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

/** Length-delimited fields, in order. */
function encode(fields: [number, Buffer][]): Buffer {
  return Buffer.concat(fields.flatMap(([field, data]) => [varint(field * 8 + 2), varint(data.length), data]));
}

/** A message's length-delimited fields; other wire types are skipped. */
function decode(data: Buffer): [number, Buffer][] {
  const fields: [number, Buffer][] = [];
  let at = 0;
  const read = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= data.length) throw new CrxError('The extension’s package is damaged.');
      const byte = data[at++];
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 128;
      if (scale > 2 ** 49) throw new CrxError('The extension’s package is damaged.');
    }
  };
  while (at < data.length) {
    const key = read();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) read();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = read();
      if (at + length > data.length) throw new CrxError('The extension’s package is damaged.');
      fields.push([field, data.subarray(at, at + length)]);
      at += length;
    } else throw new CrxError('The extension’s package is damaged.');
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Hex spelled the way Chrome spells extension ids, 0-f as a-p. */
function idAlphabet(hex: string): string {
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

function idBytes(publicKey: Buffer): Buffer {
  return crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
}

/** The extension id a public key (DER SubjectPublicKeyInfo) makes. */
export function extensionIdOf(publicKey: Buffer): string {
  return idAlphabet(idBytes(publicKey).toString('hex'));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ParsedCrx {
  /** The extension's id, from the key that signed it as itself. */
  id: string;
  /** That key, as base64 DER, which is what manifest.json's `key` holds. */
  key: string;
  /** The extension's files, by path. */
  files: Map<string, Uint8Array>;
}

/** Read a CRX3, checking every signature and that one is by the key its id names. */
export function readCrx(data: Uint8Array): ParsedCrx {
  const crx = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== MAGIC) throw new CrxError('That isn’t a Chrome extension package.');
  if (crx.readUInt32LE(4) !== 3) throw new CrxError('Only version 3 extension packages can be installed.');
  const headerLength = crx.readUInt32LE(8);
  if (12 + headerLength > crx.length) throw new CrxError('The extension’s package is damaged.');
  const header = crx.subarray(12, 12 + headerLength);
  const archive = crx.subarray(12 + headerLength);

  const proofs: KeyProof[] = [];
  let signedData: Buffer | null = null;
  for (const [field, value] of decode(header)) {
    if (field === 2 || field === 3) {
      const proof = decode(value);
      const publicKey = proof.find(([f]) => f === 1)?.[1];
      const signature = proof.find(([f]) => f === 2)?.[1];
      if (publicKey && signature) proofs.push({ publicKey, signature, algorithm: field === 2 ? 'rsa' : 'ecdsa' });
    } else if (field === 10000) signedData = value;
  }
  const crxId = signedData && decode(signedData).find(([f]) => f === 1)?.[1];
  if (!signedData || !crxId || crxId.length !== 16 || !proofs.length) throw new CrxError('The extension’s package isn’t signed.');

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  const message = Buffer.concat([SIGNED_DATA_PREFIX, length, signedData, archive]);
  for (const proof of proofs) {
    let ok: boolean;
    try {
      const key = crypto.createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
      ok = crypto.verify('sha256', message, key, proof.signature);
    } catch {
      ok = false;
    }
    if (!ok) throw new CrxError('The extension’s package has a signature that doesn’t match it.');
  }
  const own = proofs.find((proof) => idBytes(proof.publicKey).equals(crxId));
  if (!own) throw new CrxError('The extension’s package isn’t signed by the key its id comes from.');

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(archive));
  } catch {
    throw new CrxError('The extension’s package is damaged.');
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(entries)) if (!name.endsWith('/')) files.set(name, bytes);
  return { id: extensionIdOf(own.publicKey), key: own.publicKey.toString('base64'), files };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A new signing key, as PKCS#8 PEM. Each extension Din signs has its own, since the key is its id. */
export function newSigningKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

/** The extension id a signing key (PKCS#8 PEM) makes. */
export function extensionIdOfKey(pem: string): string {
  const publicKey = crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' });
  return extensionIdOf(publicKey);
}

/** A CRX3 of `files`, signed with `pem` (an EC or RSA private key). */
export function writeCrx(files: Map<string, Uint8Array>, pem: string): Buffer {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const archive = Buffer.from(zipSync(Object.fromEntries(files), { level: 9 }));
  const signedData = encode([[1, idBytes(publicKey)]]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  const signature = crypto.sign('sha256', Buffer.concat([SIGNED_DATA_PREFIX, length, signedData, archive]), privateKey);
  const proof = encode([[1, publicKey], [2, signature]]);
  const header = encode([[privateKey.asymmetricKeyType === 'rsa' ? 2 : 3, proof], [10000, signedData]]);
  const prelude = Buffer.alloc(12);
  prelude.write(MAGIC, 0, 'latin1');
  prelude.writeUInt32LE(3, 4);
  prelude.writeUInt32LE(header.length, 8);
  return Buffer.concat([prelude, header, archive]);
}

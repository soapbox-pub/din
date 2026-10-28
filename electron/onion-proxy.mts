// The browser's Tor session's way into Tor: a SOCKS5 proxy in front of Tor's
// own that makes plain-http onion sites https origins.
//
// Tor Browser treats http://….onion as a secure context, since an onion
// address authenticates the service and Tor encrypts the connection to it.
// Chromium doesn't, so those pages lose crypto.randomUUID, crypto.subtle,
// service workers and the rest (Ditto's onion address, for one, opens its
// relays and never sends a REQ). Chromium can't be told otherwise without
// patching it, so Din gives such a page an https origin instead:
//
//   - tor.mts sends http://x.onion requests to https://x.onion, and marks
//     the host plain (markPlainOnionHost).
//   - Chromium asks this proxy for x.onion:443. For a plain host, this proxy
//     answers the TLS itself, with a key made at launch that never leaves
//     this process, and passes what's inside to x.onion:80 through Tor. The
//     site sees the same plain HTTP it always did. A site with TLS of its own
//     redirects that plain visit to https, and from then on its connections
//     go to its 443 untouched (markTlsOnionHost).
//   - The Tor session accepts that certificate for .onion hosts and nothing
//     else (isOnionProxyCertificate).
//
// Everything else is passed to Tor as it came. Tor names the hosts, so
// nothing is resolved outside it, as before.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/** How long Tor gets to answer a connection request (onion services can be slow to reach). */
const CONNECT_TIMEOUT_MS = 120_000;

/** SOCKS5 reply codes this proxy makes itself. */
const REPLY_OK = 0;
const REPLY_FAILURE = 1;
const REPLY_COMMAND_NOT_SUPPORTED = 7;

let torPort = 9050;
let server: Promise<number> | null = null;

/** How each onion host was last reached on 443: its own TLS, or plain HTTP behind ours. */
const onionModes = new Map<string, 'tls' | 'plain'>();

function isOnionHost(host: string): boolean {
  return /(^|\.)[a-z2-7]{56}\.onion$/i.test(host);
}

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let length: Buffer;
  if (body.length < 0x80) length = Buffer.from([body.length]);
  else if (body.length < 0x100) length = Buffer.from([0x81, body.length]);
  else length = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts: Buffer[]) => der(0x30, ...parts);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

interface Certificate {
  context: tls.SecureContext;
  /** As Electron gives it: "sha256/" and the base64 of the DER's SHA-256. */
  fingerprint: string;
}

/** A self-signed ECDSA certificate for *.onion, made fresh for this run. */
function makeCertificate(): Certificate {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('Din onion service', 'utf8')))));
  const serial = crypto.randomBytes(16);
  // Positive, and with no leading zero byte, which DER forbids.
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const now = Date.now();
  const altNames = seq(der(0x82, Buffer.from('*.onion', 'ascii')));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaWithSha256,
    name,
    seq(utcTime(new Date(now - 24 * 60 * 60_000)), utcTime(new Date(now + 365 * 24 * 60 * 60_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(seq(oid('2.5.29.17'), der(0x04, altNames)))),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certificate = seq(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  return {
    context: tls.createSecureContext({ key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem }),
    fingerprint: `sha256/${crypto.createHash('sha256').update(certificate).digest('base64')}`,
  };
}

let certificate: Certificate | null = null;

/** Whether a certificate Chromium was shown for a host is this proxy's own, for an onion host. */
export function isOnionProxyCertificate(hostname: string, fingerprint: string): boolean {
  return certificate !== null && fingerprint === certificate.fingerprint && isOnionHost(hostname);
}

/** Whether an onion host is served as plain HTTP behind this proxy's TLS (as far as is known yet). */
export function isPlainOnionHost(hostname: string): boolean {
  return onionModes.get(hostname.toLowerCase()) === 'plain';
}

/** Open connections to plain onion hosts, by host, for when one turns out to have TLS. */
const plainConnections = new Map<string, Set<net.Socket>>();

/**
 * An http:// address for this onion host was sent to https://: serve it as
 * plain HTTP, unless it's known to have TLS of its own.
 */
export function markPlainOnionHost(hostname: string): void {
  const key = hostname.toLowerCase();
  if (!onionModes.has(key)) onionModes.set(key, 'plain');
}

/**
 * This onion host sent its plain-HTTP visitor to https:// on itself, as a
 * site with TLS of its own does (Facebook's): reach it on 443 from now on.
 * Its plain connections close, so the redirect isn't fetched over them.
 */
export function markTlsOnionHost(hostname: string): void {
  const key = hostname.toLowerCase();
  onionModes.set(key, 'tls');
  for (const socket of plainConnections.get(key) ?? []) socket.destroy();
  plainConnections.delete(key);
}

// ---------------------------------------------------------------------------
// SOCKS5
// ---------------------------------------------------------------------------

/** Reads exact byte counts off a socket, until released to be piped. */
function reader(socket: net.Socket) {
  let buffered = Buffer.alloc(0);
  let waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  let closed = false;
  const pump = () => {
    if (!waiting) return;
    if (buffered.length >= waiting.n) {
      const out = buffered.subarray(0, waiting.n);
      buffered = buffered.subarray(waiting.n);
      const w = waiting;
      waiting = null;
      w.resolve(out);
    } else if (closed) {
      const w = waiting;
      waiting = null;
      w.reject(new Error('Connection closed'));
    }
  };
  const onData = (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    pump();
  };
  const onClose = () => {
    closed = true;
    pump();
  };
  socket.on('data', onData);
  socket.on('end', onClose);
  socket.on('close', onClose);
  socket.on('error', onClose);
  return {
    read: (n: number) =>
      new Promise<Buffer>((resolve, reject) => {
        waiting = { n, resolve, reject };
        pump();
      }),
    /** Stop reading, and give back anything read past the last request. */
    release: () => {
      socket.pause();
      socket.off('data', onData);
      socket.off('end', onClose);
      socket.off('close', onClose);
      socket.off('error', onClose);
      if (buffered.length > 0) socket.unshift(buffered);
    },
  };
}

/** A SOCKS5 request's destination: [host, port]. */
async function readAddress(read: (n: number) => Promise<Buffer>, type: number): Promise<[string, number]> {
  let host: string;
  if (type === 1) host = [...(await read(4))].join('.');
  else if (type === 3) host = (await read((await read(1))[0])).toString('latin1');
  else if (type === 4) host = (await read(16)).toString('hex').replace(/(.{4})(?!$)/g, '$1:');
  else throw new Error('Unknown address type');
  return [host, (await read(2)).readUInt16BE(0)];
}

interface Upstream {
  reply: number;
  socket: net.Socket | null;
}

/** Ask Tor for a connection to host:port. */
async function connectThroughTor(host: string, port: number): Promise<Upstream> {
  const socket = net.connect({ host: '127.0.0.1', port: torPort });
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
  const { read, release } = reader(socket);
  try {
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await read(2);
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error('Tor wants authentication');
    const name = Buffer.from(host, 'latin1');
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]));
    const [version, reply, , type] = await read(4);
    if (version !== 5) throw new Error('Not SOCKS5');
    await readAddress(read, type);
    release();
    socket.setTimeout(0);
    if (reply !== REPLY_OK) {
      socket.destroy();
      return { reply, socket: null };
    }
    return { reply, socket };
  } catch {
    socket.destroy();
    return { reply: REPLY_FAILURE, socket: null };
  }
}

function answer(client: net.Socket, reply: number): void {
  client.write(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function join(a: net.Socket | tls.TLSSocket, b: net.Socket): void {
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', close);
  b.on('error', close);
  a.on('close', close);
  b.on('close', close);
  a.pipe(b);
  b.pipe(a);
  a.resume();
  b.resume();
}

/** Tor's reply for a port the onion service doesn't serve. */
const REPLY_REFUSED = 5;
/** Waits before asking again for port 80, after a refused 443 took the service's circuit down. */
const PLAIN_RETRY_MS = [1_000, 2_000, 4_000, 8_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect an onion host's 443: its own TLS, or its 80 behind ours. Hosts
 * whose http:// addresses were upgraded (markPlainOnionHost) go straight to
 * 80. Asking for a port a service doesn't serve makes it close the whole
 * circuit, and an immediate retry on 80 fails, so 443 is only tried for a
 * host Din knows nothing about (an https:// address typed, or a tab
 * restored), and 80 after it only once Tor has rebuilt the way there.
 */
async function connectOnion443(host: string): Promise<{ upstream: Upstream; plain: boolean }> {
  const key = host.toLowerCase();
  const mode = onionModes.get(key);
  if (mode === 'plain') {
    const upstream = await connectThroughTor(host, 80);
    return { upstream, plain: upstream.socket !== null };
  }
  const upstream = await connectThroughTor(host, 443);
  if (upstream.socket || mode === 'tls' || upstream.reply !== REPLY_REFUSED) {
    if (upstream.socket) onionModes.set(key, 'tls');
    return { upstream, plain: false };
  }
  let plain = upstream;
  for (const wait of PLAIN_RETRY_MS) {
    await sleep(wait);
    plain = await connectThroughTor(host, 80);
    if (plain.socket) {
      onionModes.set(key, 'plain');
      return { upstream: plain, plain: true };
    }
  }
  return { upstream: plain, plain: false };
}

async function serve(client: net.Socket): Promise<void> {
  client.on('error', () => client.destroy());
  const { read, release } = reader(client);
  try {
    const [version, methods] = await read(2);
    if (version !== 5) throw new Error('Not SOCKS5');
    if (!(await read(methods)).includes(0)) {
      client.end(Buffer.from([5, 0xff]));
      return;
    }
    client.write(Buffer.from([5, 0]));
    const [, command, , type] = await read(4);
    const [host, port] = await readAddress(read, type);
    if (command !== 1) {
      answer(client, REPLY_COMMAND_NOT_SUPPORTED);
      client.end();
      return;
    }
    const { upstream, plain } =
      port === 443 && isOnionHost(host)
        ? await connectOnion443(host)
        : { upstream: await connectThroughTor(host, port), plain: false };
    if (client.destroyed) {
      upstream.socket?.destroy();
      return;
    }
    answer(client, upstream.reply);
    if (!upstream.socket) {
      client.end();
      return;
    }
    release();
    if (plain && certificate) {
      // HTTP/1.1 only: what's inside goes to a plain HTTP server as it is.
      const secure = new tls.TLSSocket(client, {
        isServer: true,
        secureContext: certificate.context,
        ALPNProtocols: ['http/1.1'],
      });
      const socket = upstream.socket;
      join(secure, socket);
      const key = host.toLowerCase();
      const open = plainConnections.get(key) ?? new Set<net.Socket>();
      plainConnections.set(key, open);
      open.add(socket);
      socket.once('close', () => {
        open.delete(socket);
        if (open.size === 0 && plainConnections.get(key) === open) plainConnections.delete(key);
      });
    } else {
      join(client, upstream.socket);
    }
  } catch {
    client.destroy();
  }
}

/** Point the proxy at Tor's SOCKS port. */
export function setOnionProxyTorPort(port: number): void {
  if (port === torPort) return;
  torPort = port;
  onionModes.clear();
}

/** Start the proxy (once), and resolve to the loopback port it listens on. */
export function startOnionProxy(): Promise<number> {
  server ??= new Promise<number>((resolve, reject) => {
    certificate ??= makeCertificate();
    const listener = net.createServer((client) => void serve(client));
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = listener.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('No port'));
    });
  });
  return server;
}

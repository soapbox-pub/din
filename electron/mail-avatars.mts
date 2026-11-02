// Senders' pictures for Mail, looked up in main so a message never loads
// anything itself (a picture fetched as it's read would tell its sender
// when). Only for senders the account's server vouched for (DKIM passed
// for the From domain), so mail claiming to be from a bank can't borrow
// its logo; the app asks only for those. Two places are asked, both on the
// sender's own domain:
//
//   - NIP-05: example.com/.well-known/nostr.json?name=alex names a Nostr
//     key for alex@example.com, and that profile's picture (kind 0, signed,
//     from the relays the domain names and Din's defaults) is used.
//   - BIMI: a TXT record at default._bimi.example.com names the brand's
//     logo, an SVG (what Gmail shows for companies).
//
// Requests carry no cookies, go only to public addresses, and come from
// main whenever the list first shows a sender, not when a message opens.
// What's found (pictures shrunk to 96px, data: URLs) and what isn't are
// kept in userData/mail/avatars.json for weeks. Gravatar is never asked:
// it would learn every address the user corresponds with.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import { app, nativeImage } from 'electron';
import { SimplePool } from 'nostr-tools/pool';
import { isPublicAddress, LOCAL_NAMES, publicLookup } from './mail-lists.mts';

const FOUND_MS = 30 * 86_400_000;
const MISSING_MS = 7 * 86_400_000;
const PICTURE_BYTES = 3 * 1024 * 1024;
const SVG_BYTES = 64 * 1024;
const JSON_BYTES = 256 * 1024;
const SIZE = 96;
const RELAYS = ['wss://relay.ditto.pub', 'wss://relay.primal.net', 'wss://relay.damus.io'];
const AT_ONCE = 3;

interface Entry {
  at: number;
  image: string | null;
}

interface Saved {
  enabled: boolean;
  /** By address, and by `bimi:` + domain and `nip05:` + domain for what a whole domain lacks. */
  cache: Record<string, Entry>;
}

let saved: Saved | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'mail', 'avatars.json');
}

function data(): Saved {
  if (saved) return saved;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Saved>;
    saved = { enabled: raw.enabled !== false, cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : {} };
  } catch {
    saved = { enabled: true, cache: {} };
  }
  return saved;
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data()), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }, 1000);
  saveTimer.unref();
}

function cached(key: string): Entry | undefined {
  const e = data().cache[key];
  if (!e) return undefined;
  return Date.now() - e.at < (e.image ? FOUND_MS : MISSING_MS) ? e : undefined;
}

function keep(key: string, image: string | null): string | null {
  data().cache[key] = { at: Date.now(), image };
  save();
  return image;
}

export function avatarLookups(): boolean {
  return data().enabled;
}

export function setAvatarLookups(on: boolean): void {
  data().enabled = on;
  if (!on) data().cache = {};
  save();
}

/** An https URL on a public host, or null. */
function publicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.:]+$/.test(host) ? !isPublicAddress(host) : !host.includes('.') || LOCAL_NAMES.test(host)) return null;
  return url;
}

/** GET a public https URL, following a few redirects, up to `max` bytes. */
function get(raw: string, max: number, redirects = 3): Promise<{ type: string; body: Buffer }> {
  const url = publicUrl(raw);
  if (!url) return Promise.reject(new Error('Not a public https address'));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: publicLookup, timeout: 10_000, headers: { 'User-Agent': 'Din Mail', Accept: 'image/*, application/json' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        get(new URL(response.headers.location, url).href, max, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) request.destroy(new Error('Too big'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ type: String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Timed out')));
    request.on('error', reject);
  });
}

/** A picture, shrunk, as a PNG data: URL; null when it isn't one. */
async function picture(raw: string): Promise<string | null> {
  const { body } = await get(raw, PICTURE_BYTES);
  const image = nativeImage.createFromBuffer(body);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  return `data:image/png;base64,${square.resize({ width: SIZE, height: SIZE, quality: 'good' }).toPNG().toString('base64')}`;
}

let pool: SimplePool | null = null;

async function nip05Picture(local: string, domain: string): Promise<string | null> {
  if (!/^[a-z0-9._-]+$/.test(local) || cached(`nip05:${domain}`)) return null;
  let doc: { names?: Record<string, unknown>; relays?: Record<string, unknown> };
  try {
    const { body } = await get(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`, JSON_BYTES, 0);
    doc = JSON.parse(body.toString('utf8')) as typeof doc;
  } catch {
    // The domain doesn't do NIP-05: no need to ask it for anyone else for a while.
    keep(`nip05:${domain}`, null);
    return null;
  }
  const pubkey = doc.names?.[local];
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
  const named = doc.relays?.[pubkey];
  const relays = [...new Set([...(Array.isArray(named) ? named.filter((r): r is string => typeof r === 'string' && r.startsWith('wss://')).slice(0, 3) : []), ...RELAYS])];
  pool ??= new SimplePool();
  // The pool checks each event's signature, so a relay can't swap the picture.
  const event = await pool.get(relays, { kinds: [0], authors: [pubkey], limit: 1 }, { maxWait: 5000 }).catch(() => null);
  if (!event) return null;
  let url: unknown;
  try {
    url = (JSON.parse(event.content) as { picture?: unknown }).picture;
  } catch {
    return null;
  }
  return typeof url === 'string' ? picture(url).catch(() => null) : null;
}

async function bimiLogo(domain: string): Promise<string | null> {
  const labels = domain.split('.');
  // The sender's domain, then the one it's under (mail.stripe.com → stripe.com).
  const domains = [...new Set([domain, labels.slice(-2).join('.')])];
  for (const d of domains) {
    const hit = cached(`bimi:${d}`);
    if (hit) return hit.image;
    let record: string | undefined;
    try {
      record = (await dns.resolveTxt(`default._bimi.${d}`)).map((parts) => parts.join('')).find((r) => /^v=BIMI1\b/i.test(r));
    } catch {
      record = undefined;
    }
    const logo = record && /(?:^|;)\s*l=([^;\s]+)/i.exec(record)?.[1];
    if (!logo) {
      keep(`bimi:${d}`, null);
      continue;
    }
    try {
      const { type, body } = await get(logo, SVG_BYTES);
      // Shown in an <img>, where an SVG's scripts don't run and it loads nothing.
      const svg = type === 'image/svg+xml' || /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(body.toString('utf8', 0, 200));
      return keep(`bimi:${d}`, svg ? `data:image/svg+xml;base64,${body.toString('base64')}` : null);
    } catch {
      return keep(`bimi:${d}`, null);
    }
  }
  return null;
}

const running = new Map<string, Promise<string | null>>();
const waiting: (() => void)[] = [];
let active = 0;

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** A sender's picture as a data: URL, or null: from what's kept, else looked up (once at a time per address). */
export function avatar(address: string): Promise<string | null> {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (!data().enabled || at < 1 || a.length > 320) return Promise.resolve(null);
  const hit = cached(a);
  if (hit) return Promise.resolve(hit.image);
  const busy = running.get(a);
  if (busy) return busy;
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return Promise.resolve(null);
  const job = slot(async () => {
    const image = (await nip05Picture(local, domain).catch(() => null)) ?? (await bimiLogo(domain).catch(() => null));
    return keep(a, image);
  }).finally(() => running.delete(a));
  running.set(a, job);
  return job;
}

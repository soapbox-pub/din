// Mailing lists, for Mail's Subscriptions (electron/mail.mts): what a
// message's List-Unsubscribe headers say (RFC 2369, RFC 8058), and leaving
// a list by its one-click link.
//
// The links come from mail, which anyone can send, so the one-click POST is
// made only to https on port 443 at a host whose every address is public
// (checked as the connection is made, so a name can't be pointed elsewhere
// in between), with no cookies, and its redirects aren't followed. A
// crafted message can't make Din reach the user's own network.
//
// Whether a sender is who it says comes from the Authentication-Results
// header the account's server added on top (RFC 8601): DKIM passed for the
// From domain, or one of its subdomains or parents. A server that adds
// none leaves a sender's own forged one on top, so it's a hint for asking
// the user, never the only safeguard.

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { MailAddress, UnsubscribeMethod } from '../src/lib/mail.ts';
import type { ListHeader } from './mail-store.mts';

/** The headers fetched to tell a list's mail, as IMAP names them. */
export const LIST_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'authentication-results'];

/** A header block's fields, lowercased, each with its values in order. */
export function headerFields(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    out.set(key, [...(out.get(key) ?? []), line.slice(colon + 1).trim()]);
  }
  return out;
}

function domainOf(address: string): string {
  return address.split('@').pop()?.toLowerCase() ?? '';
}

function aligned(signer: string, domain: string): boolean {
  const d = signer.toLowerCase().replace(/\.$/, '');
  return !!d && !!domain && (d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`));
}

/** Whether the topmost Authentication-Results says DKIM passed for this domain. */
export function dkimPassed(results: string | undefined, domain: string): boolean {
  if (!results) return false;
  return results
    .split(';')
    .slice(1)
    .some((part) => {
      if (!/^\s*dkim\s*=\s*pass\b/i.test(part)) return false;
      const d = /\bheader\.d\s*=\s*"?([^\s;"]+)/i.exec(part)?.[1] ?? /\bheader\.i\s*=\s*"?[^\s;"@]*@([^\s;"]+)/i.exec(part)?.[1];
      return !!d && aligned(d, domain);
    });
}

/**
 * Whether the account's server vouched for the From domain: in the
 * Authentication-Results its server put on top (the first of them, and any
 * more from the same server before the next Received line, as some servers
 * write one per check), DKIM passed aligned with the domain, or DMARC
 * passed for it. `raw` is the message's Authentication-Results and
 * Received headers, in their order; ones further down could be anyone's.
 */
export function senderVouched(raw: string, domain: string): boolean {
  if (!domain) return false;
  let server: string | null = null;
  const results: string[] = [];
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'received') {
      if (server !== null) break;
      continue;
    }
    if (key !== 'authentication-results') continue;
    const id = value.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
    if (server === null) server = id;
    else if (id !== server) break;
    results.push(value);
  }
  return results.some(
    (r) =>
      dkimPassed(r, domain) ||
      r
        .split(';')
        .slice(1)
        .some((part) => /^\s*dmarc\s*=\s*pass\b/i.test(part) && aligned(/\bheader\.from\s*=\s*"?([^\s;"]+)/i.exec(part)?.[1] ?? '', domain)),
  );
}

/** What a message's list headers say, or null when it doesn't say how to leave. */
export function listHeader(fields: Map<string, string[]>, from: MailAddress | undefined, date: number): ListHeader | null {
  const value = fields.get('list-unsubscribe')?.[0];
  if (!value) return null;
  const bracketed = [...value.matchAll(/<([^>]*)>/g)].map((m) => m[1]);
  const urls = (bracketed.length ? bracketed : value.split(','))
    .map((u) => u.replace(/\s+/g, ''))
    .filter((u) => u.length <= 4000 && /^(https?|mailto):/i.test(u))
    .slice(0, 4);
  if (!urls.length) return null;
  const rawId = fields.get('list-id')?.[0];
  const listId = rawId ? (/<([^>]+)>/.exec(rawId)?.[1] ?? rawId).trim().toLowerCase().slice(0, 255) || null : null;
  const address = (from?.address ?? '').toLowerCase();
  return {
    date,
    name: from?.name ?? '',
    address,
    listId,
    urls,
    oneClick: /List-Unsubscribe\s*=\s*One-Click/i.test(fields.get('list-unsubscribe-post')?.[0] ?? ''),
    verified: dkimPassed(fields.get('authentication-results')?.[0], domainOf(address)),
  };
}

/** Which list a message belongs to: its List-Id, else its sender. */
export function listKey(h: ListHeader): string {
  return h.listId ? `list:${h.listId}` : `from:${h.address}`;
}

export function httpsLink(h: ListHeader): string | null {
  return h.urls.find((u) => /^https:/i.test(u)) ?? null;
}

export function mailtoLink(h: ListHeader): string | null {
  return h.urls.find((u) => /^mailto:/i.test(u)) ?? null;
}

/** A page the user can finish on: https first. */
export function webLink(h: ListHeader): string | null {
  return httpsLink(h) ?? h.urls.find((u) => /^http:/i.test(u)) ?? null;
}

/** The best way a list offers to leave it. */
export function methodOf(h: ListHeader): UnsubscribeMethod {
  if (h.oneClick && httpsLink(h)) return 'one-click';
  if (mailtoLink(h)) return 'email';
  return 'web';
}

const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  // IPv4 mapped into IPv6 (BlockList would also match plain IPv4 against a rule for these).
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const family = net.isIP(ip);
  if (!family) return false;
  return !PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export const LOCAL_NAMES = /(^|\.)(localhost|local|lan|home|internal|intranet|corp|home\.arpa|localdomain)$/i;

/** An https link Din may POST to, or why not. */
export function checkLink(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The unsubscribe link isn’t a web address.');
  }
  if (url.protocol !== 'https:') throw new Error('The unsubscribe link isn’t https.');
  if (url.username || url.password) throw new Error('The unsubscribe link carries a password.');
  if (url.port && url.port !== '443') throw new Error('The unsubscribe link uses an unusual port.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('The unsubscribe link points inside your network.');
  } else if (!host.includes('.') || LOCAL_NAMES.test(host)) {
    throw new Error('The unsubscribe link points inside your network.');
  }
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup that only answers with public addresses, and fails if any isn't. */
export function publicLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('The unsubscribe link points inside your network.'), { code: 'EPRIVATE' }), '');
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

/** RFC 8058's one click: POST List-Unsubscribe=One-Click to the list's https link. */
export function postOneClick(raw: string): Promise<void> {
  const url = checkLink(raw);
  const body = 'List-Unsubscribe=One-Click';
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'POST',
        lookup: publicLookup,
        timeout: 15_000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Din Mail',
        },
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        // A redirect is how some lists say thanks; it isn't followed.
        if (status >= 200 && status < 400) resolve();
        else reject(new Error(`The sender’s server answered ${status}.`));
      },
    );
    request.on('timeout', () => request.destroy(new Error('The sender’s server didn’t answer in time.')));
    request.on('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EPRIVATE' ? error : new Error(error.code === 'ENOTFOUND' ? 'The sender’s server couldn’t be found.' : error.message)),
    );
    request.end(body);
  });
}

/** Who to write to and what to say, from a list's mailto: link. */
export function parseUnsubscribeMailto(raw: string): { to: string; subject: string; body: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The unsubscribe address isn’t valid.');
  }
  let to = '';
  try {
    to = decodeURIComponent(url.pathname).split(',')[0].trim();
  } catch {
    // Left empty: refused by the caller.
  }
  const param = (name: string) => {
    for (const [k, v] of url.searchParams) if (k.toLowerCase() === name) return v.replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    return '';
  };
  return { to, subject: param('subject') || 'Unsubscribe', body: param('body') || 'Unsubscribe' };
}

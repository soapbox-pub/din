// napp.push: the relay subscriptions installed nsites keep open through Din
// (see napp.mts and Tenna's NAPP.md). Din's main process never stops while
// the desktop is up, so it holds the sockets itself, the way Tenna's Android
// foreground service does:
//
//   - every relay any site names gets one connection, shared by all sites
//   - each subscription becomes one REQ on each of its relays; relays match
//   - `since` on every filter is raised to when the site subscribed, and then
//     to the newest event delivered, so a reconnection doesn't replay history
//   - except by two days on filters that can match gift wraps (kind 1059),
//     whose created_at NIP-59 backdates by up to that much: relays hold live
//     events to `since` too, so without the margin they'd send almost none.
//     What a REQ turns up before EOSE that is older than `since` is history,
//     not news, and isn't delivered
//   - events are signature-checked and deduplicated per site, then handed to
//     `deliver` (the site's service worker)
//   - dropped connections come back with backoff, and at once when the
//     computer wakes or the network returns
//
// Connections, relay replies (CLOSED, NOTICE, AUTH) and deliveries go to the
// system log through `log`, and `status()` is the whole picture at once (napp.mts
// writes it to a file).
//
// No NIP-42: the pool holds no keys, so a relay that wants AUTH for a filter
// (gift wraps, typically) never serves it.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';

export const MAX_SUBSCRIPTIONS = 10;
const MAX_FILTERS = 10;
const MAX_RELAYS = 10;
const MAX_LIST = 500;
/** Ids remembered per site, to deliver each event once. */
const SEEN_LIMIT = 2_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** How far back NIP-59 lets a gift wrap's created_at be set, in seconds. */
const GIFT_WRAP_BACKDATE = 2 * 86_400;

function matchesGiftWraps(filter: NostrFilter): boolean {
  return !Array.isArray(filter.kinds) || filter.kinds.includes(1059);
}

export type NostrFilter = Record<string, unknown>;

export interface NappSubscription {
  filters: NostrFilter[];
  relays: string[];
}

/** A site's subscriptions as stored. */
export interface SitePush {
  subscriptions: NappSubscription[];
  /** Unix seconds: nothing older than this is asked for. */
  since: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  if (value.length > MAX_LIST) throw new Error(`${what} has more than ${MAX_LIST} entries`);
  return value;
}

/** A filter keeping only what relays index; throws on anything else. */
function normalizeFilter(raw: unknown): NostrFilter {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A filter must be an object');
  const filter: NostrFilter = {};
  let narrowed = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'limit') continue;
    if (key === 'ids' || key === 'authors') {
      const values = list(value, key);
      if (!values.every((v) => typeof v === 'string' && HEX64.test(v))) throw new Error(`${key} must be hex ids`);
      filter[key] = [...new Set(values)];
      narrowed = true;
    } else if (key === 'kinds') {
      const values = list(value, key);
      if (!values.every((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 65535)) {
        throw new Error('kinds must be integers');
      }
      filter.kinds = [...new Set(values)];
      narrowed = true;
    } else if (key === 'since' || key === 'until') {
      if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${key} must be a timestamp`);
      filter[key] = value;
    } else if (key === 'search') {
      if (typeof value !== 'string' || value.length > 1024) throw new Error('search must be a string');
      filter.search = value;
      narrowed = true;
    } else if (/^#[A-Za-z]$/.test(key)) {
      const values = list(value, key);
      if (!values.every((v) => typeof v === 'string' && v.length <= 1024)) throw new Error(`${key} must be strings`);
      filter[key] = [...new Set(values)];
      narrowed = true;
    } else {
      throw new Error(`Filters may not contain "${key}"`);
    }
  }
  if (!narrowed) throw new Error('A filter must name ids, authors, kinds, a tag or search');
  return filter;
}

function normalizeRelay(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Relays must be URLs');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${raw} is not a relay URL`);
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error(`${raw} is not a relay URL`);
  if (url.username || url.password) throw new Error(`${raw} is not a relay URL`);
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

/** A site's subscriptions, normalized; throws with the reason they're refused. */
export function normalizeSubscriptions(raw: unknown): NappSubscription[] {
  if (!Array.isArray(raw)) throw new Error('Subscriptions must be an array');
  if (raw.length > MAX_SUBSCRIPTIONS) throw new Error(`At most ${MAX_SUBSCRIPTIONS} subscriptions`);
  return raw.map((sub) => {
    if (!sub || typeof sub !== 'object') throw new Error('A subscription must be an object');
    const { filters, relays } = sub as Record<string, unknown>;
    if (!Array.isArray(filters) || filters.length === 0) throw new Error('A subscription needs filters');
    if (filters.length > MAX_FILTERS) throw new Error(`At most ${MAX_FILTERS} filters per subscription`);
    if (!Array.isArray(relays) || relays.length === 0) throw new Error('A subscription needs relays');
    const normalized = [...new Set(relays.map(normalizeRelay))];
    if (normalized.length > MAX_RELAYS) throw new Error(`At most ${MAX_RELAYS} relays per subscription`);
    return { filters: filters.map(normalizeFilter), relays: normalized };
  });
}

function isEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    HEX64.test(e.id) &&
    typeof e.pubkey === 'string' &&
    typeof e.sig === 'string' &&
    Number.isInteger(e.kind) &&
    Number.isInteger(e.created_at) &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags)
  );
}

interface Wanted {
  site: string;
  filters: NostrFilter[];
}

/** What a relay last said about one subscription (for diagnosis). */
export interface SubStatus {
  site: string;
  /** The `since` the last REQ carried, Unix seconds. */
  since: number | null;
  sentAt: number | null;
  eose: boolean;
  /** The relay's CLOSED reason, if it ended the subscription. */
  closed: string | null;
  events: number;
}

/** A relay connection as diagnosis sees it. Times are Unix ms. */
export interface RelayStatus {
  url: string;
  open: boolean;
  connectedAt: number | null;
  disconnectedAt: number | null;
  /** Connection attempts that failed since the last success. */
  failures: number;
  retryAt: number | null;
  notice: string | null;
  /** The relay sent an AUTH challenge (which the pool never answers). */
  authChallenged: boolean;
  subs: Record<string, SubStatus>;
}

function short(text: unknown, max = 200): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class Relay {
  readonly url: string;
  /** subscription id -> what it asks for. */
  readonly subs = new Map<string, Wanted>();
  #socket: WebSocket | null = null;
  #open = false;
  #backoff = BACKOFF_MIN_MS;
  #retry: NodeJS.Timeout | null = null;
  #closed = false;
  readonly #pool: PushPool;
  readonly #status: Omit<RelayStatus, 'url' | 'open' | 'subs'> = {
    connectedAt: null,
    disconnectedAt: null,
    failures: 0,
    retryAt: null,
    notice: null,
    authChallenged: false,
  };
  readonly #subStatus = new Map<string, SubStatus>();

  constructor(url: string, pool: PushPool) {
    this.url = url;
    this.#pool = pool;
    this.#connect();
  }

  status(): RelayStatus {
    return { url: this.url, open: this.#open, ...this.#status, subs: Object.fromEntries(this.#subStatus) };
  }

  #connect(): void {
    if (this.#closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.#pool.log(`${this.url}: cannot connect: ${error instanceof Error ? error.message : error}`);
      this.#status.failures++;
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#open = true;
      this.#backoff = BACKOFF_MIN_MS;
      this.#status.connectedAt = Date.now();
      this.#status.failures = 0;
      this.#status.retryAt = null;
      this.#status.authChallenged = false;
      this.#pool.log(`${this.url}: connected, ${this.subs.size} subscription(s)`);
      for (const id of this.subs.keys()) this.#req(id);
      this.#pool.changed();
    };
    socket.onmessage = (message) => {
      if (typeof message.data === 'string') this.#onMessage(message.data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      const wasOpen = this.#open;
      this.#socket = null;
      this.#open = false;
      this.#status.disconnectedAt = Date.now();
      if (!wasOpen) this.#status.failures++;
      const why = [event.code, event.reason].filter(Boolean).join(' ');
      this.#pool.log(`${this.url}: ${wasOpen ? 'disconnected' : 'connection failed'}${why ? ` (${why})` : ''}`);
      this.#scheduleRetry();
      this.#pool.changed();
    };
    socket.onerror = () => {
      // onclose follows.
    };
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retry) return;
    const delay = this.#backoff * (0.75 + Math.random() * 0.5);
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    this.#status.retryAt = Date.now() + delay;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, delay);
  }

  #send(message: unknown[]): void {
    if (this.#open && this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #req(id: string): void {
    const wanted = this.subs.get(id);
    if (!wanted) return;
    const since = this.#pool.sinceFor(wanted.site);
    const filters = wanted.filters.map((f) => ({
      ...f,
      since: Math.max(
        typeof f.since === 'number' ? f.since : 0,
        matchesGiftWraps(f) ? since - GIFT_WRAP_BACKDATE : since,
      ),
    }));
    if (!this.#open) return;
    this.#send(['REQ', id, ...filters]);
    this.#subStatus.set(id, {
      site: wanted.site,
      since,
      sentAt: Date.now(),
      eose: false,
      closed: null,
      events: this.#subStatus.get(id)?.events ?? 0,
    });
  }

  #onMessage(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, first, second] = message as unknown[];
    switch (type) {
      case 'EVENT': {
        if (typeof first !== 'string') return;
        const wanted = this.subs.get(first);
        if (!wanted || !isEvent(second)) return;
        const status = this.#subStatus.get(first);
        if (status) status.events++;
        this.#pool.received(wanted.site, second, this.url, !status?.eose);
        return;
      }
      case 'EOSE': {
        const status = typeof first === 'string' ? this.#subStatus.get(first) : undefined;
        if (status && !status.eose) {
          status.eose = true;
          this.#pool.changed();
        }
        return;
      }
      case 'CLOSED': {
        if (typeof first !== 'string' || !this.subs.has(first)) return;
        const reason = short(second ?? '');
        const status = this.#subStatus.get(first);
        if (status) status.closed = reason;
        this.#pool.log(`${this.url}: closed ${first}: ${reason || '(no reason)'}`);
        this.#pool.changed();
        return;
      }
      case 'NOTICE':
        this.#status.notice = short(first);
        this.#pool.log(`${this.url}: NOTICE ${this.#status.notice}`);
        this.#pool.changed();
        return;
      case 'AUTH':
        if (this.#status.authChallenged) return;
        this.#status.authChallenged = true;
        this.#pool.log(`${this.url}: sent an AUTH challenge, which the pool doesn't answer`);
        this.#pool.changed();
        return;
    }
  }

  set(id: string, wanted: Wanted): void {
    const before = this.subs.get(id);
    this.subs.set(id, wanted);
    if (!before || JSON.stringify(before.filters) !== JSON.stringify(wanted.filters)) this.#req(id);
  }

  remove(id: string): void {
    this.#subStatus.delete(id);
    if (this.subs.delete(id)) this.#send(['CLOSE', id]);
  }

  /** Reconnect now if down (the computer woke, or the network came back). */
  wake(): void {
    if (this.#open || this.#closed) return;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#backoff = BACKOFF_MIN_MS;
    if (!this.#socket) this.#connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }
}

export interface PushPoolOptions {
  /** Hand an event to a site's service worker. */
  deliver: (site: string, event: NostrEvent, relay: string) => void;
  /** The site's newest delivered event moved `since` forward. */
  onSinceChanged: (site: string, since: number) => void;
  /** A line for the system log. */
  log: (line: string) => void;
  /** Something {@link PushPool.status} reports changed. */
  onStatusChanged: () => void;
}

/** What the pool has done for a site since Din started. */
export interface SiteStats {
  delivered: number;
  duplicates: number;
  /** Stored events older than `since`, skipped. */
  history: number;
  badSignatures: number;
  lastDelivered: { id: string; kind: number; created_at: number; relay: string; at: number } | null;
}

/** The relay connections behind every site's subscriptions. */
export class PushPool {
  readonly #relays = new Map<string, Relay>();
  readonly #sites = new Map<string, SitePush>();
  readonly #seen = new Map<string, Set<string>>();
  readonly #stats = new Map<string, SiteStats>();
  readonly #options: PushPoolOptions;

  constructor(options: PushPoolOptions) {
    this.#options = options;
  }

  log(line: string): void {
    this.#options.log(line);
  }

  changed(): void {
    this.#options.onStatusChanged();
  }

  status(): { sites: Record<string, SiteStats & { since: number; subscriptions: number }>; relays: RelayStatus[] } {
    const sites: Record<string, SiteStats & { since: number; subscriptions: number }> = {};
    for (const [site, push] of this.#sites) {
      sites[site] = { since: push.since, subscriptions: push.subscriptions.length, ...this.#siteStats(site) };
    }
    return { sites, relays: [...this.#relays.values()].map((relay) => relay.status()) };
  }

  #siteStats(site: string): SiteStats {
    let stats = this.#stats.get(site);
    if (!stats) {
      stats = { delivered: 0, duplicates: 0, history: 0, badSignatures: 0, lastDelivered: null };
      this.#stats.set(site, stats);
    }
    return stats;
  }

  sinceFor(site: string): number {
    return this.#sites.get(site)?.since ?? Math.floor(Date.now() / 1000);
  }

  /** Replace a site's subscriptions (an empty list stops them). */
  setSite(site: string, push: SitePush | null): void {
    if (push && push.subscriptions.length > 0) this.#sites.set(site, push);
    else {
      this.#sites.delete(site);
      this.#seen.delete(site);
      this.#stats.delete(site);
    }
    this.#sync();
    this.changed();
  }

  /** An event a relay sent; `stored` when it came before the REQ's EOSE. */
  received(site: string, event: NostrEvent, relay: string, stored: boolean): void {
    const push = this.#sites.get(site);
    if (!push) return;
    const stats = this.#siteStats(site);
    // History the gift-wrap margin turned up. Not marked seen: a copy of it
    // that some other relay sends live is still news.
    if (stored && event.created_at <= push.since) {
      stats.history++;
      return;
    }
    let seen = this.#seen.get(site);
    if (!seen) {
      seen = new Set();
      this.#seen.set(site, seen);
    }
    if (seen.has(event.id)) {
      stats.duplicates++;
      return;
    }
    if (!verifyEvent(event)) {
      stats.badSignatures++;
      this.log(`${relay}: bad signature on ${event.id} for ${site}`);
      return;
    }
    seen.add(event.id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    if (event.created_at > push.since && event.created_at <= Date.now() / 1000 + 600) {
      push.since = event.created_at;
      this.#options.onSinceChanged(site, push.since);
    }
    stats.delivered++;
    stats.lastDelivered = { id: event.id, kind: event.kind, created_at: event.created_at, relay, at: Date.now() };
    this.log(`${site}: kind ${event.kind} ${event.id.slice(0, 12)} (created ${event.created_at}) from ${relay}`);
    this.changed();
    this.#options.deliver(site, event, relay);
  }

  wake(): void {
    for (const relay of this.#relays.values()) relay.wake();
  }

  close(): void {
    for (const relay of this.#relays.values()) relay.close();
    this.#relays.clear();
  }

  /** Open, change and close REQs (and sockets) to match what sites want. */
  #sync(): void {
    const wanted = new Map<string, Map<string, Wanted>>();
    for (const [site, push] of this.#sites) {
      const prefix = crypto.createHash('sha256').update(site).digest('hex').slice(0, 16);
      push.subscriptions.forEach((sub, index) => {
        for (const url of sub.relays) {
          let subs = wanted.get(url);
          if (!subs) {
            subs = new Map();
            wanted.set(url, subs);
          }
          subs.set(`napp:${prefix}:${index}`, { site, filters: sub.filters });
        }
      });
    }
    for (const [url, relay] of this.#relays) {
      const subs = wanted.get(url);
      if (!subs) {
        relay.close();
        this.#relays.delete(url);
        continue;
      }
      for (const id of [...relay.subs.keys()]) if (!subs.has(id)) relay.remove(id);
    }
    for (const [url, subs] of wanted) {
      let relay = this.#relays.get(url);
      if (!relay) {
        relay = new Relay(url, this);
        this.#relays.set(url, relay);
      }
      for (const [id, sub] of subs) relay.set(id, sub);
    }
  }
}

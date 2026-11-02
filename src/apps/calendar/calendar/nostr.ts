import { useEffect, useMemo } from 'react';
import { NPool, NRelay1, type NostrEvent } from '@nostrify/nostrify';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Nip07 } from '@/sdk/din';
import { useWindowState } from '@/sdk/react';
import { calendarFilters, collectCalendar, coordFilters, parseRsvp, RSVP_KIND, type CalendarData, type EventTemplate, type Rsvp } from '@/shared/calendar';

/** Where the account's relay list is looked for, and where to look when it has none. */
const FALLBACK_RELAYS = ['wss://relay.ditto.pub', 'wss://relay.primal.net', 'wss://relay.damus.io'];

function signer(): Nip07 {
  const nostr = (window as Window & { nostr?: Nip07 }).nostr;
  if (!nostr) throw new Error('Calendar can’t sign as you here');
  return nostr;
}

interface RelayList {
  read: string[];
  write: string[];
}

/** The account's NIP-65 relays, as last fetched, for the pool's routers. */
let relayList: RelayList | null = null;
let relayListOf: string | null = null;
let relayListLoading: Promise<RelayList> | null = null;

/** The newest kind 10002 the user published, from the well-known relays. */
function loadRelayList(pubkey: string): Promise<RelayList> {
  if (relayListOf === pubkey && relayList) return Promise.resolve(relayList);
  if (relayListOf === pubkey && relayListLoading) return relayListLoading;
  relayListOf = pubkey;
  relayList = null;
  const bootstrap = new NPool({
    open: (url) => new NRelay1(url),
    reqRouter: (filters) => new Map(FALLBACK_RELAYS.map((url) => [url, filters])),
    eventRouter: () => [],
    eoseTimeout: 1500,
  });
  relayListLoading = bootstrap
    .query([{ kinds: [10002], authors: [pubkey], limit: 1 }], { signal: AbortSignal.timeout(8_000) })
    .catch(() => [])
    .then((events) => {
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const list: RelayList = { read: [], write: [] };
      for (const [name, url, marker] of newest?.tags ?? []) {
        if (name !== 'r' || !/^wss?:\/\//.test(url ?? '')) continue;
        if (marker !== 'write') list.read.push(url);
        if (marker !== 'read') list.write.push(url);
      }
      if (relayListOf === pubkey) relayList = list;
      void bootstrap.close();
      return list;
    });
  return relayListLoading;
}

async function relaysOf(mode: 'read' | 'write'): Promise<string[]> {
  const list = relayList ?? (relayListLoading ? await relayListLoading : null);
  const urls = list?.[mode] ?? [];
  return urls.length ? urls : FALLBACK_RELAYS;
}

/** The account's write relays, for links to its events. */
export function writeRelays(): string[] {
  return relayList?.write ?? [];
}

let pool: NPool | null = null;

/** The app's own connections, on the account's relays. */
function poolFor(): NPool {
  pool ??= new NPool({
    open: (url) =>
      new NRelay1(url, {
        auth: (challenge) =>
          signer().signEvent({ kind: 22242, content: '', tags: [['relay', url], ['challenge', challenge]], created_at: Math.floor(Date.now() / 1000) }),
      }),
    reqRouter: async (filters) => new Map((await relaysOf('read')).map((url) => [url, filters])),
    eventRouter: () => relaysOf('write'),
    eoseTimeout: 1500,
  });
  return pool;
}

/**
 * The signed-in user's pubkey from `window.nostr`, or null, asked again
 * when the window comes back to the front (another account may be signed
 * in by then).
 */
export function usePubkey(): string | null {
  const { data } = useQuery({
    queryKey: ['pubkey'],
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    queryFn: async () => {
      const pubkey = await signer().getPublicKey().catch(() => null);
      if (pubkey) void loadRelayList(pubkey);
      return pubkey;
    },
  });
  return data ?? null;
}

const dataKey = (pubkey: string | null) => ['calendar', pubkey] as const;

/**
 * Everything the calendar shows for the user: their events, invitations,
 * calendars (with other people's events in them) and answers. Fetched
 * again every few minutes and when the window comes back to the front.
 */
export function useCalendarData(pubkey: string | null) {
  const focused = useWindowState((s) => s.focused);
  const query = useQuery({
    queryKey: dataKey(pubkey),
    enabled: !!pubkey,
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const nostr = poolFor();
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const raw = await nostr.query(calendarFilters(pubkey!), { signal: timeout });
      // Events in the user's calendars that someone else made.
      const have = new Set(raw.map((e) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`));
      const wanted = collectCalendar(raw, pubkey!).calendars.flatMap((c) => c.members).filter((m) => !have.has(m));
      if (wanted.length) {
        const extra = await nostr.query(coordFilters(wanted), { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) }).catch(() => []);
        raw.push(...extra);
      }
      return raw;
    },
  });
  const { refetch, dataUpdatedAt } = query;
  useEffect(() => {
    if (focused && pubkey && dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 30_000) void refetch();
    // Only on coming to the front, not each time the data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, pubkey, refetch]);
  const data = useMemo<CalendarData | null>(() => (query.data && pubkey ? collectCalendar(query.data, pubkey) : null), [query.data, pubkey]);
  return { ...query, calendar: data };
}

/** Sign and publish events as the user, in order, adding each to what the calendar shows at once. */
export function usePublish() {
  const qc = useQueryClient();
  const pubkey = usePubkey();
  return useMutation({
    mutationFn: async (templates: EventTemplate[]) => {
      const signed: NostrEvent[] = [];
      for (const t of templates) {
        const event = (await signer().signEvent(t)) as NostrEvent;
        await poolFor().event(event, { signal: AbortSignal.timeout(10_000) });
        signed.push(event);
        qc.setQueryData<NostrEvent[]>(dataKey(pubkey), (old) => [...(old ?? []), event]);
        const rsvp = parseRsvp(event);
        if (rsvp) qc.setQueryData<Map<string, Rsvp>>(['attendance', rsvp.coord], (old) => (old ? new Map(old).set(rsvp.pubkey, rsvp) : old));
      }
      return signed;
    },
  });
}

/** Everyone's answers to a calendar event, the newest of each person's. */
export function useAttendance(coord: string | null) {
  return useQuery({
    queryKey: ['attendance', coord],
    enabled: !!coord,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await poolFor().query([{ kinds: [RSVP_KIND], '#a': [coord!], limit: 500 }], { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      const out = new Map<string, Rsvp>();
      for (const e of events) {
        const r = parseRsvp(e);
        if (r && r.coord === coord && (out.get(r.pubkey)?.event.created_at ?? -1) < e.created_at) out.set(r.pubkey, r);
      }
      return out;
    },
  });
}

export interface Profile {
  name: string;
  picture?: string;
  nip05?: string;
}

/** https pictures only; anything else isn't loaded. */
function safeImage(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Names and pictures (kind 0) for people, fetched together. */
export function useProfiles(pubkeys: readonly string[]): Map<string, Profile> {
  const key = useMemo(() => [...new Set(pubkeys)].sort(), [pubkeys]);
  const query = useQuery<Map<string, Profile>>({
    queryKey: ['profiles', key],
    enabled: key.length > 0,
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const events = await poolFor().query([{ kinds: [0], authors: key, limit: key.length }], { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      const out = new Map<string, Profile>();
      const newest = new Map<string, NostrEvent>();
      for (const e of events) if ((newest.get(e.pubkey)?.created_at ?? -1) < e.created_at) newest.set(e.pubkey, e);
      for (const [pk, e] of newest) {
        try {
          const m = JSON.parse(e.content) as Record<string, unknown>;
          const name = [m.display_name, m.name].find((n): n is string => typeof n === 'string' && n.trim() !== '');
          out.set(pk, { name: name?.trim() ?? '', picture: safeImage(m.picture), nip05: typeof m.nip05 === 'string' ? m.nip05 : undefined });
        } catch {
          // An unreadable profile is no profile.
        }
      }
      return out;
    },
  });
  return query.data ?? EMPTY;
}

const EMPTY = new Map<string, Profile>();

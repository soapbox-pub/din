import { useCallback, useEffect } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient, type InfiniteData, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import type { InboxTabs, MailAccount, MailBridge, MailboxInfo, MailCategory, MailLabels, MailMessage, MailSubscription, MessageFilter, MessageSummary, SpecialMailbox } from '@/lib/mail';

export function useMail(): MailBridge | null {
  return useDin().system.mail ?? null;
}

/** One mailbox of one account. */
export interface Source {
  accountId: string;
  path: string;
}

/** A message in the list, with where it lives. */
export interface Item extends MessageSummary {
  accountId: string;
  path: string;
  key: string;
}

export function itemKey(accountId: string, path: string, uid: number): string {
  return `${accountId}\u0000${path}\u0000${uid}`;
}

/** What the sidebar has selected: a mailbox, a label, one of the Favorites across every account, or Subscriptions. */
export type Selection =
  | { kind: 'mailbox'; accountId: string; path: string }
  | { kind: 'label'; accountId: string; id: string }
  | { kind: 'all'; special: SpecialMailbox }
  | { kind: 'subscriptions' };

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind === 'mailbox' && b.kind === 'mailbox') return a.accountId === b.accountId && a.path === b.path;
  if (a.kind === 'label' && b.kind === 'label') return a.accountId === b.accountId && a.id === b.id;
  if (a.kind === 'all' && b.kind === 'all') return a.special === b.special;
  return a.kind === 'subscriptions' && b.kind === 'subscriptions';
}

const ACCOUNTS = ['mail', 'accounts'] as const;

export function useAccounts() {
  const mail = useMail();
  return useQuery({
    queryKey: ACCOUNTS,
    queryFn: () => mail!.accounts(),
    enabled: !!mail,
    staleTime: Infinity,
  });
}

export function mailboxesKey(accountId: string) {
  return ['mail', 'mailboxes', accountId] as const;
}

export interface Mailboxes {
  /** Mailboxes by account, from whichever listings have arrived. */
  boxes: Map<string, MailboxInfo[]>;
  /** Why an account's mailboxes couldn't be listed. */
  errors: Map<string, string>;
  fetching: boolean;
}

export function useMailboxes(accounts: MailAccount[]): Mailboxes {
  const mail = useMail();
  const combine = useCallback(
    (results: UseQueryResult<MailboxInfo[]>[]): Mailboxes => {
      const boxes = new Map<string, MailboxInfo[]>();
      const errors = new Map<string, string>();
      results.forEach((r, i) => {
        const id = accounts[i]?.id;
        if (!id) return;
        if (r.data) boxes.set(id, r.data);
        if (r.error) errors.set(id, r.error instanceof Error ? r.error.message : String(r.error));
      });
      return { boxes, errors, fetching: results.some((r) => r.isFetching) };
    },
    [accounts],
  );
  return useQueries({
    queries: accounts.map((a) => ({
      queryKey: mailboxesKey(a.id),
      queryFn: () => mail!.mailboxes(a.id),
      enabled: !!mail,
      staleTime: 30_000,
      // Keeps the account's connection, and so its new-mail watch, up while Mail is open.
      refetchInterval: 2 * 60_000,
      retry: 1,
    })),
    combine,
  });
}

export function labelsKey(accountId: string) {
  return ['mail', 'labels', accountId] as const;
}

/** Each account's labels, from whichever have arrived. */
export function useLabels(accounts: MailAccount[]): Map<string, MailLabels> {
  const mail = useMail();
  const combine = useCallback(
    (results: UseQueryResult<MailLabels>[]) => {
      const out = new Map<string, MailLabels>();
      results.forEach((r, i) => {
        const id = accounts[i]?.id;
        if (id && r.data) out.set(id, r.data);
      });
      return out;
    },
    [accounts],
  );
  return useQueries({
    queries: accounts.map((a) => ({
      queryKey: labelsKey(a.id),
      queryFn: () => mail!.labels(a.id),
      enabled: !!mail,
      staleTime: 60_000,
      retry: 1,
    })),
    combine,
  });
}

/**
 * The mailboxes a selection reads from. A Gmail label is its own mailbox;
 * a keyword is looked for in All Mail where there is one, else in every
 * mailbox but the Trash and Junk.
 */
export function sourcesOf(selection: Selection, boxes: Map<string, MailboxInfo[]>, labels: Map<string, MailLabels>): Source[] {
  if (selection.kind === 'mailbox') return [{ accountId: selection.accountId, path: selection.path }];
  if (selection.kind === 'subscriptions') return [];
  if (selection.kind === 'label') {
    const { accountId } = selection;
    const label = labels.get(accountId)?.labels.find((l) => l.id === selection.id);
    if (!label) return [];
    if (label.path) return [{ accountId, path: label.path }];
    const list = (boxes.get(accountId) ?? []).filter((b) => b.selectable);
    const all = list.find((b) => b.special === 'all');
    return (all ? [all] : list.filter((b) => b.special !== 'trash' && b.special !== 'junk')).map((b) => ({ accountId, path: b.path }));
  }
  const out: Source[] = [];
  for (const [accountId, list] of boxes) {
    const special = selection.special === 'flagged' ? 'inbox' : selection.special;
    const box = list.find((b) => b.special === special && b.selectable);
    if (box) out.push({ accountId, path: box.path });
  }
  return out;
}

/** The keyword a selection's mailboxes are searched for, or null (a Gmail label is a mailbox of its own). */
export function keywordOf(selection: Selection, labels: Map<string, MailLabels>): string | null {
  if (selection.kind !== 'label') return null;
  const label = labels.get(selection.accountId)?.labels.find((l) => l.id === selection.id);
  return label && !label.path ? label.id : null;
}

type Cursor = Record<string, number | null>;

interface Page {
  items: Item[];
  /** For each source, the uid to read older messages before, or null when it's done. */
  next: Cursor;
  total: number;
}

function sourceKey(s: Source): string {
  return `${s.accountId}\u0000${s.path}`;
}

export function messagesKey(sources: Source[], filter: MessageFilter, query: string, keyword: string | null, category: MailCategory | null) {
  return ['mail', 'messages', sources.map(sourceKey).sort().join('\u0001'), filter, query, keyword, category] as const;
}

/**
 * The newest messages of every source (with `keyword`, those that have it;
 * with `category`, the inbox tab's), merged by date, then older ones page
 * by page.
 */
export function useMessages(sources: Source[], filter: MessageFilter, query: string, keyword: string | null = null, category: MailCategory | null = null) {
  const mail = useMail();
  return useInfiniteQuery({
    queryKey: messagesKey(sources, filter, query, keyword, category),
    enabled: !!mail && sources.length > 0,
    initialPageParam: null as Cursor | null,
    staleTime: 30_000,
    queryFn: async ({ pageParam }): Promise<Page> => {
      const want = sources.filter((s) => !pageParam || pageParam[sourceKey(s)] != null);
      const results = await Promise.allSettled(
        want.map((s) =>
          mail!.messages(s.accountId, s.path, { before: pageParam?.[sourceKey(s)] ?? undefined, query: query || undefined, filter, label: keyword ?? undefined, category: category ?? undefined }),
        ),
      );
      const next: Cursor = {};
      const items: Item[] = [];
      let total = 0;
      let failure: unknown = null;
      results.forEach((r, i) => {
        const s = want[i];
        if (r.status === 'rejected') {
          failure = r.reason;
          next[sourceKey(s)] = null;
          return;
        }
        total += r.value.total;
        for (const m of r.value.messages) items.push({ ...m, accountId: s.accountId, path: s.path, key: itemKey(s.accountId, s.path, m.uid) });
        const last = r.value.next ?? (r.value.messages.length ? Math.min(...r.value.messages.map((m) => m.uid)) : undefined);
        next[sourceKey(s)] = r.value.more && last ? last : null;
      });
      if (failure && !items.length) throw failure;
      items.sort((a, b) => b.date - a.date);
      return { items, next, total };
    },
    getNextPageParam: (last) => (Object.values(last.next).some((v) => v != null) ? last.next : undefined),
  });
}

export function useMessage(item: Item | null) {
  const mail = useMail();
  return useQuery({
    queryKey: ['mail', 'message', item?.accountId, item?.path, item?.uid],
    queryFn: () => mail!.message(item!.accountId, item!.path, item!.uid),
    enabled: !!mail && !!item,
    staleTime: Infinity,
    retry: 1,
  });
}

/** Look this far before a conversation's oldest message in the list for the rest of it. */
const CONVERSATION_LOOKBACK_MS = 90 * 86_400_000;

/**
 * A conversation's every message, wherever it's filed (the inbox, Sent,
 * Archive), oldest first; `known` are the ones the list has, shown until
 * the rest arrive, and kept if the search misses them.
 */
export function useConversation(known: Item[] | null) {
  const mail = useMail();
  const first = known?.[0];
  const ids = [...new Set((known ?? []).flatMap((i) => [i.messageId, i.inReplyTo, ...(i.references ?? [])]).filter((x): x is string => !!x))].slice(0, 30);
  const threadId = known?.find((i) => i.threadId)?.threadId ?? null;
  const since = known?.length ? Math.min(...known.map((i) => i.date)) - CONVERSATION_LOOKBACK_MS : undefined;
  const query = useQuery({
    queryKey: ['mail', 'conversation', first?.accountId, threadId ?? ids.join(' ')],
    queryFn: async () => {
      const found = await mail!.conversation(first!.accountId, { messageIds: ids, threadId, since });
      return found.map((m): Item => ({ ...m.summary, accountId: first!.accountId, path: m.path, key: itemKey(first!.accountId, m.path, m.summary.uid) }));
    },
    enabled: !!mail && !!first && (ids.length > 0 || !!threadId),
    staleTime: 60_000,
    retry: 1,
  });
  const merged = (() => {
    if (!known) return [];
    // The list's own copies win: they're what its actions act on.
    const out = [...known];
    const have = new Set(known.flatMap((i) => [i.key, i.messageId ?? '']).filter(Boolean));
    for (const i of query.data ?? []) {
      if (have.has(i.key) || (i.messageId && have.has(i.messageId))) continue;
      have.add(i.key);
      out.push(i);
    }
    return out.sort((x, y) => x.date - y.date);
  })();
  return { items: merged, loading: query.isPending && query.fetchStatus !== 'idle' };
}

/**
 * Change list items in every cached page (flags read or flagged, labels,
 * items gone), by the same patch for each or one made from each.
 */
export function patchItems(qc: QueryClient, keys: Set<string>, patch: Partial<MessageSummary> | ((m: MessageSummary) => Partial<MessageSummary>) | null): void {
  const apply = <T extends MessageSummary>(m: T): T => (patch === null ? m : { ...m, ...(typeof patch === 'function' ? patch(m) : patch) });
  qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['mail', 'messages'] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: patch === null ? page.items.filter((i) => !keys.has(i.key)) : page.items.map((i) => (keys.has(i.key) ? apply(i) : i)),
      })),
    };
  });
  qc.setQueriesData<Item[]>({ queryKey: ['mail', 'conversation'] }, (list) =>
    list && (patch === null ? list.filter((i) => !keys.has(i.key)) : list.map((i) => (keys.has(i.key) ? apply(i) : i))),
  );
  if (patch) {
    for (const key of keys) {
      const [accountId, path, uid] = key.split('\u0000');
      qc.setQueryData<MailMessage>(['mail', 'message', accountId, path, Number(uid)], (m) => (m ? apply(m) : m));
    }
  }
}

/** Shift a mailbox's unread count ahead of the server's answer. */
export function patchUnseen(qc: QueryClient, accountId: string, path: string, delta: number): void {
  qc.setQueryData<MailboxInfo[]>(mailboxesKey(accountId), (list) =>
    list?.map((b) => (b.path === path ? { ...b, unseen: Math.max(0, b.unseen + delta) } : b)),
  );
}

export function subscriptionsKey(accountId: string, months: number) {
  return ['mail', 'subscriptions', accountId, months] as const;
}

export interface Subscriptions {
  list: MailSubscription[];
  /** Why an account's lists couldn't be read. */
  errors: Map<string, string>;
  /** Some account hasn't answered yet. */
  pending: boolean;
  fetching: boolean;
}

/** Every account's mailing lists over the last `months`, most mail first. */
export function useSubscriptions(accounts: MailAccount[], months: number): Subscriptions {
  const mail = useMail();
  const combine = useCallback(
    (results: UseQueryResult<MailSubscription[]>[]): Subscriptions => {
      const errors = new Map<string, string>();
      results.forEach((r, i) => {
        const id = accounts[i]?.id;
        if (id && r.error) errors.set(id, r.error instanceof Error ? r.error.message : String(r.error));
      });
      const list = results.flatMap((r) => r.data ?? []).sort((x, y) => y.count - x.count || y.last - x.last);
      return { list, errors, pending: results.some((r) => r.isPending && !r.error), fetching: results.some((r) => r.isFetching) };
    },
    [accounts],
  );
  return useQueries({
    queries: accounts.map((a) => ({
      queryKey: subscriptionsKey(a.id, months),
      queryFn: async () => (await mail!.subscriptions(a.id, { months })).subscriptions,
      enabled: !!mail,
      staleTime: 5 * 60_000,
      retry: 1,
    })),
    combine,
  });
}

const INBOX_TABS = ['mail', 'inbox-tabs'] as const;

/** Which inbox tabs are shown, and which new mail notifies. */
export function useInboxTabs() {
  const mail = useMail();
  return useQuery({ queryKey: INBOX_TABS, queryFn: () => mail!.inboxTabs(), enabled: !!mail, staleTime: 60_000 });
}

/** Change which inbox tabs are shown, or which new mail notifies. */
export function useSetInboxTabs() {
  const mail = useMail();
  const qc = useQueryClient();
  return useCallback(
    async (patch: Partial<InboxTabs>) => {
      const was = qc.getQueryData<InboxTabs>(INBOX_TABS);
      if (was) qc.setQueryData<InboxTabs>(INBOX_TABS, { ...was, ...patch });
      try {
        qc.setQueryData(INBOX_TABS, await mail!.setInboxTabs(patch));
      } finally {
        void qc.invalidateQueries({ queryKey: INBOX_TABS });
        void qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
        void qc.invalidateQueries({ queryKey: ['mail', 'tab-counts'] });
      }
    },
    [mail, qc],
  );
}

export function tabCountsKey(accountId: string) {
  return ['mail', 'tab-counts', accountId] as const;
}

/** The dates of each tab's newest unread mail, merged over these accounts' inboxes. */
export function useTabCounts(accountIds: string[], enabled: boolean): Partial<Record<MailCategory, number[]>> {
  const mail = useMail();
  const combine = useCallback((results: UseQueryResult<Record<MailCategory, number[]>>[]) => {
    const out: Partial<Record<MailCategory, number[]>> = {};
    for (const r of results) for (const [c, dates] of Object.entries(r.data ?? {}) as [MailCategory, number[]][]) out[c] = [...(out[c] ?? []), ...dates];
    return out;
  }, []);
  return useQueries({
    queries: accountIds.map((id) => ({
      queryKey: tabCountsKey(id),
      queryFn: () => mail!.tabCounts(id),
      enabled: !!mail && enabled,
      staleTime: 30_000,
    })),
    combine,
  });
}

/** Refetch what a change on the server touched. */
export function useLiveUpdates(): void {
  const mail = useMail();
  const qc = useQueryClient();
  useEffect(() => {
    if (!mail) return;
    return mail.onChanged(({ accountId, path }) => {
      void qc.invalidateQueries({ queryKey: mailboxesKey(accountId) });
      // New keywords on the mail. (Gmail's labels are its mailboxes, listed again when Mail changes them.)
      if (qc.getQueryData<MailLabels>(labelsKey(accountId))?.kind !== 'gmail') void qc.invalidateQueries({ queryKey: labelsKey(accountId) });
      if (path.toUpperCase() === 'INBOX') {
        void qc.invalidateQueries({ queryKey: tabCountsKey(accountId) });
        // Tabs shown or hidden elsewhere (din mail tabs) say so as a change to every inbox.
        void qc.invalidateQueries({ queryKey: INBOX_TABS });
      }
      const needle = `${accountId}\u0000${path}`;
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'mail' && q.queryKey[1] === 'messages' && String(q.queryKey[2]).split('\u0001').includes(needle),
      });
    });
  }, [mail, qc]);
}

import { useCallback, useEffect } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient, type InfiniteData, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import type { MailAccount, MailBridge, MailboxInfo, MailMessage, MessageFilter, MessageSummary, SpecialMailbox } from '@/lib/mail';

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

/** What the sidebar has selected: a mailbox, or one of the Favorites across every account. */
export type Selection =
  | { kind: 'mailbox'; accountId: string; path: string }
  | { kind: 'all'; special: SpecialMailbox };

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind === 'mailbox' && b.kind === 'mailbox') return a.accountId === b.accountId && a.path === b.path;
  if (a.kind === 'all' && b.kind === 'all') return a.special === b.special;
  return false;
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

/** The mailboxes a selection reads from. */
export function sourcesOf(selection: Selection, boxes: Map<string, MailboxInfo[]>): Source[] {
  if (selection.kind === 'mailbox') return [{ accountId: selection.accountId, path: selection.path }];
  const out: Source[] = [];
  for (const [accountId, list] of boxes) {
    const special = selection.special === 'flagged' ? 'inbox' : selection.special;
    const box = list.find((b) => b.special === special && b.selectable);
    if (box) out.push({ accountId, path: box.path });
  }
  return out;
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

export function messagesKey(sources: Source[], filter: MessageFilter, query: string) {
  return ['mail', 'messages', sources.map(sourceKey).sort().join('\u0001'), filter, query] as const;
}

/** The newest messages of every source, merged by date, then older ones page by page. */
export function useMessages(sources: Source[], filter: MessageFilter, query: string) {
  const mail = useMail();
  return useInfiniteQuery({
    queryKey: messagesKey(sources, filter, query),
    enabled: !!mail && sources.length > 0,
    initialPageParam: null as Cursor | null,
    staleTime: 30_000,
    queryFn: async ({ pageParam }): Promise<Page> => {
      const want = sources.filter((s) => !pageParam || pageParam[sourceKey(s)] != null);
      const results = await Promise.allSettled(
        want.map((s) =>
          mail!.messages(s.accountId, s.path, { before: pageParam?.[sourceKey(s)] ?? undefined, query: query || undefined, filter }),
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
        const last = r.value.messages.at(-1);
        next[sourceKey(s)] = r.value.more && last ? Math.min(...r.value.messages.map((m) => m.uid)) : null;
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

/** Change list items in every cached page (flags read or flagged, items gone). */
export function patchItems(qc: QueryClient, keys: Set<string>, patch: Partial<MessageSummary> | null): void {
  qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['mail', 'messages'] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: patch === null ? page.items.filter((i) => !keys.has(i.key)) : page.items.map((i) => (keys.has(i.key) ? { ...i, ...patch } : i)),
      })),
    };
  });
  if (patch) {
    for (const key of keys) {
      const [accountId, path, uid] = key.split('\u0000');
      qc.setQueryData<MailMessage>(['mail', 'message', accountId, path, Number(uid)], (m) => (m ? { ...m, ...patch } : m));
    }
  }
}

/** Shift a mailbox's unread count ahead of the server's answer. */
export function patchUnseen(qc: QueryClient, accountId: string, path: string, delta: number): void {
  qc.setQueryData<MailboxInfo[]>(mailboxesKey(accountId), (list) =>
    list?.map((b) => (b.path === path ? { ...b, unseen: Math.max(0, b.unseen + delta) } : b)),
  );
}

/** Refetch what a change on the server touched. */
export function useLiveUpdates(): void {
  const mail = useMail();
  const qc = useQueryClient();
  useEffect(() => {
    if (!mail) return;
    return mail.onChanged(({ accountId, path }) => {
      void qc.invalidateQueries({ queryKey: mailboxesKey(accountId) });
      const needle = `${accountId}\u0000${path}`;
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'mail' && q.queryKey[1] === 'messages' && String(q.queryKey[2]).split('\u0001').includes(needle),
      });
    });
  }, [mail, qc]);
}

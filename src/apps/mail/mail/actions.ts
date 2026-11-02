import { useCallback } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import type { MailAccount, MailMessage } from '@/lib/mail';
import { patchItems, patchUnseen, useMail, type Item, type Source } from './api';
import { blankSeed, draftSeed, forwardSeed, replySeed, type ComposeSeed } from './format';

export type MessageAction =
  | 'reply'
  | 'reply-all'
  | 'forward'
  | 'archive'
  | 'trash'
  | 'junk'
  | 'not-junk'
  | 'flag'
  | 'unflag'
  | 'read'
  | 'unread'
  | 'open-draft';

function byMailbox(items: Item[]): Map<string, { accountId: string; path: string; uids: number[] }> {
  const out = new Map<string, { accountId: string; path: string; uids: number[] }>();
  for (const i of items) {
    const k = `${i.accountId}\u0000${i.path}`;
    const g = out.get(k) ?? { accountId: i.accountId, path: i.path, uids: [] };
    g.uids.push(i.uid);
    out.set(k, g);
  }
  return out;
}

/**
 * What can be done to messages, for every place that offers it. `onRemoved`
 * hears which messages left the list (to move the selection on).
 */
export function useMessageActions(accounts: MailAccount[], onRemoved: (keys: Set<string>) => void) {
  const din = useDin();
  const mail = useMail();
  const qc = useQueryClient();

  const fail = useCallback(
    (title: string, error: unknown) => {
      din.toast(title, { body: error instanceof Error ? error.message : String(error) });
    },
    [din],
  );

  const compose = useCallback((seed: ComposeSeed) => void din.app.open('mail', { compose: seed }), [din]);

  const newMessage = useCallback((accountId: string | null) => compose(blankSeed(accountId)), [compose]);

  const full = useCallback(
    (item: Item): Promise<MailMessage> =>
      qc.fetchQuery({ queryKey: ['mail', 'message', item.accountId, item.path, item.uid], queryFn: () => mail!.message(item.accountId, item.path, item.uid), staleTime: Infinity }),
    [mail, qc],
  );

  const run = useCallback(
    async (action: MessageAction, items: Item[]) => {
      if (!mail || !items.length) return;
      const first = items[0];
      const account = accounts.find((a) => a.id === first.accountId);
      const keys = new Set(items.map((i) => i.key));
      try {
        switch (action) {
          case 'reply':
          case 'reply-all':
            compose(replySeed(await full(first), first.accountId, first.path, account, action === 'reply-all'));
            return;
          case 'forward':
            compose(forwardSeed(await full(first), first.accountId, first.path));
            return;
          case 'open-draft':
            compose(draftSeed(await full(first), first.accountId));
            return;
          case 'flag':
          case 'unflag': {
            const flagged = action === 'flag';
            patchItems(qc, keys, { flagged });
            for (const g of byMailbox(items).values()) await mail.setFlags(g.accountId, g.path, g.uids, { flagged });
            return;
          }
          case 'read':
          case 'unread': {
            const seen = action === 'read';
            const changing = items.filter((i) => i.seen !== seen);
            patchItems(qc, keys, { seen });
            for (const g of byMailbox(changing).values()) {
              patchUnseen(qc, g.accountId, g.path, seen ? -g.uids.length : g.uids.length);
              await mail.setFlags(g.accountId, g.path, g.uids, { seen });
            }
            return;
          }
          case 'archive':
          case 'trash':
          case 'junk':
          case 'not-junk': {
            onRemoved(keys);
            patchItems(qc, keys, null);
            for (const g of byMailbox(items).values()) {
              const unseen = items.filter((i) => !i.seen && i.accountId === g.accountId && i.path === g.path).length;
              if (unseen) patchUnseen(qc, g.accountId, g.path, -unseen);
              if (action === 'trash') await mail.remove(g.accountId, g.path, g.uids);
              else await mail.move(g.accountId, g.path, g.uids, { special: action === 'not-junk' ? 'inbox' : action });
            }
            return;
          }
        }
      } catch (error) {
        fail('Mail couldn’t do that', error);
        void qc.invalidateQueries({ queryKey: ['mail'] });
      }
    },
    [mail, accounts, qc, compose, full, onRemoved, fail],
  );

  const moveTo = useCallback(
    async (items: Item[], accountId: string, path: string) => {
      if (!mail) return;
      const movable = items.filter((i) => i.accountId === accountId && i.path !== path);
      if (!movable.length) return;
      const keys = new Set(movable.map((i) => i.key));
      onRemoved(keys);
      patchItems(qc, keys, null);
      try {
        for (const g of byMailbox(movable).values()) await mail.move(g.accountId, g.path, g.uids, path);
      } catch (error) {
        fail('Mail couldn’t move that', error);
        void qc.invalidateQueries({ queryKey: ['mail'] });
      }
    },
    [mail, qc, onRemoved, fail],
  );

  /** Every message in these mailboxes read, on the server in one command each. */
  const markAllRead = useCallback(
    async (sources: Source[]) => {
      if (!mail) return;
      const here = new Set(sources.map((s) => `${s.accountId}\u0000${s.path}`));
      qc.setQueriesData<InfiniteData<{ items: Item[] }>>({ queryKey: ['mail', 'messages'] }, (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({ ...page, items: page.items.map((i) => (here.has(`${i.accountId}\u0000${i.path}`) ? { ...i, seen: true } : i)) })),
        },
      );
      for (const s of sources) patchUnseen(qc, s.accountId, s.path, -Infinity);
      try {
        for (const s of sources) await mail.markAllRead(s.accountId, s.path);
      } catch (error) {
        fail('Mail couldn’t mark that read', error);
      }
      void qc.invalidateQueries({ queryKey: ['mail'] });
    },
    [mail, qc, fail],
  );

  return { run, moveTo, markAllRead, newMessage, compose };
}

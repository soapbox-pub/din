import { useCallback } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from '@/shared/toast';
import type { LabelColor, MailAccount, MailLabel, MailLabels, MailMessage } from '@/lib/mail';
import { labelsKey, mailboxesKey, patchItems, patchUnseen, useMail, type Item, type Source } from './api';
import { blankSeed, draftSeed, forwardSeed, replySeed, type ComposeSeed } from './format';
import { appLink } from '@/shared/launch';

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
  const mail = useMail();
  const qc = useQueryClient();

  const fail = useCallback(
    (title: string, error: unknown) => {
      toast(title, { body: error instanceof Error ? error.message : String(error), destructive: true });
    },
    [],
  );

  const compose = useCallback((seed: ComposeSeed) => void window.open(appLink('mail', { compose: seed })), []);

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

  /**
   * Put a label on messages or take it off. `leaving`: they're shown for
   * that label, so taking it off takes them out of the list.
   */
  const setLabel = useCallback(
    async (items: Item[], id: string, on: boolean, leaving = false) => {
      if (!mail || !items.length) return;
      const keys = new Set(items.map((i) => i.key));
      if (!on && leaving) {
        onRemoved(keys);
        patchItems(qc, keys, null);
      } else {
        patchItems(qc, keys, (m) => ({ labels: on ? [...new Set([...(m.labels ?? []), id])].sort() : (m.labels ?? []).filter((l) => l !== id) }));
      }
      try {
        for (const g of byMailbox(items).values()) await mail.setLabels(g.accountId, g.path, g.uids, on ? { add: [id] } : { remove: [id] });
      } catch (error) {
        fail(on ? 'Mail couldn’t add the label' : 'Mail couldn’t take the label off', error);
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

  return { run, moveTo, setLabel, markAllRead, newMessage, compose };
}

/**
 * Making, renaming, recoloring and deleting an account's labels, for the
 * sidebar's menus and the label dialog. Each rejects with what went wrong.
 */
export function useLabelActions() {
  const mail = useMail();
  const qc = useQueryClient();

  const refresh = useCallback(
    (accountId: string, messages = false) => {
      void qc.invalidateQueries({ queryKey: labelsKey(accountId) });
      // Gmail's labels are mailboxes.
      void qc.invalidateQueries({ queryKey: mailboxesKey(accountId) });
      if (messages) void qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
    },
    [qc],
  );

  const create = useCallback(
    async (accountId: string, name: string, color: LabelColor | null): Promise<MailLabel> => {
      const label = await mail!.createLabel(accountId, { name, color });
      qc.setQueryData<MailLabels>(labelsKey(accountId), (info) => info && { ...info, labels: [...info.labels, label].sort((x, y) => x.name.localeCompare(y.name)) });
      refresh(accountId);
      return label;
    },
    [mail, qc, refresh],
  );

  const update = useCallback(
    async (accountId: string, id: string, patch: { name?: string; color?: LabelColor | null }): Promise<MailLabel> => {
      const label = await mail!.updateLabel(accountId, id, patch);
      qc.setQueryData<MailLabels>(labelsKey(accountId), (info) => info && { ...info, labels: info.labels.map((l) => (l.id === id ? label : l)).sort((x, y) => x.name.localeCompare(y.name)) });
      // A Gmail label renamed is a mailbox renamed, and every message's label with it.
      refresh(accountId, label.id !== id);
      return label;
    },
    [mail, qc, refresh],
  );

  const remove = useCallback(
    async (accountId: string, id: string): Promise<void> => {
      qc.setQueryData<MailLabels>(labelsKey(accountId), (info) => info && { ...info, labels: info.labels.filter((l) => l.id !== id) });
      try {
        await mail!.deleteLabel(accountId, id);
      } finally {
        refresh(accountId, true);
      }
    },
    [mail, qc, refresh],
  );

  return { create, update, remove };
}

import { useCallback } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from '@/shared/toast';
import { CATEGORY_NAMES, type LabelColor, type MailAccount, type MailboxInfo, type MailCategory, type MailLabel, type MailLabels, type MailMessage } from '@/lib/mail';
import { labelsKey, mailboxesKey, openRuleWindow, patchItems, patchUnseen, useMail, type Item, type Source } from './api';
import { blankSeed, draftSeed, formatAddress, forwardSeed, replySeed, type ComposeSeed } from './format';
import { htmlToPlain } from '@/shared/mailCompose';
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
  | 'open-draft'
  | 'assistant'
  | 'block'
  | 'make-rule';

/**
 * Open in Assistant: a new conversation with the message attached, as a
 * file the Assistant writes from what's sent here (its intent `mail.message`,
 * src/apps/assistant/intents.ts), naming where it is for `din mail`.
 */
function openInAssistant(m: MailMessage, item: Item, account: MailAccount | undefined): void {
  const nonce = Date.now();
  const list = (l: MailMessage['to']) => l.map(formatAddress).join(', ');
  window.open(
    appLink('assistant', {
      intent: 'mail.message',
      account: account?.email ?? '',
      mailbox: item.path,
      uid: item.uid,
      subject: m.subject,
      from: list(m.from),
      replyTo: list(m.replyTo),
      to: list(m.to),
      cc: list(m.cc),
      date: m.date,
      // A little over what the Assistant keeps, so it knows to say the rest was cut.
      text: (m.text.trim() || (m.html ? htmlToPlain(m.html) : '')).slice(0, 100_001),
      attachments: m.attachments.filter((a) => !a.inline).map((a) => a.filename).join(', '),
      nonce,
      intentNonce: nonce,
      sessionID: null,
      directory: null,
    }),
  );
}

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
      const own = new Set(accounts.map((a) => a.email.toLowerCase()));
      const isJunk = (i: Item) => qc.getQueryData<MailboxInfo[]>(mailboxesKey(i.accountId))?.find((b) => b.path === i.path)?.special === 'junk';
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
          case 'assistant':
            openInAssistant(await full(first), first, account);
            return;
          case 'make-rule': {
            // From the newest message someone else sent (a conversation holds the user's replies too).
            const theirs = items.filter((i) => !own.has(i.from[0]?.address.toLowerCase() ?? '')).sort((x, y) => y.date - x.date)[0] ?? first;
            const sender = theirs.from[0]?.address.toLowerCase();
            openRuleWindow({ accountId: theirs.accountId, conditions: [sender ? { field: 'from', match: 'is', value: sender } : { field: 'subject', match: 'contains', value: theirs.subject }] });
            return;
          }
          case 'block': {
            // Each account's senders, never the user's own address.
            const senders = new Map<string, { accountId: string; address: string }>();
            for (const i of items) {
              const address = i.from[0]?.address.toLowerCase();
              if (address && !own.has(address)) senders.set(`${i.accountId}\u0000${address}`, { accountId: i.accountId, address });
            }
            if (!senders.size) return;
            for (const s of senders.values()) await mail.block(s.accountId, s.address);
            // What they sent that's here goes to Junk now, as what they send will.
            const theirs = items.filter((i) => senders.has(`${i.accountId}\u0000${i.from[0]?.address.toLowerCase()}`) && !isJunk(i));
            if (theirs.length) {
              const gone = new Set(theirs.map((i) => i.key));
              onRemoved(gone);
              patchItems(qc, gone, null);
              for (const g of byMailbox(theirs).values()) await mail.move(g.accountId, g.path, g.uids, { special: 'junk' });
            }
            const names = [...new Set([...senders.values()].map((s) => s.address))];
            toast(names.length === 1 ? `Blocked ${names[0]}` : `Blocked ${names.length} senders`, {
              body: 'Their mail goes to Junk from now on. Unblock them in Settings → Rules.',
            });
            void qc.invalidateQueries({ queryKey: ['mail', 'rules'] });
            return;
          }
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

  /**
   * Send these inbox messages' senders to a tab: the mail they've sent
   * there and what they send. `leaving`: they're shown in another tab, so
   * they go from the list.
   */
  const moveToTab = useCallback(
    async (items: Item[], tab: MailCategory, leaving: boolean) => {
      if (!mail) return;
      const inbox = items.filter((i) => i.path.toUpperCase() === 'INBOX' && i.from[0]?.address);
      const senders = new Map<string, { accountId: string; address: string }>();
      for (const i of inbox) {
        const address = i.from[0].address.toLowerCase();
        senders.set(`${i.accountId}\u0000${address}`, { accountId: i.accountId, address });
      }
      if (!senders.size) return;
      if (leaving) {
        const keys = new Set(inbox.map((i) => i.key));
        onRemoved(keys);
        patchItems(qc, keys, null);
      }
      try {
        for (const s of senders.values()) await mail.setTabRule(s.accountId, s.address, tab);
        const addresses = [...new Set([...senders.values()].map((s) => s.address))];
        const gmail = [...senders.values()].some((s) => qc.getQueryData<MailLabels>(labelsKey(s.accountId))?.kind === 'gmail');
        toast(addresses.length === 1 ? `Mail from ${addresses[0]} goes to ${CATEGORY_NAMES[tab]}` : `Mail from ${addresses.length} senders goes to ${CATEGORY_NAMES[tab]}`, {
          body: gmail ? 'What they’ve sent and what they send, here in Din (Gmail’s web page and app keep their own tabs).' : 'What they’ve sent and what they send.',
        });
      } catch (error) {
        fail('Mail couldn’t move that', error);
      }
      void qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'tab-counts'] });
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

  return { run, moveTo, setLabel, moveToTab, markAllRead, newMessage, compose };
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

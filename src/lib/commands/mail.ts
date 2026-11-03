import { getMailDesktopBridge, LABEL_COLORS, UNSUBSCRIBE_METHODS, type LabelColor, type LabelKind, type MailAccount, type MailLabel, type MailSubscription } from '@/lib/mail';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din mail`: Mail's accounts, their labels, and the mailing lists in their
 * inboxes, as Mail's Subscriptions shows them (electron/mail.mts), and
 * leaving them. Unsubscribing asks on screen first: it sends mail or
 * requests from the user's account, and can't be taken back; so does
 * deleting a label, which comes off every message.
 */

const mail = () => need(getMailDesktopBridge(), 'Mail');
const ACCOUNT: Param = { name: 'account', type: 'string', optional: true, help: 'Which account, by name or address (default: every account)' };
const MONTHS: Param = { name: 'months', type: 'integer', optional: true, min: 1, max: 240, help: 'How far back to look in the inbox (default: 6)' };

async function accountsFor(query: string | undefined): Promise<MailAccount[]> {
  const list = await call(mail().accounts());
  if (!list.length) throw new CommandError('No mail accounts yet; add one in Mail');
  return query ? [pick(list, query, (a) => [a.id, a.name, a.email], 'account')] : list;
}

async function subscriptions(accounts: MailAccount[], months: number): Promise<MailSubscription[]> {
  const scans = await Promise.all(accounts.map((a) => call(mail().subscriptions(a.id, { months }))));
  return scans.flatMap((s) => s.subscriptions).sort((x, y) => y.count - x.count || y.last - x.last);
}

/** One account, by name or address; the only one when there's one. */
async function oneAccount(query: string | undefined): Promise<MailAccount> {
  const list = await accountsFor(query);
  if (list.length > 1) throw new CommandError('Say which account, with --account', 'usage');
  return list[0];
}

const LABEL_KINDS: Record<LabelKind, string> = { gmail: 'Gmail’s labels', keywords: 'IMAP keywords', none: 'can’t keep labels' };
const COLOR: Param = { name: 'color', type: 'string', optional: true, choices: LABEL_COLORS, help: 'Its color, kept on this computer' };

async function labelIn(account: MailAccount, query: string): Promise<MailLabel> {
  const { kind, labels } = await call(mail().labels(account.id));
  if (kind === 'none') throw new CommandError(`${account.name}’s server can’t keep labels`);
  return pick(labels, query, (l) => [l.id, l.name], 'label');
}

function label(s: MailSubscription): string {
  return s.name ? `${s.name} <${s.address}>` : s.address;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const mailArea: Area = {
  name: 'mail',
  summary: 'Mail’s accounts, marking a mailbox read, senders’ pictures, labels (list, make, edit, delete), and the mailing lists in their inboxes: list them, unsubscribe',
  commands: [
    command('mail', 'accounts', 'The mail accounts Mail has', [], async () => {
      const list = await call(mail().accounts());
      return {
        data: list.map((a) => ({ id: a.id, name: a.name, email: a.email })),
        text: list.length ? list.map((a) => `${a.name}  ${a.email}`).join('\n') : 'No mail accounts yet; add one in Mail',
      };
    }),
    command('mail', 'subscriptions', 'The mailing lists in the inbox, most mail first, as Mail’s Subscriptions shows them', [ACCOUNT, MONTHS], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const list = await subscriptions(accounts, args.optNumber('months') ?? 6);
      const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
      return {
        data: list,
        text: list.length
          ? list
              .map((s) => {
                const notes = [
                  UNSUBSCRIBE_METHODS[s.method],
                  !s.verified && 'unverified',
                  s.unsubscribed && (s.since ? `still mailing: ${s.since} since unsubscribing` : `unsubscribed ${day(s.unsubscribed)}`),
                  accounts.length > 1 && name(s.accountId),
                ].filter(Boolean);
                return `${String(s.count).padStart(4)}  ${label(s)}  (last ${day(s.last)}; ${notes.join(', ')})`;
              })
              .join('\n')
          : 'No mailing lists in the inbox',
      };
    }),
    command('mail', 'mark-read', 'Mark every message in a mailbox read, as Mail’s Mark All as Read does (asks on screen first)', [
      { name: 'mailbox', type: 'string', positional: true, optional: true, help: 'Which mailbox, by name or path (default: the inbox)' },
      ACCOUNT,
    ], async (args, ctx) => {
      const accounts = await accountsFor(args.optString('account'));
      const query = args.optString('mailbox');
      const targets = [];
      for (const a of accounts) {
        const boxes = (await call(mail().mailboxes(a.id))).filter((b) => b.selectable);
        const box = query ? pick(boxes, query, (b) => [b.path, b.name, b.special ?? ''], 'mailbox') : boxes.find((b) => b.special === 'inbox');
        if (box) targets.push({ account: a, box });
      }
      const unseen = targets.reduce((n, t) => n + t.box.unseen, 0);
      if (!unseen) return { data: { marked: 0 }, text: 'Nothing unread there' };
      const where = targets.map((t) => (accounts.length > 1 ? `${t.box.name} (${t.account.name})` : t.box.name)).join(', ');
      const ok = await ctx.confirm({
        title: `Mark ${unseen.toLocaleString()} ${unseen === 1 ? 'message' : 'messages'} in ${where} as read?`,
        description: 'They’re marked read on the server too, and there’s no undoing it all at once.',
        action: 'Mark as Read',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      let marked = 0;
      for (const t of targets) marked += await call(mail().markAllRead(t.account.id, t.box.path));
      return { data: { marked }, text: `Marked ${marked.toLocaleString()} ${marked === 1 ? 'message' : 'messages'} read` };
    }),
    command('mail', 'pictures', 'Whether Mail looks up senders’ pictures from their domain (NIP-05 profile or BIMI logo), as its Settings switch does; with on or off, turn it on or off', [
      { name: 'state', type: 'string', positional: true, optional: true, help: 'on or off' },
    ], async (args) => {
      const state = args.optString('state');
      if (state !== undefined) {
        if (state !== 'on' && state !== 'off') throw new CommandError('Say on or off', 'usage');
        await call(mail().setAvatarLookups(state === 'on'));
      }
      const on = await call(mail().avatarLookups());
      return { data: { lookups: on }, text: on ? 'Mail looks up senders’ pictures' : 'Mail doesn’t look up senders’ pictures' };
    }),
    command('mail', 'labels', 'Each account’s labels, as Mail’s sidebar lists them, and how the account keeps them (Gmail’s own labels, or IMAP keywords)', [ACCOUNT], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const all = await Promise.all(accounts.map(async (a) => ({ account: a, ...(await call(mail().labels(a.id))) })));
      return {
        data: all.map(({ account, kind, labels }) => ({ accountId: account.id, account: account.name, kind, labels })),
        text: all
          .map(({ account, kind, labels }) => {
            const head = `${account.name} (${LABEL_KINDS[kind]})`;
            if (kind === 'none') return head;
            return [head, ...(labels.length ? labels.map((l) => `  ${l.name}${l.color ? `  ${l.color}` : ''}`) : ['  No labels yet'])].join('\n');
          })
          .join('\n'),
      };
    }),
    command('mail', 'label-create', 'Make a label, as Mail’s New Label… does (on Gmail, a Gmail label)', [
      { name: 'name', type: 'string', positional: true, help: 'Its name' },
      COLOR,
      ACCOUNT,
    ], async (args) => {
      const account = await oneAccount(args.optString('account'));
      const made = await call(mail().createLabel(account.id, { name: args.string('name'), color: (args.optString('color') as LabelColor | undefined) ?? null }));
      return { data: made, text: `Made the label ${made.name} in ${account.name}` };
    }),
    command('mail', 'label-edit', 'Rename a label or change its color, as Mail’s Edit Label… does (a Gmail label is renamed on Gmail too)', [
      { name: 'label', type: 'string', positional: true, help: 'Which label, by name' },
      { name: 'name', type: 'string', optional: true, help: 'Its new name' },
      COLOR,
      ACCOUNT,
    ], async (args) => {
      const name = args.optString('name');
      const color = args.optString('color') as LabelColor | undefined;
      if (name === undefined && color === undefined) throw new CommandError('Give it a --name or a --color', 'usage');
      const account = await oneAccount(args.optString('account'));
      const was = await labelIn(account, args.string('label'));
      const saved = await call(mail().updateLabel(account.id, was.id, { ...(name !== undefined ? { name } : {}), ...(color ? { color } : {}) }));
      return { data: saved, text: saved.name === was.name ? `${saved.name} is ${saved.color ?? 'its own color'}` : `Renamed ${was.name} to ${saved.name}` };
    }),
    command('mail', 'label-delete', 'Delete a label, taking it off every message that has it (asks on screen first); the messages stay', [
      { name: 'label', type: 'string', positional: true, help: 'Which label, by name' },
      ACCOUNT,
    ], async (args, ctx) => {
      const account = await oneAccount(args.optString('account'));
      const target = await labelIn(account, args.string('label'));
      const gmail = !!target.path;
      const ok = await ctx.confirm({
        title: `Delete the label “${target.name}”?`,
        description: gmail
          ? 'Gmail takes it off every message that has it, on all your devices. The messages themselves stay.'
          : 'It comes off every message that has it, in every mailbox on the server. The messages themselves stay.',
        action: 'Delete Label',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(mail().deleteLabel(account.id, target.id));
      return { data: { deleted: target.id }, text: `Deleted the label ${target.name}` };
    }),
    command('mail', 'unsubscribe', 'Unsubscribe from mailing lists, as Subscriptions does (asks on screen first)', [
      { name: 'lists', type: 'string', positional: true, rest: true, help: 'Senders, by name, address or list id (as din mail subscriptions lists them)' },
      ACCOUNT,
      MONTHS,
      { name: 'trash', type: 'boolean', optional: true, help: 'Also move their mail in the inbox to the Trash' },
    ], async (args, ctx) => {
      const queries = args.list('lists').map((q) => q.trim()).filter(Boolean);
      if (!queries.length) throw new CommandError('Say which lists', 'usage');
      const accounts = await accountsFor(args.optString('account'));
      const list = await subscriptions(accounts, args.optNumber('months') ?? 6);
      const chosen = [...new Set(queries.map((q) => pick(list, q, (s) => [s.id, s.address, s.name, s.listId], 'mailing list')))];
      const trash = args.optBool('trash') === true;
      const unverified = chosen.filter((s) => !s.verified).length;
      const ok = await ctx.confirm({
        title: chosen.length === 1 ? `Unsubscribe from ${chosen[0].name || chosen[0].address}?` : `Unsubscribe from ${chosen.length} mailing lists?`,
        description: [
          chosen.map(label).join(', ') + '.',
          unverified ? `${unverified === chosen.length ? (chosen.length === 1 ? 'Its sender' : 'None of their senders') : `${unverified} of their senders`} couldn’t be checked as who they say.` : '',
          trash ? 'Their mail in the inbox moves to the Trash.' : '',
        ].filter(Boolean).join(' '),
        action: 'Unsubscribe',
        destructive: trash,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const results = [];
      for (const a of accounts) {
        const ids = chosen.filter((s) => s.accountId === a.id).map((s) => s.id);
        if (ids.length) results.push(...(await call(mail().unsubscribe(a.id, ids, { trash }))).map((r) => ({ ...r, accountId: a.id })));
      }
      const by = (id: string) => chosen.find((s) => s.id === id);
      return {
        data: results,
        text: results
          .map((r) => {
            const s = by(r.id);
            const who = s ? label(s) : r.id;
            const trashed = r.trashed ? `; ${r.trashed} moved to the Trash` : '';
            if (r.status === 'done') return `Unsubscribed from ${who} (${r.method === 'email' ? 'by email' : 'one click'})${trashed}`;
            if (r.status === 'page') return `${who} needs its web page to finish: ${r.url}${trashed}`;
            return `Couldn’t unsubscribe from ${who}: ${r.error ?? 'it failed'}${trashed}`;
          })
          .join('\n'),
      };
    }),
  ],
};

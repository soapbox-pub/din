import { getMailDesktopBridge, UNSUBSCRIBE_METHODS, type MailAccount, type MailSubscription } from '@/lib/mail';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din mail`: Mail's accounts and the mailing lists in their inboxes, as
 * Mail's Subscriptions shows them (electron/mail.mts), and leaving them.
 * Unsubscribing asks on screen first: it sends mail or requests from the
 * user's account, and can't be taken back.
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

function label(s: MailSubscription): string {
  return s.name ? `${s.name} <${s.address}>` : s.address;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const mailArea: Area = {
  name: 'mail',
  summary: 'Mail’s accounts, and the mailing lists in their inboxes: list them, unsubscribe',
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

import { formatBytes, getFsBridge } from '@/lib/fs';
import { mimeOf } from '@/lib/mime';
import { blankSeed, outgoingMessage, parseAddresses, recipientsProblem, replySeed, writtenAbove, type ComposeSeed } from '@/shared/mailCompose';
import { CATEGORY_NAMES, getMailDesktopBridge, isMailCategory, LABEL_COLORS, MAIL_CATEGORIES, UNSUBSCRIBE_METHODS, type InboxTabs, type LabelColor, type LabelKind, type MailAccount, type MailAddress, type MailAttachment, type MailboxInfo, type MailLabel, type MailSubscription, type MessageSummary } from '@/lib/mail';
import { markRead, markReadTargets } from '@/lib/mailInbox';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din mail`: Mail's accounts, their mailboxes and messages (listed,
 * searched and read as Mail opens them, which leaves them unread, and
 * sent and replied to as its compose window sends them), their labels, their inboxes' tabs and the
 * senders moved between them, and the mailing lists in their inboxes, as
 * Mail's Subscriptions shows them (electron/mail.mts), and leaving them.
 * Sending and replying send straight away, since whoever runs them was asked
 * to; with --compose they open Mail's compose window filled in instead, for
 * the user to send. Unsubscribing asks on screen first: it sends requests
 * from the user's account, and can't be taken back; so does deleting a
 * label, which comes off every message.
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
  if (kind === 'none') throw new CommandError(`${account.email}’s server can’t keep labels`);
  return pick(labels, query, (l) => [l.id, l.name], 'label');
}

function label(s: MailSubscription): string {
  return s.name ? `${s.name} <${s.address}>` : s.address;
}

function tabsText(t: InboxTabs): string {
  if (!t.tabs.length) return 'The inbox has no tabs; all new mail notifies';
  const names = ['primary' as const, ...t.tabs].map((c) => CATEGORY_NAMES[c]).join(', ');
  return `Inbox tabs: ${names}; ${t.notify === 'primary' ? 'only Primary’s new mail notifies' : 'all new mail notifies'}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const MAILBOX: Param = { name: 'mailbox', type: 'string', optional: true, help: 'Which mailbox, by name or path, as din mail mailboxes lists them (default: the inbox)' };

/** An account's mailbox, by name, path or kind (sent, trash…), else its inbox. */
async function mailboxIn(account: MailAccount, query: string | undefined): Promise<MailboxInfo> {
  const boxes = (await call(mail().mailboxes(account.id))).filter((b) => b.selectable);
  if (query) return pick(boxes, query, (b) => [b.path, b.name, b.special ?? ''], 'mailbox');
  const inbox = boxes.find((b) => b.special === 'inbox');
  if (!inbox) throw new CommandError(`${account.email} has no inbox`);
  return inbox;
}

function who(list: MailAddress[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

/** A message's date as a list shows it: the time today, the day this year, else the date. */
function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return day(ms);
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The most a message's attachments come to, as most servers take. */
const ATTACH_MAX = 25 * 1024 * 1024;

const WRITTEN: Param[] = [
  { name: 'text', type: 'string', optional: true, help: 'What to write (blank lines between paragraphs)' },
  { name: 'text-file', type: 'path', optional: true, help: 'A text file to write it from, instead of --text' },
  { name: 'files', type: 'path', positional: true, optional: true, rest: true, help: 'Files to attach' },
];

/** What's written, from --text or --text-file. */
async function writtenText(args: { optString(name: string): string | undefined }): Promise<string> {
  const text = args.optString('text');
  const file = args.optString('text-file');
  if (text !== undefined && file !== undefined) throw new CommandError('Say --text or --text-file, not both', 'usage');
  if (file === undefined) return text ?? '';
  const read = await call(need(getFsBridge(), 'Files').readFile(file, 4 * 1024 * 1024));
  if (read.truncated) throw new CommandError('That text file is too big');
  return new TextDecoder().decode(read.data);
}

async function attachments(paths: string[]): Promise<MailAttachment[]> {
  if (!paths.length) return [];
  const fs = need(getFsBridge(), 'Files');
  const out: MailAttachment[] = [];
  let total = 0;
  for (const path of paths) {
    const read = await call(fs.readFile(path, ATTACH_MAX - total + 1));
    total += read.data.byteLength;
    if (read.truncated || total > ATTACH_MAX) throw new CommandError(`The attachments come to more than ${formatBytes(ATTACH_MAX)}`);
    const filename = path.split('/').pop() || 'Attachment';
    out.push({ filename, contentType: mimeOf(filename) || 'application/octet-stream', content: read.data });
  }
  return out;
}

const COMPOSE: Param = { name: 'compose', type: 'boolean', optional: true, help: 'Open it in Mail’s New Message window, filled in, for the user to finish and send, instead of sending it' };

/**
 * Open it in Mail's compose window, as its Reply or New Message would, with
 * what's written above the signature and any quote; nothing is sent.
 */
function composeWritten(ctx: CommandContext, account: MailAccount, seed: ComposeSeed, text: string, files: string[]): { data: unknown; text: string } {
  if (files.length) throw new CommandError('Files can’t be attached to an open message from here; attach them in its window, or send it without --compose', 'usage');
  ctx.actions.open('mail', { compose: seed, ...(text.trim() ? { text } : {}) });
  return {
    data: { opened: true, accountId: account.id, to: seed.to, cc: seed.cc, bcc: seed.bcc, subject: seed.subject },
    text: `Opened “${seed.subject || '(no subject)'}” in Mail’s compose window, for you to send`,
  };
}

/** Send it as Mail's Send does: the user asked for it, so nothing asks again. */
async function sendWritten(
  account: MailAccount,
  seed: ComposeSeed,
  text: string,
  files: MailAttachment[],
): Promise<{ data: unknown; text: string }> {
  const everyone = [...seed.to, ...seed.cc, ...seed.bcc];
  const problem = recipientsProblem(everyone);
  if (problem) throw new CommandError(problem.replace(/\.$/, ''), 'usage');
  const message = outgoingMessage(seed, writtenAbove(seed, account, text), files, seed, null);
  await call(mail().send(account.id, message));
  return {
    data: { sent: true, accountId: account.id, to: seed.to, cc: seed.cc, bcc: seed.bcc, subject: message.subject, attachments: files.map((f) => f.filename) },
    text: `Sent “${message.subject || '(no subject)'}” to ${who(everyone)}`,
  };
}

/** The text of an HTML-only message, for reading on the command line; parsing it runs nothing. */
function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, head, title').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
  doc.querySelectorAll('p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote').forEach((el) => el.append('\n'));
  return (doc.body?.textContent ?? '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const mailArea: Area = {
  name: 'mail',
  summary: 'Mail’s accounts (their colors, and whether codes in their mail are filled in), their mailboxes and messages (list, search, read, send, reply), marking a mailbox read, senders’ pictures, labels (list, make, edit, delete), the inbox’s tabs and which new mail notifies, moving senders between tabs, and the mailing lists in their inboxes: list them, unsubscribe',
  commands: [
    command('mail', 'accounts', 'The mail accounts Mail has', [], async () => {
      const list = await call(mail().accounts());
      return {
        data: list.map((a) => ({ id: a.id, email: a.email, color: a.color ?? null })),
        text: list.length ? list.map((a) => (a.color ? `${a.email}  ${a.color}` : a.email)).join('\n') : 'No mail accounts yet; add one in Mail',
      };
    }),
    command('mail', 'account-color', 'Give an account its color in Mail, the dot that marks its mail in All Inboxes and its address in the sidebar, as Mail’s Color menu does; auto gives back the one Mail picks', [
      { name: 'account', type: 'string', positional: true, help: 'Which account, by address' },
      { name: 'color', type: 'string', positional: true, choices: [...LABEL_COLORS, 'auto'], help: 'Its color, or auto' },
    ], async (args) => {
      const [account] = await accountsFor(args.string('account'));
      const color = args.string('color');
      const saved = await call(mail().setAccountColor(account.id, color === 'auto' ? null : (color as LabelColor)));
      return { data: { id: saved.id, email: saved.email, color: saved.color ?? null }, text: saved.color ? `${saved.email} is ${saved.color}` : `${saved.email} has the color Mail picks` };
    }),
    command('mail', 'fill-codes', 'Whether the Web Browser offers the verification codes in an account’s new mail in pages’ code fields, as Mail’s Fill in verification codes does', [
      { name: 'account', type: 'string', positional: true, help: 'Which account, by address' },
      { name: 'state', type: 'string', positional: true, optional: true, help: 'on or off (leave out to see which)' },
    ], async (args) => {
      const [account] = await accountsFor(args.string('account'));
      const state = args.optString('state');
      if (state === undefined) {
        const on = account.fillCodes !== false;
        return { data: { id: account.id, email: account.email, fillCodes: on }, text: `Filling in codes from ${account.email}’s mail is ${on ? 'on' : 'off'}` };
      }
      if (state !== 'on' && state !== 'off') throw new CommandError('Say on or off', 'usage');
      const saved = await call(mail().setFillCodes(account.id, state === 'on'));
      return { data: { id: saved.id, email: saved.email, fillCodes: saved.fillCodes !== false }, text: `Filling in codes from ${saved.email}’s mail is ${state}` };
    }),
    command('mail', 'mailboxes', 'Each account’s mailboxes, as Mail’s sidebar lists them, with how many messages each has and how many are unread', [ACCOUNT], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const all = await Promise.all(accounts.map(async (a) => ({ account: a, boxes: (await call(mail().mailboxes(a.id))).filter((b) => b.selectable) })));
      return {
        data: all.map(({ account, boxes }) => ({ accountId: account.id, account: account.email, mailboxes: boxes })),
        text: all
          .map(({ account, boxes }) => [
            account.email,
            ...boxes.map((b) => `  ${b.path}${b.name !== b.path ? `  (${b.name})` : ''}  ${b.total.toLocaleString()}${b.unseen ? `, ${b.unseen.toLocaleString()} unread` : ''}`),
          ].join('\n'))
          .join('\n'),
      };
    }),
    command('mail', 'messages', 'The messages in a mailbox (the inbox by default), newest first, as Mail lists them: all of them, or those a search finds, the unread or the flagged ones, or an inbox tab’s', [
      { name: 'search', type: 'string', positional: true, optional: true, help: 'Words to look for, as Mail’s search does (sender, recipients, subject and text)' },
      MAILBOX,
      ACCOUNT,
      { name: 'unread', type: 'boolean', optional: true, help: 'Only unread messages' },
      { name: 'flagged', type: 'boolean', optional: true, help: 'Only flagged messages' },
      { name: 'tab', type: 'string', optional: true, choices: MAIL_CATEGORIES, help: 'Only an inbox tab’s messages, as Mail’s tabs show them' },
      { name: 'limit', type: 'integer', optional: true, min: 1, max: 200, help: 'How many (default: 20)' },
      { name: 'before', type: 'integer', optional: true, min: 1, help: 'Older than this message, by its number, for the next page' },
    ], async (args) => {
      const unread = args.optBool('unread') === true;
      const flagged = args.optBool('flagged') === true;
      if (unread && flagged) throw new CommandError('Say --unread or --flagged, not both', 'usage');
      const tab = args.optString('tab');
      const query = args.optString('search')?.trim() || undefined;
      const limit = args.optNumber('limit') ?? 20;
      const before = args.optNumber('before');
      const accounts = await accountsFor(args.optString('account'));
      if (before !== undefined && accounts.length > 1) throw new CommandError('Say which account, with --account, to page with --before', 'usage');
      const pages = await Promise.all(accounts.map(async (account) => {
        const box = await mailboxIn(account, args.optString('mailbox'));
        if (tab && box.special !== 'inbox') throw new CommandError('Only the inbox has tabs', 'usage');
        const page = await call(mail().messages(account.id, box.path, {
          limit,
          before,
          query,
          filter: unread ? 'unread' : flagged ? 'flagged' : null,
          category: isMailCategory(tab) ? tab : undefined,
        }));
        return { account, box, page };
      }));
      const rows = pages
        .flatMap(({ account, box, page }) => page.messages.map((m) => ({ account, box, m })))
        .sort((x, y) => y.m.date - x.m.date)
        .slice(0, limit);
      const several = accounts.length > 1;
      const row = ({ account, m }: { account: MailAccount; m: MessageSummary }) => {
        const marks = `${m.seen ? ' ' : '•'}${m.flagged ? '⚑' : ' '}${m.hasAttachments ? '📎' : '  '}`;
        const from = m.from[0] ? m.from[0].name || m.from[0].address : '(no sender)';
        return `${String(m.uid).padStart(7)} ${marks} ${when(m.date).padEnd(12)}  ${from}  ${m.subject || '(no subject)'}${several ? `  (${account.email})` : ''}`;
      };
      const more = pages.filter((p) => p.page.more);
      const foot = more.length === 1 && !several ? `\nOlder: --before ${more[0].page.next ?? more[0].page.messages.at(-1)?.uid}` : '';
      const head = pages.map(({ account, box, page }) => `${several ? `${account.email}: ` : ''}${box.name}, ${page.total.toLocaleString()} ${query ? 'found' : unread ? 'unread' : flagged ? 'flagged' : page.total === 1 ? 'message' : 'messages'}`).join('; ');
      return {
        data: {
          mailboxes: pages.map(({ account, box, page }) => ({ accountId: account.id, account: account.email, mailbox: box.path, total: page.total, more: page.more, next: page.next ?? page.messages.at(-1)?.uid ?? null })),
          messages: rows.map(({ account, box, m }) => ({ accountId: account.id, mailbox: box.path, ...m })),
        },
        text: rows.length ? `${head}\n${rows.map(row).join('\n')}${foot}` : `${head}: nothing there`,
      };
    }),
    command('mail', 'read', 'Read a message, as Mail opens it: who it’s from and to, its date, subject, text and attachments; it stays unread', [
      { name: 'message', type: 'integer', positional: true, min: 1, help: 'Which message, by its number, as din mail messages lists it' },
      MAILBOX,
      ACCOUNT,
      { name: 'html', type: 'boolean', optional: true, help: 'Its HTML as it came, rather than its text' },
    ], async (args) => {
      const account = await oneAccount(args.optString('account'));
      const box = await mailboxIn(account, args.optString('mailbox'));
      const m = await call(mail().message(account.id, box.path, args.number('message')));
      const html = args.optBool('html') === true;
      const plain = m.text.trim() || (m.html ? htmlText(m.html) : '');
      const body = html ? (m.html ?? plain) : plain;
      const listed = m.attachments.filter((a) => !a.inline);
      const head = [
        `From: ${who(m.from) || '(no sender)'}${m.senderVerified ? '' : m.senderVerified === false ? '  (unverified)' : ''}`,
        m.replyTo.length ? `Reply-To: ${who(m.replyTo)}` : '',
        `To: ${who(m.to)}`,
        m.cc.length ? `Cc: ${who(m.cc)}` : '',
        m.bcc.length ? `Bcc: ${who(m.bcc)}` : '',
        `Date: ${new Date(m.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}`,
        `Subject: ${m.subject || '(no subject)'}`,
        listed.length ? `Attachments: ${listed.map((a) => `${a.filename} (${formatBytes(a.size)})`).join(', ')}` : '',
      ].filter(Boolean);
      const { html: rawHtml, ...rest } = m;
      return {
        data: { accountId: account.id, mailbox: box.path, ...rest, text: plain, ...(html ? { html: rawHtml } : {}) },
        text: `${head.join('\n')}\n\n${body || '(no text)'}`,
      };
    }),
    command('mail', 'send', 'Send a message, as Mail’s Send does, signed with the account’s signature and kept in Sent; with --compose, open it in Mail’s New Message window instead, for the user to send', [
      { name: 'to', type: 'string', optional: true, help: 'Who to, as Mail’s To field takes them: addresses, or Name <address>, separated by commas (with --compose, it can be left for the user)' },
      { name: 'cc', type: 'string', optional: true, help: 'Who to copy, the same way' },
      { name: 'bcc', type: 'string', optional: true, help: 'Who to copy unseen, the same way' },
      { name: 'subject', type: 'string', optional: true, help: 'Its subject' },
      ...WRITTEN,
      { name: 'account', type: 'string', optional: true, help: 'Which account to send from, by name or address (default: the only one)' },
      COMPOSE,
    ], async (args, ctx) => {
      const account = await oneAccount(args.optString('account'));
      const compose = args.optBool('compose') === true;
      const to = args.optString('to');
      if (to === undefined && !compose) throw new CommandError('Say who to, with --to', 'usage');
      const seed: ComposeSeed = {
        ...blankSeed(account.id),
        to: parseAddresses(to ?? ''),
        cc: parseAddresses(args.optString('cc') ?? ''),
        bcc: parseAddresses(args.optString('bcc') ?? ''),
        subject: args.optString('subject') ?? '',
      };
      const text = await writtenText(args);
      if (compose) return composeWritten(ctx, account, seed, text, args.list('files'));
      const files = await attachments(args.list('files'));
      if (!text.trim() && !seed.subject.trim() && !files.length) throw new CommandError('Give it a --subject, some --text or a file', 'usage');
      return sendWritten(account, seed, text, files);
    }),
    command('mail', 'reply', 'Reply to a message, as Mail’s Reply does: to its sender (everyone with --all), in its conversation, quoting it, and marking it answered; with --compose, open the reply in Mail’s compose window instead, for the user to send', [
      { name: 'message', type: 'integer', positional: true, min: 1, help: 'Which message, by its number, as din mail messages lists it' },
      ...WRITTEN,
      COMPOSE,
      { name: 'all', type: 'boolean', optional: true, help: 'Reply to everyone it went to, as Reply All does' },
      { name: 'cc', type: 'string', optional: true, help: 'Others to copy, as Mail’s Cc field takes them' },
      { name: 'bcc', type: 'string', optional: true, help: 'Others to copy unseen, the same way' },
      MAILBOX,
      ACCOUNT,
    ], async (args, ctx) => {
      const account = await oneAccount(args.optString('account'));
      const box = await mailboxIn(account, args.optString('mailbox'));
      const original = await call(mail().message(account.id, box.path, args.number('message')));
      const text = await writtenText(args);
      const compose = args.optBool('compose') === true;
      if (!text.trim() && !compose) throw new CommandError('Say what to reply, with --text or --text-file', 'usage');
      const seed = replySeed(original, account.id, box.path, account, args.optBool('all') === true);
      const taken = new Set([...seed.to, ...seed.cc].map((a) => a.address.toLowerCase()));
      const extra = (field: string) => parseAddresses(args.optString(field) ?? '').filter((a) => !taken.has(a.address.toLowerCase()));
      const full = { ...seed, cc: [...seed.cc, ...extra('cc')], bcc: extra('bcc') };
      if (compose) return composeWritten(ctx, account, full, text, args.list('files'));
      return sendWritten(account, full, text, await attachments(args.list('files')));
    }),
    command('mail', 'subscriptions', 'The mailing lists in the inbox, most mail first, as Mail’s Subscriptions shows them', [ACCOUNT, MONTHS], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const list = await subscriptions(accounts, args.optNumber('months') ?? 6);
      const name = (id: string) => accounts.find((a) => a.id === id)?.email ?? id;
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
      const targets = await call(markReadTargets(accounts, query ? (boxes) => pick(boxes, query, (b) => [b.path, b.name, b.special ?? ''], 'mailbox') : undefined));
      const unseen = targets.reduce((n, t) => n + t.box.unseen, 0);
      if (!unseen) return { data: { marked: 0 }, text: 'Nothing unread there' };
      const where = targets.map((t) => (accounts.length > 1 ? `${t.box.name} (${t.account.email})` : t.box.name)).join(', ');
      const ok = await ctx.confirm({
        title: `Mark ${unseen.toLocaleString()} ${unseen === 1 ? 'message' : 'messages'} in ${where} as read?`,
        description: 'They’re marked read on the server too, and there’s no undoing it all at once.',
        action: 'Mark as Read',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const marked = await call(markRead(targets));
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
    command('mail', 'tabs', 'Which of Gmail’s inbox tabs Mail shows besides Primary, as Settings → General does; name some to show just those, or say off for none', [
      { name: 'tabs', type: 'string', positional: true, rest: true, optional: true, help: `Tabs to show: ${MAIL_CATEGORIES.filter((c) => c !== 'primary').join(', ')}, or off` },
    ], async (args) => {
      const given = args.list('tabs').map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (given.length) {
        const off = given.length === 1 && (given[0] === 'off' || given[0] === 'none');
        const bad = off ? [] : given.filter((t) => !isMailCategory(t));
        if (bad.length) throw new CommandError(`No tab called ${bad.join(', ')}`, 'usage');
        await call(mail().setInboxTabs({ tabs: off ? [] : (given.filter((t) => isMailCategory(t) && t !== 'primary') as InboxTabs['tabs']) }));
      }
      const now = await call(mail().inboxTabs());
      return { data: now, text: tabsText(now) };
    }),
    command('mail', 'notify', 'Which new mail gets a notification and counts on Mail’s Dock icon: only Primary’s, or all of it, as Settings → General’s Notify only for Primary does', [
      { name: 'which', type: 'string', positional: true, optional: true, choices: ['primary', 'all'], help: 'primary or all' },
    ], async (args) => {
      const which = args.optString('which');
      if (which !== undefined) await call(mail().setInboxTabs({ notify: which === 'all' ? 'all' : 'primary' }));
      const now = await call(mail().inboxTabs());
      return { data: now, text: tabsText(now) };
    }),
    command('mail', 'tab-rules', 'The senders whose mail goes to an inbox tab the user moved it to', [ACCOUNT], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const all = await Promise.all(accounts.map(async (a) => ({ account: a, rules: await call(mail().tabRules(a.id)) })));
      const rows = all.flatMap(({ account, rules }) => Object.entries(rules).map(([address, tab]) => ({ accountId: account.id, account: account.email, address, tab })));
      return {
        data: rows,
        text: rows.length ? rows.map((r) => `${r.address}  ${CATEGORY_NAMES[r.tab]}${accounts.length > 1 ? `  (${r.account})` : ''}`).join('\n') : 'No senders moved to a tab',
      };
    }),
    command('mail', 'move-to-tab', 'Send a sender’s mail (what’s in the inbox and what comes) to an inbox tab, as a message’s Move to Tab does; auto puts it back where it’s sorted', [
      { name: 'sender', type: 'string', positional: true, help: 'Their email address' },
      { name: 'tab', type: 'string', positional: true, choices: [...MAIL_CATEGORIES, 'auto'], help: `${MAIL_CATEGORIES.join(', ')}, or auto` },
      ACCOUNT,
    ], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const sender = args.string('sender').trim().toLowerCase();
      const tab = args.string('tab');
      const to = isMailCategory(tab) ? tab : null;
      for (const a of accounts) await call(mail().setTabRule(a.id, sender, to));
      return { data: { sender, tab: to }, text: to ? `Mail from ${sender} goes to ${CATEGORY_NAMES[to]}` : `Mail from ${sender} is sorted as it comes again` };
    }),
    command('mail', 'labels', 'Each account’s labels, as Mail’s sidebar lists them, and how the account keeps them (Gmail’s own labels, or IMAP keywords)', [ACCOUNT], async (args) => {
      const accounts = await accountsFor(args.optString('account'));
      const all = await Promise.all(accounts.map(async (a) => ({ account: a, ...(await call(mail().labels(a.id))) })));
      return {
        data: all.map(({ account, kind, labels }) => ({ accountId: account.id, account: account.email, kind, labels })),
        text: all
          .map(({ account, kind, labels }) => {
            const head = `${account.email} (${LABEL_KINDS[kind]})`;
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
      return { data: made, text: `Made the label ${made.name} in ${account.email}` };
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

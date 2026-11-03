// Gmail's inbox tabs (Primary, Promotions, Social, Updates, Forums) for
// mail that isn't on Gmail (electron/mail.mts): a guess from a few headers
// of each message, never its body. Gmail sorts its own mail, and Mail asks
// it; the user's rules for a sender win over both.
//
// Mail from a person has none of what's looked for, so it stays in
// Primary. Mail from a social network is Social; a mailing list people
// write to (List-Post) is Forums; automated mail is Promotions when it's
// sent in bulk (List-Unsubscribe, Precedence: bulk), unless it's from a
// service's notifications or reads like a receipt, a shipment or an
// account's security, which is Updates, as is other automated mail.

import type { MailAddress, MailCategory } from '../src/lib/mail.ts';

/** Gmail's tabs, in its order (src/lib/mail.ts's MAIL_CATEGORIES, which main can't import). */
export const CATEGORIES: readonly MailCategory[] = ['primary', 'promotions', 'social', 'updates', 'forums'];

export function isCategory(v: unknown): v is MailCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

/** The headers the sorter reads, as IMAP names them (List-Unsubscribe is fetched for every summary already). */
export const CATEGORY_HEADERS = ['list-id', 'list-post', 'precedence', 'auto-submitted', 'x-auto-response-suppress'];

const SOCIAL = [
  'facebookmail.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'reddit.com', 'redditmail.com',
  'pinterest.com', 'tiktok.com', 'snapchat.com', 'tumblr.com', 'threads.net', 'nextdoor.com', 'quora.com', 'discord.com',
  'youtube.com', 'meetup.com', 'strava.com', 'goodreads.com', 'bsky.app', 'mastodon.social',
];

/** Services whose mail is about the user's own work and accounts. */
const UPDATES = ['github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net', 'linear.app', 'sentry.io', 'slack.com'];

const TRANSACTIONAL_SENDER =
  /^(receipts?|orders?|order-?updates?|invoices?|billing|payments?|shipping|shipments?|delivery|tracking|notifications?|notify|alerts?|security|accounts?|verify|verification|confirm|confirmations?|statements?|support|calendar|reminders?|transactions?|auto-?confirm)([-_.+].*)?$/i;

const TRANSACTIONAL_SUBJECT =
  /\b(receipt|invoice|your order|order (#|no\.?|number|confirm)|(has|have) shipped|shipping (confirmation|update)|out for delivery|delivered|payment (received|confirm|failed)|verification code|security (alert|code)|password|sign[- ]?in|log[- ]?in|statement|reservation|booking|appointment|itinerary)\b/i;

const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)([-_.+].*)?$/i;

function within(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Which tab a message goes in, from its header fields (lowercased, as
 * headerFields gives them), sender and subject.
 */
export function categorize(fields: Map<string, string[]> | null, from: MailAddress | undefined, subject: string): MailCategory {
  const address = (from?.address ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  const local = at > 0 ? address.slice(0, at) : address;
  const domain = at > 0 ? address.slice(at + 1) : '';
  const first = (key: string) => fields?.get(key)?.find((v) => /\S/.test(v))?.trim() ?? '';

  if (within(domain, SOCIAL)) return 'social';
  const listPost = first('list-post');
  if (first('list-id') && listPost && !/^NO\b/i.test(listPost)) return 'forums';
  if (within(domain, UPDATES)) return 'updates';

  const precedence = first('precedence').toLowerCase();
  const auto = first('auto-submitted').toLowerCase();
  const bulk = !!first('list-unsubscribe') || /^(bulk|junk|list)$/.test(precedence);
  const automated = bulk || (!!auto && auto !== 'no') || !!first('x-auto-response-suppress') || NO_REPLY.test(local);
  if (!automated) return 'primary';
  if (TRANSACTIONAL_SENDER.test(local) || TRANSACTIONAL_SUBJECT.test(subject)) return 'updates';
  return bulk ? 'promotions' : 'updates';
}

// Gmail's inbox tabs (Primary, Promotions, Social, Updates, Forums) for
// mail that isn't on Gmail (electron/mail.mts): a guess from a few headers
// of each message, its sender and its subject, never its body. Gmail sorts
// its own mail, and Mail asks it; the user's rules for a sender win over
// both, and mail from someone the user has written to stays in Primary
// (mail.mts's tabOf).
//
// Mail from a person has none of what's looked for, so it stays in
// Primary. Mail from a social network is Social; from a service about the
// user's own work and accounts (GitHub's and the like, whose notifications
// are sent as mailing lists) is Updates; a mailing list people write to
// (List-Post) is Forums. Other mail is automated when it says so (bulk
// headers, Auto-Submitted, a no-reply sender), when its sender is named
// for what machines send (receipts@, notifications@, hello@…), or when it
// comes from a sending host (mail.example.com, em123.example.com). Of the
// automated mail, what reads like a sale is Promotions; what reads like a
// receipt, a shipment or an account's security is Updates, as is what comes
// from a sender named for those; and what's left is Promotions when it's
// marketing (sent in bulk, or by a marketing sender) and else Updates.

import type { MailAddress, MailCategory } from '../src/lib/mail.ts';

/** Gmail's tabs, in its order (src/lib/mail.ts's MAIL_CATEGORIES, which main can't import). */
export const CATEGORIES: readonly MailCategory[] = ['primary', 'promotions', 'social', 'updates', 'forums'];

/**
 * Which version of these rules a kept message's tab was guessed by
 * (MessageSummary.sorted): raised when they change, so the inbox's mail is
 * sorted again.
 */
export const SORTER_VERSION = 2;

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

/** Services whose mail is about the user's own work and accounts, mailing-list headers or not. */
const UPDATES = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net', 'linear.app', 'sentry.io', 'slack.com', 'opencollective.com',
  'notion.so', 'notion.com', 'figma.com', 'vercel.com', 'netlify.com', 'notify.cloudflare.com',
];

/** A sender's name (one word of it) that machines send as, about the user's own orders, accounts and bookings. */
const TRANSACTIONAL_WORDS = new Set([
  'receipt', 'receipts', 'order', 'orders', 'digitalorder', 'invoice', 'invoices', 'billing', 'payment', 'payments', 'shipping',
  'shipment', 'shipments', 'delivery', 'tracking', 'security', 'verify', 'verification', 'confirm', 'confirmation', 'confirmations',
  'autoconfirm', 'statement', 'statements', 'calendar', 'reminder', 'reminders', 'transaction', 'transactions', 'renewal', 'renewals',
  'reservation', 'reservations', 'booking', 'bookings', 'wordpress', 'administrator', 'system', 'mailerdaemon', 'postmaster',
]);

/** One that may be marketing as well: about the user's account when sent one at a time, Promotions when sent in bulk. */
const NOTICE_WORDS = new Set(['notification', 'notifications', 'notify', 'alert', 'alerts', 'support', 'account', 'accounts', 'update', 'updates', 'mail']);

/** One that marketing sends as. */
const MARKETING_WORDS = new Set([
  'news', 'newsletter', 'newsletters', 'marketing', 'promo', 'promos', 'promotions', 'offers', 'deals', 'hello', 'hi', 'sayhello',
  'info', 'team', 'contact', 'shop', 'store', 'email', 'communications', 'events', 'ads',
]);

const NO_REPLY_WORDS = new Set(['noreply', 'donotreply', 'bounce', 'bounces', 'mailerdaemon', 'postmaster']);

/** A sending host's label (any but the domain's own two): mail.example.com, em123.example.com, card.em.example.com. */
const SENDING_HOST = /^(e|em|email|emails|emailinfo|mail|mailer|mailing|mailings|news|newsletter|info|marketing|promo|promomail|message|messages|notify|notification|notifications|alerts|reply|send|engage|go|m|t)\d*$/;

const TRANSACTIONAL_SUBJECT =
  /\b(receipt|invoice|your order|pre-?order|order (#|no\.?|number|confirm)|(has|have) shipped|shipped \d|shipping (confirmation|update)|out for delivery|delivered|payment (of|received|confirm|failed)|(has )?charged|received \$?\d[\d,.]*|\$\d[\d,.]* (from|to|payment|charge)|refund|payment (info|method|details)|action required|alert|invited you|your (\w+ )?(account|card|credit limit)\b|deposit(ed)?|verification code|security (alert|code)|login code|password|sign[- ]?in|log[- ]?in|statements?|reservation|booking|appointment|itinerary|prescription|ready for pickup|(will )?expires? in|expir(ed|ing)|renew(al)?|due (date|on)|overdue|moderate)\b/i;

const PROMO_SUBJECT =
  /(\d+\s?% (off|more|bonus|back)|\$\d+ off|\b(sale|deals?|save (big|up|\d|\$)|savings|last chance|limited time|free shipping|bonus|restock(ed)?|back in stock|exclusive|don['’]t miss|ends (today|tonight|soon)|early bird|new arrivals|shop (now|the)|promo|coupon|discount|black friday|cyber monday|gift (guide|edition)|now open for sale)\b)/i;

/** The words of an address's local part, split at its punctuation: `shipment-tracking` is `shipment`, `tracking`. */
function words(local: string): string[] {
  const parts = local.split(/[-_.+]/).filter(Boolean);
  // `no-reply`, `do-not-reply` and `auto-confirm` are one word each, whichever way they're written.
  const joined = parts.join('');
  return [...parts, joined, ...(joined.includes('noreply') ? ['noreply'] : [])];
}

function within(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** An address machines send from, which nobody reads: no-reply@, mailer-daemon@, reply+…@ (GitHub's and the like). */
export function isAutomatedAddress(address: string): boolean {
  const a = address.toLowerCase();
  const at = a.lastIndexOf('@');
  const local = at > 0 ? a.slice(0, at) : a;
  return /^reply[+.]/.test(local) || words(local).some((w) => NO_REPLY_WORDS.has(w));
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
  if (within(domain, UPDATES)) return 'updates';
  const listPost = first('list-post');
  if (first('list-id') && listPost && !/^NO\b/i.test(listPost)) return 'forums';

  const w = words(local);
  const labels = domain.split('.');
  const sendingHost = labels.slice(0, -2).some((l) => SENDING_HOST.test(l));
  const transactional = w.some((x) => TRANSACTIONAL_WORDS.has(x));
  const notice = w.some((x) => NOTICE_WORDS.has(x));
  const marketing = w.some((x) => MARKETING_WORDS.has(x));
  const precedence = first('precedence').toLowerCase();
  const auto = first('auto-submitted').toLowerCase();
  const bulk = !!first('list-unsubscribe') || /^(bulk|junk|list)$/.test(precedence);
  const automated =
    bulk || (!!auto && auto !== 'no') || !!first('x-auto-response-suppress') || isAutomatedAddress(address) || transactional || notice || marketing || sendingHost;
  if (!automated) return 'primary';
  if (PROMO_SUBJECT.test(subject)) return 'promotions';
  if (TRANSACTIONAL_SUBJECT.test(subject) || transactional) return 'updates';
  if (notice) return bulk ? 'promotions' : 'updates';
  // Marketing is sent with List-Unsubscribe nearly always; what's sent without it is about the user's account.
  return bulk || marketing ? 'promotions' : 'updates';
}

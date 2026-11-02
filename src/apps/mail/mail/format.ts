import type { MailAccount, MailAddress, MailMessage } from '@/lib/mail';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const short = new Intl.DateTimeFormat(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' });
const long = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** As the message list shows it: a time today, Yesterday, a weekday this week, else a date. */
export function listDate(ms: number, now = new Date()): string {
  if (!ms) return '';
  const d = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return time.format(d);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(d);
  return short.format(d);
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** A count kept short: 14k, not 14,123. */
export function shortCount(n: number): string {
  return compact.format(n).toLowerCase();
}

export function fullDate(ms: number): string {
  return ms ? long.format(new Date(ms)) : '';
}

export function displayName(a: MailAddress | undefined): string {
  if (!a) return '';
  return a.name.trim() || a.address;
}

export function addressLine(list: MailAddress[]): string {
  return list.map(displayName).join(', ');
}

/** "Name <address>", for headers and quoting. */
export function formatAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function initials(a: MailAddress | undefined): string {
  const name = (a?.name || a?.address.split('@')[0] || '?').replace(/["'()[\]]/g, '').trim();
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 1);
  return letters.toUpperCase();
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const re = prefix === 'Re' ? /^\s*(re|aw|sv|antw)\s*:/i : /^\s*(fwd?|wg|tr)\s*:/i;
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

/** What a compose window starts with. */
export interface ComposeSeed {
  accountId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** The editor's starting content (a quote, a draft). */
  html: string;
  inReplyTo: string | null;
  references: string[];
  answering: { path: string; uid: number } | null;
  /** Attachments to bring along from another message (forwarding). */
  forwardFrom: { accountId: string; path: string; uid: number; indexes: number[] } | null;
  /** The draft in Drafts this continues. */
  draftUid: number | null;
}

export function blankSeed(accountId: string | null): ComposeSeed {
  return { accountId, to: [], cc: [], bcc: [], subject: '', html: '', inReplyTo: null, references: [], answering: null, forwardFrom: null, draftUid: null };
}

function quoteBody(m: MailMessage): string {
  if (m.html) {
    // The original HTML goes in as text the editor re-reads: it keeps
    // structure (paragraphs, lists, links), and scripts can't survive it.
    const doc = new DOMParser().parseFromString(m.html, 'text/html');
    doc.querySelectorAll('script, style, head, meta, link, title, iframe, object, embed').forEach((n) => n.remove());
    return doc.body.innerHTML;
  }
  return textToHtml(m.text);
}

function own(account: MailAccount | undefined, a: MailAddress): boolean {
  return !!account && a.address.toLowerCase() === account.email.toLowerCase();
}

export function replySeed(m: MailMessage, accountId: string, path: string, account: MailAccount | undefined, all: boolean): ComposeSeed {
  const sender = m.replyTo.length ? m.replyTo : m.from;
  // Replying to your own sent message goes back to whoever it went to.
  const fromMe = m.from.every((a) => own(account, a));
  const to = fromMe ? m.to : sender;
  const seen = new Set(to.map((a) => a.address.toLowerCase()));
  const cc = all
    ? [...(fromMe ? [] : m.to), ...m.cc].filter((a) => {
        const k = a.address.toLowerCase();
        if (seen.has(k) || own(account, a)) return false;
        seen.add(k);
        return true;
      })
    : [];
  const who = escapeHtml(displayName(m.from[0]) || 'someone');
  return {
    accountId,
    to,
    cc,
    bcc: [],
    subject: prefixed(m.subject, 'Re'),
    html: `<p></p><p></p><p>On ${escapeHtml(fullDate(m.date))}, ${who} wrote:</p><blockquote>${quoteBody(m)}</blockquote>`,
    inReplyTo: m.messageId,
    references: [...m.references, ...(m.messageId ? [m.messageId] : [])].slice(-20),
    answering: { path, uid: m.uid },
    forwardFrom: null,
    draftUid: null,
  };
}

export function forwardSeed(m: MailMessage, accountId: string, path: string): ComposeSeed {
  const header = [
    `<b>From:</b> ${escapeHtml(m.from.map(formatAddress).join(', '))}`,
    `<b>Subject:</b> ${escapeHtml(m.subject)}`,
    `<b>Date:</b> ${escapeHtml(fullDate(m.date))}`,
    `<b>To:</b> ${escapeHtml(m.to.map(formatAddress).join(', '))}`,
    ...(m.cc.length ? [`<b>Cc:</b> ${escapeHtml(m.cc.map(formatAddress).join(', '))}`] : []),
  ].join('<br>');
  const files = m.attachments.filter((a) => !a.inline).map((a) => a.index);
  return {
    accountId,
    to: [],
    cc: [],
    bcc: [],
    subject: prefixed(m.subject, 'Fwd'),
    html: `<p></p><p></p><p>Begin forwarded message:</p><blockquote><p>${header}</p>${quoteBody(m)}</blockquote>`,
    inReplyTo: null,
    references: [],
    answering: null,
    forwardFrom: files.length ? { accountId, path, uid: m.uid, indexes: files } : null,
    draftUid: null,
  };
}

export function draftSeed(m: MailMessage, accountId: string): ComposeSeed {
  return {
    accountId,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    html: m.html ? quoteBody(m) : textToHtml(m.text),
    inReplyTo: m.inReplyTo,
    references: m.references,
    answering: null,
    forwardFrom: null,
    draftUid: m.uid,
  };
}

/** "Name <a@b>, c@d" as typed into a field, into addresses. */
export function parseAddresses(input: string): MailAddress[] {
  const out: MailAddress[] = [];
  for (const part of input.split(/[,;]/)) {
    const s = part.trim();
    if (!s) continue;
    const angle = /^(.*)<([^>]+)>$/.exec(s);
    if (angle) out.push({ name: angle[1].trim().replace(/^"|"$/g, ''), address: angle[2].trim() });
    else out.push({ name: '', address: s });
  }
  return out;
}

export const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

import type { MailAccount, MailAddress, MailAttachment, MailMessage, OutgoingMessage } from '@/lib/mail';

/**
 * Writing mail, for Mail's compose window and `din mail send` and `reply`
 * alike: what a new message, a reply or a forward starts with, the
 * signature, and the message sent from what was written (its HTML and its
 * text part).
 */

const long = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

export function fullDate(ms: number): string {
  return ms ? long.format(new Date(ms)) : '';
}

export function displayName(a: MailAddress | undefined): string {
  if (!a) return '';
  return a.name.trim() || a.address;
}

/** "Name <address>", for headers and quoting. */
export function formatAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/** Plain text as the editor would hold it typed: a paragraph each, split at blank lines. */
export function textToParagraphs(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${textToHtml(p)}</p>`).join('<p></p>');
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

/**
 * The editor's starting content: room to write at the top, then the
 * sender's signature, then what the seed brings (a quote); a draft as it was.
 */
export function withSignature(seed: ComposeSeed, account: MailAccount | undefined): string {
  const sig = account?.signature.trim();
  const rest = seed.html.replace(/^(<p><\/p>)+/, '');
  if (seed.draftUid) return seed.html;
  const block = sig ? `<p>${textToHtml(sig)}</p>` : '';
  return `<p></p>${block ? `<p></p>${block}` : ''}${rest ? `<p></p>${rest}` : ''}`;
}

/** What's written, as HTML, put where the compose window's cursor starts: at the top, above the signature and any quote. */
export function writtenAbove(seed: ComposeSeed, account: MailAccount | undefined, text: string): string {
  return withSignature(seed, account).replace(/^<p><\/p>/, textToParagraphs(text));
}

/** HTML as plain text, with quotes as "> " lines, for the text part of the message. */
export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (node: Node, quote: string): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'BLOCKQUOTE') {
      blocks(node, `${quote}> `);
      return '';
    }
    let s = '';
    for (const c of node.childNodes) s += walk(c, quote);
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (href && href !== s && !href.startsWith('mailto:')) s += ` <${href}>`;
    }
    return s;
  };
  const block = (node: Node, quote: string) => {
    if (node instanceof Element && node.tagName === 'BLOCKQUOTE') {
      walk(node, quote);
      return;
    }
    if (node instanceof Element && (node.tagName === 'UL' || node.tagName === 'OL')) {
      [...node.children].forEach((li, i) => out.push(`${quote}${node.tagName === 'OL' ? `${i + 1}.` : '•'} ${walk(li, quote).trim()}`));
      return;
    }
    const text = walk(node, quote);
    for (const line of text.split('\n')) out.push(`${quote}${line}`.trimEnd());
  };
  // Text and line breaks loose among blocks (a quote that wasn't through
  // the editor, as `din mail reply` writes it) are one block between them.
  const BLOCKS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TABLE', 'TR', 'HR']);
  const blocks = (parent: Node, quote: string) => {
    let loose = '';
    const flush = () => {
      if (loose.trim()) for (const line of loose.replace(/^\n+|\n+$/g, '').split('\n')) out.push(`${quote}${line}`.trimEnd());
      loose = '';
    };
    for (const c of parent.childNodes) {
      if (c instanceof Element && BLOCKS.has(c.tagName)) {
        flush();
        block(c, quote);
      } else loose += walk(c, quote);
    }
    flush();
  };
  blocks(doc.body, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>p { margin: 0; }</style></head><body style="font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5;">${body.replace(/<p><\/p>/g, '<p><br></p>').replace(/<blockquote>/g, '<blockquote type="cite" style="margin: 0 0 0 4px; padding-left: 12px; border-left: 2px solid #0a84ff;">')}</body></html>`;
}

/** The message to send from what was written (the editor's HTML), as Send sends it. */
export function outgoingMessage(
  fields: { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; subject: string },
  html: string,
  attachments: MailAttachment[],
  seed: Pick<ComposeSeed, 'inReplyTo' | 'references' | 'answering'>,
  draftUid: number | null,
): OutgoingMessage {
  return {
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject.trim(),
    text: htmlToPlain(html),
    html: wrapHtml(html),
    attachments,
    inReplyTo: seed.inReplyTo,
    references: seed.references,
    answering: seed.answering,
    draftUid,
  };
}

/** Why these recipients can't be sent to, or null when they can. */
export function recipientsProblem(everyone: MailAddress[]): string | null {
  if (!everyone.length) return 'Add someone to send this message to.';
  const bad = everyone.find((a) => !EMAIL.test(a.address));
  return bad ? `“${bad.address}” isn’t an email address.` : null;
}

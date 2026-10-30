/**
 * mailto: links (RFC 6068), which open a new message in Mail: the desktop
 * routes them there (useOpenUrl, BrowserExtensionHost), and Mail reads them
 * from its `mailto` launch param.
 */

export function isMailtoUrl(url: string): boolean {
  return /^mailto:/i.test(url.trim()) && url.length <= 8192;
}

export interface MailtoFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%20'));
  } catch {
    return s;
  }
}

function split(list: string): string[] {
  return list
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseMailto(url: string): MailtoFields {
  const out: MailtoFields = { to: [], cc: [], bcc: [], subject: '', body: '' };
  if (!isMailtoUrl(url)) return out;
  const rest = url.trim().slice('mailto:'.length);
  const q = rest.indexOf('?');
  // `+` is literal in the address part, unlike in the query.
  const addresses = q === -1 ? rest : rest.slice(0, q);
  try {
    out.to = split(decodeURIComponent(addresses));
  } catch {
    out.to = split(addresses);
  }
  if (q !== -1) {
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
      if (key === 'to') out.to.push(...split(value));
      else if (key === 'cc') out.cc.push(...split(value));
      else if (key === 'bcc') out.bcc.push(...split(value));
      else if (key === 'subject') out.subject = value;
      else if (key === 'body') out.body = value;
    }
  }
  return out;
}

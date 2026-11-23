import type { ReactNode } from 'react';

/** Top-level domains common enough to link a bare host (`example.com`) without a path. */
const COMMON_TLDS =
  'com|org|net|edu|gov|mil|int|io|co|app|dev|me|us|uk|ca|au|de|fr|nl|eu|ly|gl|gg|tv|ai|info|biz|xyz|pub|link|page|site|online|store|shop|news|social|health';

/** Where a link ends: never on punctuation that ends the sentence. */
const TAIL = String.raw`[^\s<>"]*[^\s<>"'.,;:!?)\]}]`;

/**
 * Web addresses in a text: with a scheme, starting `www.`, or a bare host as
 * texts from businesses send them (`t.example.com/c?p=…`). A bare host links
 * when its domain is a common one or a path follows it, so "e.g." and file
 * names don't, and an email address's domain doesn't either.
 */
const URL_RE = new RegExp(
  String.raw`\b(?:https?:\/\/|www\.)${TAIL}` +
    String.raw`|(?<![@\w.\-/])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+` +
    String.raw`(?:(?:${COMMON_TLDS})\b(?![.\-]?\w)(?::\d+)?(?:[/?#]${TAIL})?|[a-z]{2,24}(?::\d+)?\/${TAIL})`,
  'gi',
);

/** A link's address as something to open: ones without a scheme get `https://`. */
export function linkHref(text: string): string {
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

/** Opens a web address the way an app does, in the user's browser. */
export function openLink(href: string): void {
  if (/^https?:\/\//i.test(href)) window.open(href);
}

/** A message's text with its web addresses as links. */
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const shown = m[0];
    const href = linkHref(shown);
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={m.index}
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          openLink(href);
        }}
        className="rounded-sm underline underline-offset-2 decoration-current/40 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {shown}
      </a>,
    );
    last = m.index + shown.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

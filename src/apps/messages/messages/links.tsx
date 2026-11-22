import type { ReactNode } from 'react';

/**
 * Web addresses in a text: with a scheme, or starting `www.`, as phones send
 * them. Trailing punctuation that ends the sentence isn't part of the link.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>"'.,;:!?)\]}]/gi;

/** A link's address as something to open: `www.` ones get `https://`. */
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

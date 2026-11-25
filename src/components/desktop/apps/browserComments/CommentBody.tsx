import type { ReactNode } from 'react';
import { nip19 } from 'nostr-tools';
import { useAuthor } from '@/hooks/useAuthor';
import { middleEllipsis } from '@/lib/utils';
import { displayNameOf } from './names';

/**
 * A comment's text, with its web addresses and nostr: mentions as links.
 * Built of text nodes and anchors only: comments are anyone's words.
 */

// A web address never ends on the punctuation that ends a sentence.
const LINK_RE =
  /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]|nostr:(?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+/gi;

const linkClass =
  'rounded-sm text-ink-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 break-all';

function pubkeyOf(uri: string): string | null {
  try {
    const decoded = nip19.decode(uri.slice('nostr:'.length));
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    // Not a valid identifier: shown as written.
  }
  return null;
}

function Mention({ pubkey, uri, onOpen }: { pubkey: string; uri: string; onOpen: (url: string) => void }) {
  const author = useAuthor(pubkey);
  return (
    <a href={uri} className={linkClass} onClick={(e) => { e.preventDefault(); onOpen(uri); }}>
      @{displayNameOf(author.data?.metadata, pubkey)}
    </a>
  );
}

export function CommentBody({ content, onOpen }: { content: string; onOpen: (url: string) => void }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(LINK_RE)) {
    const uri = match[0];
    if (match.index > last) parts.push(content.slice(last, match.index));
    const pubkey = uri.toLowerCase().startsWith('nostr:') ? pubkeyOf(uri) : null;
    parts.push(
      pubkey ? (
        <Mention key={match.index} pubkey={pubkey} uri={uri} onOpen={onOpen} />
      ) : (
        <a
          key={match.index}
          href={uri}
          title={uri}
          className={linkClass}
          onClick={(e) => {
            e.preventDefault();
            onOpen(uri);
          }}
        >
          {uri.startsWith('nostr:') ? middleEllipsis(uri, 32) : uri}
        </a>
      ),
    );
    last = match.index + uri.length;
  }
  if (last < content.length) parts.push(content.slice(last));
  return <div className="whitespace-pre-wrap break-words" dir="auto">{parts}</div>;
}

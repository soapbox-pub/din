import { nip19 } from 'nostr-tools';
import { MAX_HIGHLIGHT_CONTEXT_LENGTH, MAX_HIGHLIGHT_LENGTH } from '@/shared/highlightText';

/**
 * NIP-84 highlights (kind 9802), as the desktop posts them: from a page in the
 * Web Browser (its right-click menu), from an app (`din.app.highlight`, the
 * Assistant's replies), or from `din nostr highlight`. Every one goes through
 * `requestHighlight`, which opens the desktop's composer
 * (HighlightBridgeHost); nothing is published until the user presses Post.
 */

/**
 * Where a highlight is from: a page by its URL (an `i` tag and an `r` tag), or
 * anything else by its name (an `r` tag of plain text, which NIP-84 allows:
 * nostr-protocol/nips#2454), such as the model that wrote an assistant's reply.
 */
export type HighlightSource = { url: string; title?: string } | { name: string };

export interface HighlightRequest {
  /** The highlighted excerpt (the event's `content`). */
  text: string;
  /**
   * Surrounding prose containing the excerpt word for word (NIP-84
   * `context`): a paragraph, or an assistant's whole reply as Markdown.
   */
  context?: string;
  source: HighlightSource;
}

/** Longest name a source goes by. */
export const MAX_HIGHLIGHT_SOURCE_LENGTH = 200;

/** The source's URL, or undefined for a source by name. */
export function sourceUrl(source: HighlightSource): string | undefined {
  return 'url' in source ? source.url : undefined;
}

/** Normalize line endings and trim, keeping internal line breaks. */
function normalize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * The request as the composer takes it, or an Error saying what's wrong with
 * it: the excerpt trimmed and not too long, a context kept only when it holds
 * the excerpt word for word (NIP-84), a page only by an http(s) or nsite
 * URL.
 */
export function normalizeHighlight(request: HighlightRequest): HighlightRequest | Error {
  const text = typeof request.text === 'string' ? normalize(request.text) : '';
  if (!text) return new Error('Nothing selected to highlight');
  if (text.length > MAX_HIGHLIGHT_LENGTH) return new Error('That’s too long to highlight');
  const rawContext = typeof request.context === 'string' ? normalize(request.context) : '';
  const context =
    rawContext && rawContext !== text && rawContext.length <= MAX_HIGHLIGHT_CONTEXT_LENGTH && rawContext.includes(text)
      ? rawContext
      : undefined;
  const raw = request.source as Partial<{ url: unknown; title: unknown; name: unknown }> | undefined;
  let source: HighlightSource;
  if (typeof raw?.url === 'string') {
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      return new Error(`Not a URL: ${raw.url}`);
    }
    if (!/^(https?|nsite):$/.test(url.protocol)) return new Error('A highlight’s page is an http(s) or nsite address');
    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 300) : '';
    source = title ? { url: url.toString(), title } : { url: url.toString() };
  } else if (typeof raw?.name === 'string' && raw.name.trim()) {
    source = { name: raw.name.replace(/\s+/g, ' ').trim().slice(0, MAX_HIGHLIGHT_SOURCE_LENGTH) };
  } else {
    return new Error('A highlight needs a source: a page’s URL or a name');
  }
  return context ? { text, context, source } : { text, source };
}

/** Hex pubkeys of the npubs and nprofiles a comment mentions with `nostr:`. */
function mentionedPubkeys(comment: string): string[] {
  const out = new Set<string>();
  for (const [, bech32] of comment.matchAll(/nostr:([a-z0-9]+)/gi)) {
    try {
      const decoded = nip19.decode(bech32);
      if (decoded.type === 'npub') out.add(decoded.data);
      else if (decoded.type === 'nprofile') out.add(decoded.data.pubkey);
    } catch {
      // Not a valid identifier.
    }
  }
  return [...out];
}

/** The http(s) URLs a comment mentions, without trailing sentence punctuation. */
function mentionedUrls(comment: string): string[] {
  const out = new Set<string>();
  for (const [match] of comment.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    const url = match.replace(/[),.;:!?\]]+$/, '');
    if (URL.canParse(url)) out.add(url);
  }
  return [...out];
}

/**
 * The tags of a NIP-84 highlight of `request` (normalized). A page is its
 * source twice: an `i` tag, which readers prefer, and the same URL in an `r`
 * tag for readers that only know `r`. A source by name is an `r` tag of plain
 * text alone: NIP-73 has no `i` for it. A comment travels on the highlight
 * itself (a "quote highlight"), which then marks the source's `r` tag `source`
 * and anything the comment mentions `mention`.
 */
export function highlightTags(request: HighlightRequest, comment: string): string[][] {
  const url = sourceUrl(request.source);
  const r = url ?? ('name' in request.source ? request.source.name : '');
  const tags: string[][] = url ? [['i', url]] : [];
  tags.push(comment ? ['r', r, 'source'] : ['r', r]);
  if (request.context) tags.push(['context', request.context]);
  if (comment) {
    for (const pubkey of mentionedPubkeys(comment)) tags.push(['p', pubkey, '', 'mention']);
    for (const mentioned of mentionedUrls(comment)) {
      if (mentioned !== url) tags.push(['r', mentioned, 'mention']);
    }
    tags.push(['comment', comment]);
  }
  // NIP-31 alt for clients that don't understand kind 9802.
  tags.push(['alt', 'name' in request.source ? `Highlight from ${request.source.name}` : 'Highlight']);
  return tags;
}

/** Shows the composer: the posted event's id, or null if the user cancelled. */
type HighlightHandler = (request: HighlightRequest) => Promise<string | null>;

let handler: HighlightHandler | null = null;

/** Set by the composer's host while it's mounted. Returns the unset. */
export function setHighlightHandler(next: HighlightHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Open the composer for a highlight: the posted event's id, or null if the
 * user cancelled. Rejects when the request is wrong, nobody is signed in, or
 * there's no desktop to show it.
 */
export function requestHighlight(request: HighlightRequest): Promise<string | null> {
  const normalized = normalizeHighlight(request);
  if (normalized instanceof Error) return Promise.reject(normalized);
  if (!handler) return Promise.reject(new Error('Highlights can’t be posted here'));
  return handler(normalized);
}

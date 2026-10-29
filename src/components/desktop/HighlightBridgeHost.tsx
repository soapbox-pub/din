import { useEffect, useState, type FormEvent } from 'react';
import { Globe, Highlighter, Loader2 } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { getAvatarShape } from '@/lib/avatarShape';
import {
  getHighlightHostBridge,
  type HighlightBridgeRequest,
} from '@/lib/highlightBridge';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

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
 * The tags of a NIP-84 highlight of `request`. A comment travels on the
 * highlight itself (a "quote highlight"), which then marks the page's `r` tag
 * `source` and anything the comment mentions `mention`.
 */
function highlightTags(request: HighlightBridgeRequest, text: string, comment: string): string[][] {
  const tags: string[][] = [comment ? ['r', request.url, 'source'] : ['r', request.url]];
  if (request.context && request.context.includes(text) && request.context !== text) {
    tags.push(['context', request.context]);
  }
  if (comment) {
    for (const pubkey of mentionedPubkeys(comment)) tags.push(['p', pubkey, '', 'mention']);
    for (const url of mentionedUrls(comment)) {
      if (url !== request.url) tags.push(['r', url, 'mention']);
    }
    tags.push(['comment', comment]);
  }
  // NIP-31 alt for clients that don't understand kind 9802.
  tags.push(['alt', 'Highlight']);
  return tags;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The excerpt as a pull quote, inside its surrounding paragraph when that's
 * published with it, the way Ditto shows a kind 9802.
 */
function HighlightQuote({ text, context }: { text: string; context?: string }) {
  const at = context && context !== text ? context.indexOf(text) : -1;
  return (
    <blockquote className="max-h-64 overflow-y-auto rounded-r-xl border-l-4 border-primary/70 bg-primary/5 px-4 py-3">
      <p className="font-serif text-base leading-relaxed break-words whitespace-pre-wrap">
        {context && at >= 0 ? (
          <>
            <span className="text-muted-foreground">{context.slice(0, at)}</span>
            <mark className="rounded bg-primary/25 px-0.5 text-foreground">{text}</mark>
            <span className="text-muted-foreground">{context.slice(at + text.length)}</span>
          </>
        ) : (
          text
        )}
      </p>
    </blockquote>
  );
}

interface HighlightComposerProps {
  request: HighlightBridgeRequest;
  /** Answer the tab: the published event's id, or undefined when cancelled. */
  onDone: (eventId?: string) => void;
}

/**
 * Review a highlight before it goes out: where it's from, the excerpt in its
 * context, who it posts as, and an optional comment. Nothing is published
 * until the user presses Post.
 */
function HighlightComposer({ request, onDone }: HighlightComposerProps) {
  const { user, metadata } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const text = request.text.trim();
  const host = hostOf(request.url);
  const name = metadata?.display_name || metadata?.name || 'you';
  const picture = metadata?.picture ? sanitizeUrl(metadata.picture) ?? undefined : undefined;

  const post = (e?: FormEvent) => {
    e?.preventDefault();
    if (posting) return;
    setPosting(true);
    setError(null);
    const trimmed = comment.trim();
    publishEvent({ kind: 9802, content: text, tags: highlightTags(request, text, trimmed) })
      .then((event) => onDone(event.id))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setPosting(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !posting && onDone()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={post} className="flex min-w-0 flex-col gap-4">
          <DialogHeader className="flex-row items-center gap-3 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <Highlighter className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>Post a highlight</DialogTitle>
              <DialogDescription className="flex min-w-0 items-center gap-1.5">
                <Globe className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  {request.title ? (
                    <>
                      {request.title} <span className="font-mono">· {host}</span>
                    </>
                  ) : (
                    <span className="font-mono">{host}</span>
                  )}
                </span>
              </DialogDescription>
            </div>
          </DialogHeader>

          <HighlightQuote text={text} context={request.context} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="highlight-comment">Comment (optional)</Label>
            <Textarea
              id="highlight-comment"
              autoFocus
              dir="auto"
              rows={3}
              className="max-h-48"
              placeholder="Say something about it…"
              value={comment}
              disabled={posting}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post();
              }}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter className="items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <Avatar className="size-6" shape={getAvatarShape(metadata)}>
                <AvatarImage src={picture} alt="" />
                <AvatarFallback className="text-xs">{name.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="truncate">
                Posting publicly as <span className="font-medium text-foreground">{user ? name : '…'}</span>
              </span>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => onDone()} disabled={posting}>
                Cancel
              </Button>
              <Button type="submit" disabled={posting}>
                {posting && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
                Post
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Desktop-lifetime host for NIP-84 highlight requests relayed from the ad-hoc
 * Web Browser's tabs (see electron/browser-highlight-preload.cjs). When the
 * user selects text on a web page and clicks the floating "Highlight" button,
 * the click is proxied through the main process to here, which opens the
 * composer; only when the user posts from it is a kind 9802 Highlight event
 * published with the signed-in account's signer, referencing the page URL (an
 * `r`-tag source, per NIP-84's website form).
 *
 * The source URL, title, selected text, and surrounding context are supplied
 * by the bridge (the URL read authoritatively from the tab in main, not the
 * page). One request at a time. Does nothing outside the Electron shell.
 */
export function HighlightBridgeHost() {
  const { user } = useCurrentUser();
  const signedIn = !!user;
  const [queue, setQueue] = useState<HighlightBridgeRequest[]>([]);

  useEffect(() => {
    const bridge = getHighlightHostBridge();
    if (!bridge) return;
    return bridge.onRequest((request) => {
      if (!signedIn) {
        bridge.respond({ requestId: request.requestId, ok: false, error: 'No Nostr account is signed in to Din' });
      } else if (!request.text.trim()) {
        bridge.respond({ requestId: request.requestId, ok: false, error: 'Nothing selected to highlight' });
      } else {
        setQueue((q) => [...q, request]);
      }
    });
  }, [signedIn]);

  const current = queue[0];
  if (!current) return null;

  return (
    <HighlightComposer
      key={current.requestId}
      request={current}
      onDone={(eventId) => {
        getHighlightHostBridge()?.respond({ requestId: current.requestId, ok: true, result: eventId });
        setQueue((q) => q.filter((r) => r.requestId !== current.requestId));
      }}
    />
  );
}

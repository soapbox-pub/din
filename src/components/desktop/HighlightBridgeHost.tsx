import { useEffect, useState, type FormEvent } from 'react';
import { Globe, Highlighter, Loader2, Sparkles } from 'lucide-react';
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
import { toast } from '@/hooks/useToast';
import { getAvatarShape } from '@/lib/avatarShape';
import { getHighlightHostBridge } from '@/lib/highlightBridge';
import { highlightTags, requestHighlight, setHighlightHandler, type HighlightRequest } from '@/lib/highlights';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

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
export function HighlightQuote({ text, context, className }: { text: string; context?: string; className?: string }) {
  const at = context && context !== text ? context.indexOf(text) : -1;
  return (
    <blockquote className={className ?? 'max-h-64 overflow-y-auto rounded-r-xl border-l-4 border-ink-accent/60 bg-selected px-4 py-3'}>
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

/** Where a highlight is from, for the composer's header: a page's title and host, or a source's name. */
function SourceLine({ request }: { request: HighlightRequest }) {
  const { source } = request;
  if ('name' in source) {
    return (
      <>
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{source.name}</span>
      </>
    );
  }
  const host = hostOf(source.url);
  return (
    <>
      <Globe className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {source.title ? (
          <>
            {source.title} <span className="font-mono">· {host}</span>
          </>
        ) : (
          <span className="font-mono">{host}</span>
        )}
      </span>
    </>
  );
}

interface HighlightComposerProps {
  request: HighlightRequest;
  /** Close the composer: the published event's id, or undefined when cancelled. */
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

  const name = metadata?.display_name || metadata?.name || 'you';
  const picture = metadata?.picture ? sanitizeUrl(metadata.picture) ?? undefined : undefined;

  const post = (e?: FormEvent) => {
    e?.preventDefault();
    if (posting) return;
    setPosting(true);
    setError(null);
    publishEvent({ kind: 9802, content: request.text, tags: highlightTags(request, comment.trim()) })
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
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-pigment text-primary-foreground clay-pigment">
              <Highlighter className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>Post a highlight</DialogTitle>
              <DialogDescription className="flex min-w-0 items-center gap-1.5">
                <SourceLine request={request} />
              </DialogDescription>
            </div>
          </DialogHeader>

          <HighlightQuote text={request.text} context={request.context} />

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

interface Pending {
  id: number;
  request: HighlightRequest;
  resolve: (eventId: string | null) => void;
}

let nextPendingId = 1;

/**
 * Desktop-lifetime host for NIP-84 highlights (src/lib/highlights.ts): from
 * the Web Browser's tabs, where "Highlight on Nostr" in a page's right-click
 * menu on selected text has main send the selection here (its URL read from
 * the tab, not the page); from apps (`din.app.highlight`, the Assistant's
 * replies); and from `din nostr highlight`. Each opens the composer, one at a
 * time; only when the user posts from it is a kind 9802 Highlight event
 * published with the signed-in account's signer.
 */
export function HighlightBridgeHost() {
  const { user } = useCurrentUser();
  const signedIn = !!user;
  const [queue, setQueue] = useState<Pending[]>([]);

  useEffect(
    () =>
      setHighlightHandler((request) => {
        if (!signedIn) return Promise.reject(new Error('No Nostr account is signed in to Din'));
        return new Promise((resolve) => setQueue((q) => [...q, { id: nextPendingId++, request, resolve }]));
      }),
    [signedIn],
  );

  useEffect(() => {
    const bridge = getHighlightHostBridge();
    if (!bridge) return;
    return bridge.onRequest(({ url, title, text, context }) => {
      requestHighlight({ text, context, source: { url, title } }).catch((error: unknown) =>
        toast({ title: 'Couldn’t highlight', description: error instanceof Error ? error.message : String(error), variant: 'destructive' }),
      );
    });
  }, []);

  const current = queue[0];
  if (!current) return null;

  return (
    <HighlightComposer
      key={current.id}
      request={current.request}
      onDone={(eventId) => {
        if (eventId) toast({ title: 'Highlight posted' });
        current.resolve(eventId ?? null);
        setQueue((q) => q.filter((p) => p.id !== current.id));
      }}
    />
  );
}

import { useState, type FormEvent } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { Copy, ExternalLink, Heart, Link2, Loader2, MessageCircle, MoreHorizontal, Reply, Trash2, X } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ContextMenuEntries, DropdownMenuEntries } from '@/components/desktop/apps/BrowserBookmarks';
import type { BookmarkMenuEntry } from '@/components/desktop/apps/bookmarkMenus';
import { EmptyState, ToolButton } from '@/shared/appChrome';
import { toolIcon } from '@/shared/appChromeStyles';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { useAppContext } from '@/hooks/useAppContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import {
  useCommentLikes,
  useDeletePageComment,
  usePageComments,
  usePostPageComment,
  useToggleCommentLike,
  type CommentLikes,
} from '@/hooks/usePageComments';
import { useToast } from '@/hooks/useToast';
import { getAvatarShape } from '@/lib/avatarShape';
import type { PageThread } from '@/lib/pageComments';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { CommentBody } from './CommentBody';
import { ago, displayNameOf } from './names';

/** A thread with more replies than this shows its first, and the rest behind "Show N more replies". */
const REPLIES_SHOWN = 2;

/** Why a page can't be commented on from here. */
export type NoCommentsReason = 'tor' | 'not-web';

export interface CommentsPaneProps {
  /** The page's canonical URL (src/lib/pageComments.ts), or null with the reason. */
  page: string | null;
  reason?: NoCommentsReason;
  onClose: () => void;
  /** Open a web address from a comment, in a tab of this window. */
  onOpenLink: (url: string) => void;
  /** A comment drafted for this page (`din browser comment`), waiting in the composer. */
  draft?: string;
  /** The draft was posted. */
  onDraftPosted?: () => void;
  /** The window frame's tokens, when a page's color tints it. */
  style?: React.CSSProperties;
}

/**
 * The Web Browser's comments pane, a sidebar on the window's frame beside
 * the page: what people say about the page in front on Nostr (NIP-22
 * comments on its URL, as Ditto and its browser extension post them), and a
 * composer to add to it. It follows the window's active tab, and asks relays
 * for a page of comments at a time.
 */
export function CommentsPane({ page, reason, onClose, onOpenLink, draft, onDraftPosted, style }: CommentsPaneProps) {
  const comments = usePageComments(page);
  const thread = comments.data;
  const openUrl = useOpenUrl();
  const open = (url: string) => (/^https?:/i.test(url) ? onOpenLink(url) : openUrl(url));

  return (
    <aside aria-label="Comments" style={style} className="relative flex w-[22.5rem] min-w-0 shrink-0 flex-col text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-base font-semibold">Comments</h2>
        <ToolButton label="Close comments" onClick={onClose}>
          <X {...toolIcon} />
        </ToolButton>
      </header>

      {page === null ? (
        <EmptyState icon={MessageCircle} title={reason === 'tor' ? 'Not in Tor tabs' : 'No comments here'} className="flex-1">
          {reason === 'tor'
            ? 'Asking relays about this page would happen outside Tor, so comments are off in Tor tabs.'
            : 'Open a web page to see what people say about it on Nostr, and add to it.'}
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <Composer key={`${page}\n${draft ?? ''}`} page={page} initial={draft} onDone={draft !== undefined ? onDraftPosted : undefined} />
          {comments.isLoading ? (
            <ThreadSkeleton />
          ) : comments.isError && !thread ? (
            <EmptyState
              icon={MessageCircle}
              title="Couldn’t load comments"
              action={<Button size="sm" variant="secondary" onClick={() => void comments.refetch()}>Try again</Button>}
            >
              Your relays didn’t answer.
            </EmptyState>
          ) : thread && thread.top.length > 0 ? (
            <>
              <Thread key={page} page={page} thread={thread} onOpen={open} />
              {comments.hasNextPage && (
                <div className="flex justify-center px-4 pt-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={comments.isFetchingNextPage}
                    onClick={() => void comments.fetchNextPage()}
                  >
                    {comments.isFetchingNextPage && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
                    Show Older Comments
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState icon={MessageCircle} title="No comments yet">Be the first to say something about this page.</EmptyState>
          )}
        </div>
      )}
    </aside>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-5 px-4 py-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Write a comment on the page, or (with `parent`) a reply to one. */
function Composer({
  page,
  parent,
  initial,
  onDone,
}: {
  page: string;
  parent?: NostrEvent;
  initial?: string;
  onDone?: () => void;
}) {
  const { user, metadata } = useCurrentUser();
  const { toast } = useToast();
  const [text, setText] = useState(initial ?? '');
  const post = usePostPageComment(page);

  if (!user) {
    return (
      <p className="px-4 pt-1 pb-3 text-sm text-muted-foreground">
        Sign in to Din with a Nostr account to {parent ? 'reply' : 'comment'}.
      </p>
    );
  }

  const name = displayNameOf(metadata, user.pubkey);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const content = text.trim();
    if (!content || post.isPending) return;
    post.mutate(
      { content, parent },
      {
        onSuccess: () => {
          setText('');
          onDone?.();
        },
        onError: (error) =>
          toast({ title: parent ? 'Couldn’t reply' : 'Couldn’t post your comment', description: error.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <form onSubmit={submit} className={cn('flex flex-col gap-2', parent ? 'pt-1 pb-3' : 'px-4 pt-1 pb-4')}>
      <Textarea
        autoFocus={!!parent || initial !== undefined}
        dir="auto"
        rows={parent ? 1 : 2}
        className="max-h-56 min-h-10 resize-none"
        aria-label={parent ? 'Reply' : 'Comment'}
        placeholder={parent ? 'Write a reply…' : 'Add a comment…'}
        value={text}
        disabled={post.isPending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          if (e.key === 'Escape' && parent) onDone?.();
        }}
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{parent ? '' : `Public, as ${name}`}</span>
        {parent && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={post.isPending}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!text.trim() || post.isPending}>
          {post.isPending && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
          {parent ? 'Reply' : 'Post'}
        </Button>
      </div>
    </form>
  );
}

function Thread({ page, thread, onOpen }: { page: string; thread: PageThread; onOpen: (url: string) => void }) {
  const { likesOf, queryKey } = useCommentLikes(page, thread.all.map((c) => c.id));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<NostrEvent | null>(null);

  const comment = (c: NostrEvent, threaded: boolean, replyTo?: NostrEvent) => (
    <Comment
      key={c.id}
      page={page}
      comment={c}
      threaded={threaded}
      replyTo={replyTo}
      likes={likesOf(c.id)}
      likesKey={queryKey}
      onOpen={onOpen}
      onDelete={() => setDeleting(c)}
    />
  );

  // As Ditto threads them: no indent, a line down from each avatar to the
  // next in the thread, and the last without one.
  return (
    <>
      <ul>
        {thread.top.map((top) => {
          const replies = thread.replies(top.id);
          const collapsed = !expanded.has(top.id) && replies.length > REPLIES_SHOWN;
          const shown = collapsed ? replies.slice(0, 1) : replies;
          const hidden = replies.length - shown.length;
          return (
            <li key={top.id}>
              {comment(top, replies.length > 0)}
              {shown.map((r, i) => {
                const parent = thread.parent(r.id);
                return comment(r, i < shown.length - 1 || hidden > 0, parent && parent.id !== top.id ? parent : undefined);
              })}
              {hidden > 0 && <ShowMoreReplies count={hidden} onClick={() => setExpanded((s) => new Set(s).add(top.id))} />}
            </li>
          );
        })}
      </ul>
      {deleting && <DeleteConfirm page={page} comment={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

/** The rest of a thread's replies, the line running on into fading dots (Ditto's ExpandThreadButton). */
function ShowMoreReplies({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 px-4 pt-0 pb-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span aria-hidden className="flex w-10 shrink-0 flex-col items-center self-stretch">
        <span className="mb-1 w-0.5 flex-1 bg-foreground/20" />
        <span className="my-0.5 size-1.5 rounded-full bg-foreground/30" />
        <span className="my-0.5 size-1.5 rounded-full bg-foreground/20" />
        <span className="my-0.5 size-1.5 rounded-full bg-foreground/10" />
      </span>
      <span className="text-sm font-medium text-ink-accent group-hover:underline">
        Show {count} more {count === 1 ? 'reply' : 'replies'}
      </span>
    </button>
  );
}

function DeleteConfirm({ page, comment, onClose }: { page: string; comment: NostrEvent; onClose: () => void }) {
  const remove = useDeletePageComment(page);
  const { toast } = useToast();
  return (
    <Overlay label="Delete comment" onClose={() => !remove.isPending && onClose()}>
      <div className="flex flex-col gap-2 p-5">
        <h3 className="font-semibold">Delete this comment?</h3>
        <p className="text-sm text-muted-foreground">
          Din asks your relays to delete it. Most will, and apps that see the request hide it, but copies elsewhere may stay.
        </p>
      </div>
      <div className="flex justify-end gap-2 px-5 pb-5">
        <DialogButton onClick={onClose} disabled={remove.isPending}>Cancel</DialogButton>
        <DialogButton
          variant="destructive"
          autoFocus
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(comment, {
              onSuccess: () => {
                toast({ title: 'Comment deleted' });
                onClose();
              },
              onError: (error) => toast({ title: 'Couldn’t delete it', description: error.message, variant: 'destructive' }),
            })
          }
        >
          Delete
        </DialogButton>
      </div>
    </Overlay>
  );
}

/** Who a reply answers, when that isn't the comment it's under. */
function ReplyingTo({ pubkey, onOpen }: { pubkey: string; onOpen: (url: string) => void }) {
  const author = useAuthor(pubkey);
  const uri = `nostr:${nip19.npubEncode(pubkey)}`;
  return (
    <p className="truncate text-xs text-muted-foreground">
      Replying to{' '}
      <a
        href={uri}
        onClick={(e) => {
          e.preventDefault();
          onOpen(uri);
        }}
        className="rounded-sm text-ink-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        @{displayNameOf(author.data?.metadata, pubkey)}
      </a>
    </p>
  );
}

/**
 * One comment in a thread, a comment on the page or a reply to one (with
 * `replyTo` when it answers another reply), laid out as Ditto's threaded
 * NoteCard: `threaded` draws the line down from its avatar to the next.
 */
function Comment({
  page,
  comment,
  threaded,
  replyTo,
  likes,
  likesKey,
  onOpen,
  onDelete,
}: {
  page: string;
  comment: NostrEvent;
  threaded: boolean;
  replyTo?: NostrEvent;
  likes: CommentLikes;
  likesKey: readonly unknown[];
  onOpen: (url: string) => void;
  onDelete: () => void;
}) {
  const author = useAuthor(comment.pubkey);
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { toast } = useToast();
  const like = useToggleCommentLike(likesKey);
  const [replying, setReplying] = useState(false);

  const metadata = author.data?.metadata;
  const name = displayNameOf(metadata, comment.pubkey);
  const picture = metadata?.picture ? sanitizeUrl(metadata.picture) ?? undefined : undefined;
  const profile = `nostr:${nip19.npubEncode(comment.pubkey)}`;
  const relays = config.relayMetadata.relays.filter((r) => r.write).slice(0, 3).map((r) => r.url);
  const link = `nostr:${nip19.neventEncode({ id: comment.id, author: comment.pubkey, kind: comment.kind, relays })}`;
  const mine = user?.pubkey === comment.pubkey;
  const when = new Date(comment.created_at * 1000);

  const toggleLike = () => {
    if (!user || like.isPending) return;
    like.mutate(
      { comment, mine: likes.mine },
      { onError: (error) => toast({ title: 'Couldn’t like it', description: error.message, variant: 'destructive' }) },
    );
  };
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast({ title: `Copied ${what}` }),
      () => toast({ title: `Couldn’t copy ${what}`, variant: 'destructive' }),
    );

  // The ⋯ menu's and the right-click menu's, the same.
  const menu: BookmarkMenuEntry[] = [
    ...(user ? [{ label: 'Reply', icon: Reply, onSelect: () => setReplying(true) }] : []),
    { label: 'Open', icon: ExternalLink, onSelect: () => onOpen(link) },
    { label: `Open ${name}’s Profile`, icon: ExternalLink, onSelect: () => onOpen(profile) },
    'separator',
    { label: 'Copy Text', icon: Copy, onSelect: () => copy(comment.content, 'the text') },
    { label: 'Copy Link', icon: Link2, onSelect: () => copy(link, 'the link') },
    ...(mine ? ['separator' as const, { label: 'Delete…', icon: Trash2, destructive: true, onSelect: onDelete }] : []),
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <article className={cn('group flex gap-3 px-4 pt-3', !threaded && 'pb-3')}>
            <div className="flex shrink-0 flex-col items-center">
              <button
                type="button"
                onClick={() => onOpen(profile)}
                aria-label={`${name}’s profile`}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Avatar className="size-10" shape={getAvatarShape(metadata)}>
                  <AvatarImage src={picture} alt="" />
                  <AvatarFallback className="text-xs">{name.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
              </button>
              {threaded && <div aria-hidden className="mt-2 w-0.5 flex-1 rounded-full bg-foreground/20" />}
            </div>
            <div className={cn('min-w-0 flex-1', threaded && 'pb-3')}>
              <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
                <button
                  type="button"
                  onClick={() => onOpen(profile)}
                  className="truncate rounded-sm font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {name}
                </button>
                <time dateTime={when.toISOString()} title={when.toLocaleString()} className="shrink-0 text-xs text-muted-foreground">
                  {ago(comment.created_at)}
                </time>
              </div>
              {replyTo && <ReplyingTo pubkey={replyTo.pubkey} onOpen={onOpen} />}
              <div className="mt-0.5 text-sm">
                <CommentBody content={comment.content} onOpen={onOpen} />
              </div>
              <div className="-ml-1.5 mt-0.5 flex items-center gap-1 text-muted-foreground">
                <ActionButton label="Reply" disabled={!user} pressed={replying} onClick={() => setReplying((r) => !r)}>
                  <MessageCircle className="size-4.5" strokeWidth={1.75} aria-hidden />
                </ActionButton>
                <ActionButton
                  label={likes.mine ? 'Unlike' : 'Like'}
                  disabled={!user || like.isPending}
                  pressed={!!likes.mine}
                  className={cn(likes.mine && 'text-pink-600 dark:text-pink-400')}
                  onClick={toggleLike}
                >
                  <Heart className="size-4.5" strokeWidth={1.75} fill={likes.mine ? 'currentColor' : 'none'} aria-hidden />
                  {likes.count > 0 && <span className="tabular-nums">{likes.count}</span>}
                </ActionButton>
                <span className="flex-1" />
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <ToolButton
                      label="More"
                      size="sm"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
                    </ToolButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuEntries entries={menu} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {replying && (
                // A text field keeps its own right-click menu.
                <div onContextMenu={(e) => e.stopPropagation()}>
                  <Composer page={page} parent={comment} onDone={() => setReplying(false)} />
                </div>
              )}
            </div>
          </article>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries entries={menu} />
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}

function ActionButton({
  label,
  pressed,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & { label: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...props}
      className={cn(
        'flex h-7 min-w-7 items-center justify-center gap-1 rounded-full px-1.5 text-xs',
        'hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

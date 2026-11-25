import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { fetchCommentsPage, pageCommentTags, threadOf, type CommentsPage } from '@/lib/pageComments';

/**
 * A web page's NIP-22 comments (src/lib/pageComments.ts) for the Web
 * Browser's comments pane, a page of them at a time.
 */

const QUERY_TIMEOUT_MS = 6000;
/** A page's comments are asked for again after this long. */
const STALE_MS = 60_000;

const threadKey = (page: string) => ['page-comments', page] as const;
const reactionsKey = (page: string) => ['page-comment-reactions', page] as const;

type Pages = InfiniteData<CommentsPage, number | undefined>;

/** The comments on `page` (a canonical URL), as a thread, with `fetchNextPage` for older ones. */
export function usePageComments(page: string | null) {
  const { nostr } = useNostr();
  return useInfiniteQuery({
    queryKey: threadKey(page ?? ''),
    enabled: page !== null,
    staleTime: STALE_MS,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchCommentsPage(
        (filters) => nostr.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]) }),
        page!,
        pageParam,
      ),
    getNextPageParam: (last) => last.until ?? undefined,
    select: (data) => threadOf(data.pages, page!),
  });
}

/** A comment's likes: how many, and the signed-in account's own, to undo. */
export interface CommentLikes {
  count: number;
  mine: NostrEvent | null;
}

type LikesByComment = Record<string, NostrEvent[]>;

const isLike = (reaction: NostrEvent) => reaction.content !== '-';

/** The likes (NIP-25 reactions) on the comments shown, in one request for them all. */
export function useCommentLikes(page: string | null, ids: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryKey = [...reactionsKey(page ?? ''), ids.slice().sort().join(',')];
  const query = useQuery({
    queryKey,
    enabled: page !== null && ids.length > 0,
    staleTime: STALE_MS,
    // Loading older comments asks again for them all: keep the counts meanwhile.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const events = await nostr.query([{ kinds: [7], '#e': ids, limit: Math.min(ids.length * 20, 2000) }], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
      });
      const byComment: LikesByComment = {};
      for (const event of events) {
        // A reaction is to the last `e` it names (NIP-25).
        const target = event.tags.findLast(([n]) => n === 'e')?.[1];
        if (target && ids.includes(target)) (byComment[target] ??= []).push(event);
      }
      return byComment;
    },
  });
  const likesOf = (id: string): CommentLikes => {
    const reactions = (query.data?.[id] ?? []).filter(isLike);
    return {
      count: new Set(reactions.map((r) => r.pubkey)).size,
      mine: (user && reactions.find((r) => r.pubkey === user.pubkey)) || null,
    };
  };
  return { likesOf, queryKey };
}

/** Change every loaded page of a thread. */
function updatePages(data: Pages | undefined, update: (pages: CommentsPage[]) => CommentsPage[]): Pages | undefined {
  return data && { ...data, pages: update(data.pages) };
}

/** Post a comment on `page`, at its top or in reply to `parent`. */
export function usePostPageComment(page: string) {
  const { mutateAsync: publish } = useNostrPublish();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ content, parent }: { content: string; parent?: NostrEvent }) =>
      publish({ kind: 1111, content, tags: pageCommentTags(page, parent) }),
    // Shown at once: relays needn't have it yet when the thread's asked for again.
    onSuccess: (event, { parent }) => {
      queryClient.setQueryData<Pages>(threadKey(page), (data) =>
        updatePages(data, ([first, ...rest]) => [
          parent ? { ...first, replies: [...first.replies, event] } : { ...first, top: [event, ...first.top] },
          ...rest,
        ]),
      );
    },
  });
}

/** Ask relays to delete one of the account's comments (NIP-09), and take it off the thread. */
export function useDeletePageComment(page: string) {
  const { mutateAsync: publish } = useNostrPublish();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (comment: NostrEvent) =>
      publish({ kind: 5, content: '', tags: [['e', comment.id], ['k', String(comment.kind)]] }),
    onSuccess: (_, comment) => {
      queryClient.setQueryData<Pages>(threadKey(page), (data) =>
        updatePages(data, (pages) =>
          pages.map((p) => ({
            ...p,
            top: p.top.filter((e) => e.id !== comment.id),
            replies: p.replies.filter((e) => e.id !== comment.id),
          })),
        ),
      );
    },
  });
}

/** Like a comment, or undo the account's like (a deletion request for it). */
export function useToggleCommentLike(queryKey: readonly unknown[]) {
  const { mutateAsync: publish } = useNostrPublish();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ comment, mine }: { comment: NostrEvent; mine: NostrEvent | null }) => {
      if (mine) {
        await publish({ kind: 5, content: '', tags: [['e', mine.id], ['k', '7']] });
        return { comment, removed: mine, added: null };
      }
      const added = await publish({
        kind: 7,
        content: '+',
        tags: [['e', comment.id, '', comment.pubkey], ['p', comment.pubkey], ['k', String(comment.kind)]],
      });
      return { comment, removed: null, added };
    },
    onSuccess: ({ comment, removed, added }) => {
      queryClient.setQueryData<LikesByComment>(queryKey, (byComment) => {
        const list = (byComment?.[comment.id] ?? []).filter((r) => r.id !== removed?.id);
        return { ...byComment, [comment.id]: added ? [...list, added] : list };
      });
    },
  });
}

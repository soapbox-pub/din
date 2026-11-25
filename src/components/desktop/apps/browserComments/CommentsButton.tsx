import { MessageSquare } from 'lucide-react';
import { ToolButton } from '@/shared/appChrome';
import { toolIcon } from '@/shared/appChromeStyles';
import { useCommentCountsShown, usePageComments } from '@/hooks/usePageComments';

/**
 * The toolbar's button for the comments pane. With "Show comment counts" on
 * (about:preferences), it says how many comments the page has, which asks
 * relays about each page as it's shown; otherwise only an open pane asks.
 * Private windows never count.
 */
export function CommentsButton({
  page,
  open,
  countable,
  onToggle,
}: {
  /** The page's canonical URL, or null when it can't have comments. */
  page: string | null;
  open: boolean;
  /** Whether this window may count pages' comments unasked (not a private one). */
  countable: boolean;
  onToggle: () => void;
}) {
  const [countsShown] = useCommentCountsShown();
  const { data: thread } = usePageComments(open || (countsShown && countable) ? page : null);
  const count = thread?.all.length ?? 0;
  const label = open ? 'Hide comments' : count > 0 ? `Comments (${count})` : 'Comments';

  return (
    <ToolButton label={label} pressed={open} onClick={onToggle} className="relative">
      <MessageSquare {...toolIcon} />
      {count > 0 && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-pigment px-1 text-[0.625rem] leading-4 font-semibold text-primary-foreground tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </ToolButton>
  );
}

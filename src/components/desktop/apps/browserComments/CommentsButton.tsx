import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The address bar's button for the comments pane. It says nothing about how
 * many comments a page has: finding out would tell relays every page the
 * user visits, so only opening the pane asks about one.
 */
export function CommentsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? 'Hide comments' : 'Comments';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={onToggle}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground',
        'hover:bg-foreground/[0.07] hover:text-foreground',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        open && 'bg-foreground/10 text-foreground',
      )}
    >
      <MessageCircle className="size-4.5" strokeWidth={1.75} />
    </button>
  );
}

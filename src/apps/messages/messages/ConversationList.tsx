import { Copy, MailCheck, Trash2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { PhoneConversation } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { Avatar } from './Avatar';
import { conversationKey, displayName, listTime, preview } from './format';

/**
 * The conversations, newest first. Right-click a row for what can be done
 * with it; the arrow keys move between rows.
 */
export function ConversationList({
  conversations,
  loading,
  selected,
  phoneNames,
  onSelect,
  onMarkRead,
  onCopyNumbers,
  onDelete,
}: {
  conversations: PhoneConversation[];
  loading: boolean;
  selected: string | null;
  /** The phone each conversation is on, shown when there's more than one. */
  phoneNames: Map<string, string> | null;
  onSelect: (c: PhoneConversation) => void;
  onMarkRead: (c: PhoneConversation) => void;
  onCopyNumbers: (c: PhoneConversation) => void;
  onDelete: (c: PhoneConversation) => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-1 p-2" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-2 py-2.5">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const move = (e: React.KeyboardEvent, delta: number) => {
    e.preventDefault();
    const at = conversations.findIndex((c) => conversationKey(c) === selected);
    const next = conversations[Math.max(0, Math.min(conversations.length - 1, at + delta))];
    if (next) {
      onSelect(next);
      document.getElementById(`conversation-${conversationKey(next)}`)?.focus();
    }
  };

  return (
    <ul
      role="listbox"
      aria-label="Conversations"
      className="flex flex-col gap-0.5 p-2"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(e, 1);
        else if (e.key === 'ArrowUp') move(e, -1);
      }}
    >
      {conversations.map((c) => {
        const key = conversationKey(c);
        const current = key === selected;
        const name = displayName(c.name);
        return (
          <ContextMenu key={key}>
            <ContextMenuTrigger asChild>
              <li
                id={`conversation-${key}`}
                role="option"
                aria-selected={current}
                tabIndex={current || (!selected && c === conversations[0]) ? 0 : -1}
                onClick={() => onSelect(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(c);
                  }
                }}
                className={cn(
                  'flex cursor-default items-center gap-3 rounded-xl px-2 py-2.5 outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  current ? 'bg-primary text-primary-foreground' : 'hover:bg-foreground/[0.06]',
                )}
              >
                <div className="relative">
                  <Avatar name={c.name} group={c.addresses.length > 1} className="size-11 text-base" />
                  {c.unread > 0 && !current && (
                    <span className="absolute -left-1 top-1/2 size-2.5 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-[15px]', c.unread > 0 ? 'font-semibold' : 'font-medium')}>{name}</span>
                    <time className={cn('shrink-0 text-xs', current ? 'text-primary-foreground/80' : 'text-muted-foreground')} dateTime={new Date(c.last.time).toISOString()}>
                      {listTime(c.last.time)}
                    </time>
                  </div>
                  <p className={cn('line-clamp-2 text-[13px] leading-snug', current ? 'text-primary-foreground/85' : c.unread > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                    {preview(c)}
                  </p>
                  {phoneNames && (
                    <p className={cn('mt-0.5 truncate text-[11px]', current ? 'text-primary-foreground/70' : 'text-muted-foreground/80')}>
                      {phoneNames.get(c.phoneId)}
                    </p>
                  )}
                </div>
                <span className="sr-only">{c.unread > 0 ? `${c.unread} unread` : ''}</span>
              </li>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem disabled={c.unread === 0} onSelect={() => onMarkRead(c)}>
                <MailCheck aria-hidden />
                Mark as Read
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCopyNumbers(c)}>
                <Copy aria-hidden />
                {c.addresses.length > 1 ? 'Copy Numbers' : 'Copy Number'}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => onDelete(c)}>
                <Trash2 aria-hidden />
                Delete Conversation…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </ul>
  );
}

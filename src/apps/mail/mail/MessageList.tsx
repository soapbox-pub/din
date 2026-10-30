import { useEffect, useRef, type ComponentProps, type KeyboardEvent, type MouseEvent } from 'react';
import { Archive, Flag, FlagOff, Folder, Forward, Mail, MailOpen, OctagonAlert, Paperclip, Reply, ReplyAll, Trash2, Inbox, Pencil } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { MailboxInfo } from '@/lib/mail';
import type { Item } from './api';
import type { MessageAction } from './actions';
import { addressLine, displayName, listDate } from './format';
import { MAIL_DRAG, mailboxTitle, SPECIAL_ICONS } from './mailboxes';

const MessageRow = ({
  item,
  selected,
  active,
  recipients,
  className,
  ...props
}: ComponentProps<'div'> & { item: Item; selected: boolean; active: boolean; recipients: boolean }) => {
  const who = recipients ? addressLine(item.to) || 'No Recipients' : displayName(item.from[0]) || 'Unknown Sender';
  const highlight = selected && active;
  return (
    <div
      role="option"
      aria-selected={selected}
      id={`msg-${item.key}`}
      {...props}
      className={cn(
        'relative mx-2 flex cursor-default gap-1 rounded-lg py-2.5 pr-3 select-none [content-visibility:auto] [contain-intrinsic-size:auto_84px]',
        highlight ? 'bg-primary text-primary-foreground' : selected ? 'bg-foreground/10' : 'hover:bg-foreground/[0.03]',
        className,
      )}
    >
      <div className="flex w-5 shrink-0 justify-center pt-1.5">
        {!item.seen && <span aria-label="Unread" className={cn('size-2.5 rounded-full', highlight ? 'bg-primary-foreground' : 'bg-primary')} />}
        {item.seen && item.answered && <Reply aria-label="Replied" className={cn('size-3.5', highlight ? 'opacity-80' : 'text-muted-foreground')} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', item.seen ? 'font-medium' : 'font-semibold')}>{item.draft && !recipients ? 'Draft' : who}</span>
          <span className={cn('shrink-0 text-xs tabular-nums', highlight ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{listDate(item.date)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px]">{item.subject || 'No Subject'}</span>
          {item.hasAttachments && <Paperclip aria-label="Has attachments" className={cn('size-3.5 shrink-0', highlight ? 'opacity-80' : 'text-muted-foreground')} />}
          {item.flagged && <Flag aria-label="Flagged" className={cn('size-3.5 shrink-0', highlight ? 'fill-current' : 'fill-orange-500 text-orange-500')} />}
        </div>
        <p className={cn('mt-0.5 line-clamp-2 text-[13px] leading-snug', highlight ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
          {item.preview ?? '\u00a0'}
        </p>
      </div>
      {!highlight && <div aria-hidden className="absolute right-0 bottom-0 left-7 h-px bg-border/70" />}
    </div>
  );
};

export function ListSkeleton() {
  return (
    <div className="space-y-1 px-2 pt-1" aria-busy="true" aria-label="Loading messages">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex gap-1 py-2.5 pr-3">
          <div className="w-5" />
          <div className="flex-1 space-y-2">
            <div className="flex justify-between gap-4">
              <div className="h-3.5 w-2/5 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
              <div className="h-3 w-12 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
            </div>
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
            <div className="h-3 w-full animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function MessageList({
  items,
  selected,
  recipients,
  boxesFor,
  hasMore,
  loadingMore,
  onLoadMore,
  onClickRow,
  onOpenRow,
  onKeyDown,
  onAction,
  onMove,
  targetsFor,
  active,
  onActiveChange,
}: {
  items: Item[];
  selected: Set<string>;
  /** Sent and Drafts list who mail went to, not who it's from. */
  recipients: boolean;
  boxesFor: (accountId: string) => MailboxInfo[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onClickRow: (e: MouseEvent, item: Item) => void;
  onOpenRow: (item: Item) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onAction: (action: MessageAction, item: Item) => void;
  onMove: (item: Item, path: string) => void;
  /** The messages a menu on this row acts on: the selection if the row is in it. */
  targetsFor: (item: Item) => Item[];
  active: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = useRef(onLoadMore);
  useEffect(() => {
    more.current = onLoadMore;
  });

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current();
    }, { root: list.current, rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, items.length]);

  // Keep the selected row in view as the keyboard moves it.
  const lastSelected = [...selected].at(-1);
  useEffect(() => {
    if (!lastSelected) return;
    document.getElementById(`msg-${lastSelected}`)?.scrollIntoView({ block: 'nearest' });
  }, [lastSelected]);

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Messages"
      aria-multiselectable="true"
      aria-activedescendant={lastSelected ? `msg-${lastSelected}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => onActiveChange(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onActiveChange(false);
      }}
      className="min-h-0 flex-1 overflow-y-auto pt-1 pb-2 outline-none"
    >
      {items.map((item) => {
        const targets = targetsFor(item);
        const many = targets.length > 1;
        const allRead = targets.every((t) => t.seen);
        const allFlagged = targets.every((t) => t.flagged);
        const inJunk = boxesFor(item.accountId).find((b) => b.path === item.path)?.special === 'junk';
        const moveTargets = boxesFor(item.accountId).filter((b) => b.selectable && b.path !== item.path);
        return (
          <ContextMenu key={item.key}>
            <ContextMenuTrigger asChild>
              <MessageRow
                item={item}
                recipients={recipients}
                selected={selected.has(item.key)}
                active={active}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(MAIL_DRAG, JSON.stringify(targets.map((t) => t.key)));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={(e) => onClickRow(e, item)}
                onDoubleClick={() => onOpenRow(item)}
              />
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              {item.draft && !many && (
                <>
                  <ContextMenuItem onSelect={() => onAction('open-draft', item)}>
                    <Pencil /> Open Draft
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem disabled={many} onSelect={() => onAction('reply', item)}>
                <Reply /> Reply
              </ContextMenuItem>
              <ContextMenuItem disabled={many} onSelect={() => onAction('reply-all', item)}>
                <ReplyAll /> Reply All
              </ContextMenuItem>
              <ContextMenuItem disabled={many} onSelect={() => onAction('forward', item)}>
                <Forward /> Forward
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onAction(allRead ? 'unread' : 'read', item)}>
                {allRead ? <Mail /> : <MailOpen />} {allRead ? 'Mark as Unread' : 'Mark as Read'}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onAction(allFlagged ? 'unflag' : 'flag', item)}>
                {allFlagged ? <FlagOff /> : <Flag />} {allFlagged ? 'Unflag' : 'Flag'}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onAction('archive', item)}>
                <Archive /> Archive
              </ContextMenuItem>
              {inJunk ? (
                <ContextMenuItem onSelect={() => onAction('not-junk', item)}>
                  <Inbox /> Not Junk
                </ContextMenuItem>
              ) : (
                <ContextMenuItem onSelect={() => onAction('junk', item)}>
                  <OctagonAlert /> Move to Junk
                </ContextMenuItem>
              )}
              {moveTargets.length > 0 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger className="gap-2">
                    <Folder /> Move to
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-80 overflow-y-auto">
                    {moveTargets.map((b) => {
                      const Icon = b.special ? SPECIAL_ICONS[b.special] : Folder;
                      return (
                        <ContextMenuItem key={b.path} onSelect={() => onMove(item, b.path)}>
                          <Icon /> {mailboxTitle(b)}
                        </ContextMenuItem>
                      );
                    })}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => onAction('trash', item)}>
                <Trash2 /> Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {hasMore && (
        <div ref={sentinel} className="flex h-12 items-center justify-center text-xs text-muted-foreground">
          {loadingMore ? 'Loading…' : ''}
        </div>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Archive, Mail, MailOpen, Paperclip, Star, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { MailboxInfo } from '@/lib/mail';
import type { Item } from './api';
import { addressLine, displayName, listDate } from './format';
import { MAIL_DRAG } from './mailboxes';
import { messageMenu, type MenuPick } from './menu';
import { ContextEntries } from './MenuEntries';

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground"
    >
      {children}
    </button>
  );
}

const MessageRow = ({
  item,
  selected,
  cursor,
  recipients,
  onPick,
  className,
  ...props
}: ComponentProps<'div'> & { item: Item; selected: boolean; cursor: boolean; recipients: boolean; onPick: (pick: MenuPick) => void }) => {
  const who = item.draft && !recipients ? 'Draft' : recipients ? addressLine(item.to) || 'No Recipients' : displayName(item.from[0]) || 'Unknown Sender';
  const unread = !item.seen;
  const date = listDate(item.date);
  return (
    <div
      role="option"
      aria-selected={selected}
      id={`msg-${item.key}`}
      {...props}
      className={cn(
        'group relative flex cursor-default items-center gap-1 border-b border-border/50 py-1.5 pr-3 pl-1.5 text-[13px] select-none @2xl:h-10 @2xl:py-0',
        '[content-visibility:auto] [contain-intrinsic-size:auto_56px] @2xl:[contain-intrinsic-size:auto_40px]',
        selected ? 'bg-primary/12' : unread ? 'bg-background hover:bg-foreground/[0.04]' : 'bg-foreground/[0.025] hover:bg-foreground/[0.06]',
        cursor && 'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary',
        className,
      )}
    >
      <RowButton label={item.flagged ? 'Remove star' : 'Star'} onClick={() => onPick(item.flagged ? 'unflag' : 'flag')}>
        <Star className={cn('size-4', item.flagged ? 'fill-amber-400 text-amber-500' : 'opacity-60 group-hover:opacity-100')} strokeWidth={1.75} />
      </RowButton>
      <div className="min-w-0 flex-1 pl-1 @2xl:flex @2xl:items-center @2xl:gap-4">
        <div className="flex items-baseline gap-2 @2xl:w-52 @2xl:shrink-0">
          <span className={cn('min-w-0 flex-1 truncate', unread ? 'font-semibold' : 'text-foreground/85')}>{who}</span>
          <span className={cn('shrink-0 text-xs tabular-nums @2xl:hidden', unread ? 'font-semibold' : 'text-muted-foreground')}>{date}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">
            <span className={unread ? 'font-semibold' : 'text-foreground/85'}>{item.subject || 'No Subject'}</span>
            {item.preview && <span className="text-muted-foreground"> — {item.preview}</span>}
          </span>
          {item.hasAttachments && <Paperclip aria-label="Has attachments" className="size-3.5 shrink-0 text-muted-foreground" />}
        </div>
      </div>
      <span className={cn('hidden w-20 shrink-0 text-right text-xs tabular-nums @2xl:block @2xl:group-hover:hidden', unread ? 'font-semibold' : 'text-muted-foreground')}>{date}</span>
      <div className="hidden shrink-0 items-center group-hover:flex">
        <RowButton label="Archive" onClick={() => onPick('archive')}><Archive className="size-4" strokeWidth={1.75} /></RowButton>
        <RowButton label="Delete" onClick={() => onPick('trash')}><Trash2 className="size-4" strokeWidth={1.75} /></RowButton>
        <RowButton label={unread ? 'Mark as read' : 'Mark as unread'} onClick={() => onPick(unread ? 'read' : 'unread')}>
          {unread ? <MailOpen className="size-4" strokeWidth={1.75} /> : <Mail className="size-4" strokeWidth={1.75} />}
        </RowButton>
      </div>
    </div>
  );
};

export function ListSkeleton() {
  return (
    <div className="pt-1" aria-busy="true" aria-label="Loading messages">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border/50 py-3 pr-3 pl-10">
          <div className="h-3.5 w-40 shrink-0 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
          <div className="h-3.5 flex-1 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
          <div className="h-3 w-12 shrink-0 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

export function MessageList({
  items,
  selected,
  cursor,
  recipients,
  boxesFor,
  hasMore,
  loadingMore,
  onLoadMore,
  onClickRow,
  onKeyDown,
  onPick,
  targetsFor,
  restoreScroll,
  onScroll,
}: {
  items: Item[];
  /** The messages chosen to act on together (Ctrl- and Shift-click). */
  selected: Set<string>;
  /** The row the keyboard is on. */
  cursor: string | null;
  /** Sent and Drafts list who mail went to, not who it's from. */
  recipients: boolean;
  boxesFor: (accountId: string) => MailboxInfo[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onClickRow: (e: MouseEvent, item: Item) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  /** Something picked on a row: its menu, its star, or its hover buttons. */
  onPick: (pick: MenuPick, item: Item) => void;
  /** The messages a menu on this row acts on: the selection if the row is in it. */
  targetsFor: (item: Item) => Item[];
  /** Where to scroll to on showing, once: where a window Din reopened was left. */
  restoreScroll?: () => number;
  onScroll?: (top: number) => void;
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

  useLayoutEffect(() => {
    const top = restoreScroll?.() ?? 0;
    if (top && list.current) list.current.scrollTop = top;
    // Only on showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the keyboard's row in view as it moves.
  useEffect(() => {
    if (!cursor) return;
    document.getElementById(`msg-${cursor}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Messages"
      aria-multiselectable="true"
      aria-activedescendant={cursor ? `msg-${cursor}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={onScroll ? (e) => onScroll(e.currentTarget.scrollTop) : undefined}
      className="@container min-h-0 flex-1 overflow-y-auto pb-2 outline-none"
    >
      {items.map((item) => (
        <ContextMenu key={item.key}>
          <ContextMenuTrigger asChild>
            <MessageRow
              item={item}
              recipients={recipients}
              selected={selected.has(item.key)}
              cursor={cursor === item.key}
              onPick={(pick) => onPick(pick, item)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MAIL_DRAG, JSON.stringify(targetsFor(item).map((t) => t.key)));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={(e) => onClickRow(e, item)}
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <RowMenu item={item} targets={targetsFor(item)} boxes={boxesFor(item.accountId)} onPick={onPick} />
          </ContextMenuContent>
        </ContextMenu>
      ))}
      {hasMore && (
        <div ref={sentinel} className="flex h-12 items-center justify-center text-xs text-muted-foreground">
          {loadingMore ? 'Loading…' : ''}
        </div>
      )}
    </div>
  );
}

/** Built only when the menu opens, not for every row of the list. */
function RowMenu({ item, targets, boxes, onPick }: { item: Item; targets: Item[]; boxes: MailboxInfo[]; onPick: (pick: MenuPick, item: Item) => void }) {
  return <ContextEntries entries={messageMenu(targets, boxes)} onPick={(pick) => onPick(pick, item)} />;
}

import { useEffect, useLayoutEffect, useRef, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Archive, Check, Mail, MailOpen, Minus, Paperclip, Star, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { MailboxInfo, MailLabels } from '@/lib/mail';
import type { Conversation } from './conversations';
import { labelsOfItems } from './labels';
import { LabelChip } from './LabelChip';
import { addressLine, displayName, listDate } from './format';
import { MAIL_DRAG } from './mailboxes';
import { Avatar } from './Avatar';
import { messageMenu, type MenuPick, type TabPlace } from './menu';
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

/** A checkbox for choosing rows: one on each row, and one above the list for all of them. */
export function SelectBox({ checked, label, onClick, className, ...props }: Omit<ComponentProps<'button'>, 'onClick'> & { checked: boolean | 'mixed'; label: string; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      {...props}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn('group/box grid size-7 shrink-0 place-items-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/60', className)}
    >
      <span
        className={cn(
          'grid size-4 place-items-center rounded-[4px] border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/40 group-hover/box:border-foreground/70',
        )}
      >
        {checked === 'mixed' ? <Minus className="size-3" strokeWidth={3} /> : checked && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

/** Who a conversation is between, as the list shows it: "Sam, Alex" or, with one sender, their whole name. */
function people(c: Conversation, recipients: boolean): string {
  if (recipients) return addressLine(c.latest.to) || 'No Recipients';
  const names: string[] = [];
  for (const i of [...c.items].reverse()) {
    const name = i.draft ? 'Draft' : displayName(i.from[0]) || 'Unknown Sender';
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 1) return names[0];
  return names.map((n) => (n.includes('@') ? n.split('@')[0] : n.split(/\s+/)[0])).join(', ');
}

/** At most this many labels on a row; the rest are in its menu and the reader. */
const ROW_LABELS = 3;

const MessageRow = ({
  conversation: c,
  selected,
  cursor,
  recipients,
  labels,
  hideLabel,
  onPick,
  onCheck,
  className,
  ...props
}: ComponentProps<'div'> & {
  conversation: Conversation;
  selected: boolean;
  cursor: boolean;
  recipients: boolean;
  labels: MailLabels | undefined;
  /** The label the list is of, which every row has. */
  hideLabel: string | null;
  onPick: (pick: MenuPick) => void;
  onCheck: (e: MouseEvent) => void;
}) => {
  const item = c.latest;
  const who = people(c, recipients);
  const chips = labelsOfItems(c.items, labels).filter((l) => l.id !== hideLabel);
  const unread = c.unread;
  const date = listDate(item.date);
  return (
    <div
      role="option"
      aria-selected={selected}
      id={`msg-${c.key}`}
      {...props}
      className={cn(
        'group relative flex cursor-default items-center gap-1 border-b border-border/50 py-1.5 pr-3 pl-1.5 text-[13px] select-none @2xl:h-10 @2xl:py-0',
        '[content-visibility:auto] [contain-intrinsic-size:auto_56px] @2xl:[contain-intrinsic-size:auto_40px]',
        selected ? 'bg-primary/12' : unread ? 'bg-background hover:bg-foreground/[0.04]' : 'bg-foreground/[0.025] hover:bg-foreground/[0.06]',
        cursor && 'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary',
        className,
      )}
    >
      <SelectBox checked={selected} label="Select" tabIndex={-1} onClick={onCheck} />
      <RowButton label={c.flagged ? 'Remove star' : 'Star'} onClick={() => onPick(c.flagged ? 'unflag' : 'flag')}>
        <Star className={cn('size-4', c.flagged ? 'fill-amber-400 text-amber-500' : 'opacity-60 group-hover:opacity-100')} strokeWidth={1.75} />
      </RowButton>
      {recipients ? <Avatar who={item.to[0]} className="mr-1 size-8 text-xs" /> : <Avatar who={item.from[0]} verified={item.senderVerified} className="mr-1 size-8 text-xs" />}
      <div className="min-w-0 flex-1 pl-1 @2xl:flex @2xl:items-center @2xl:gap-4">
        <div className="flex items-baseline gap-2 @2xl:w-52 @2xl:shrink-0">
          <span className={cn('flex min-w-0 flex-1 items-baseline gap-1', unread ? 'font-semibold' : 'text-foreground/85')}>
            <span className="truncate">{who}</span>
            {c.items.length > 1 && <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">{c.items.length}</span>}
          </span>
          <span className={cn('shrink-0 text-xs tabular-nums @2xl:hidden', unread ? 'font-semibold' : 'text-muted-foreground')}>{date}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {chips.slice(0, ROW_LABELS).map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
          {chips.length > ROW_LABELS && <span className="shrink-0 text-[11px] text-muted-foreground" title={chips.slice(ROW_LABELS).map((l) => l.name).join(', ')}>+{chips.length - ROW_LABELS}</span>}
          <span className="min-w-0 flex-1 truncate">
            <span className={unread ? 'font-semibold' : 'text-foreground/85'}>{item.subject || 'No Subject'}</span>
            {item.preview && <span className="text-muted-foreground"> — {item.preview}</span>}
          </span>
          {c.hasAttachments && <Paperclip aria-label="Has attachments" className="size-3.5 shrink-0 text-muted-foreground" />}
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
        <div key={i} className="flex items-center gap-4 border-b border-border/50 py-2 pr-3 pl-18">
          <div className="size-8 shrink-0 animate-pulse rounded-full bg-foreground/10 motion-reduce:animate-none" />
          <div className="h-3.5 w-40 shrink-0 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
          <div className="h-3.5 flex-1 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
          <div className="h-3 w-12 shrink-0 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

export function MessageList({
  conversations,
  selected,
  cursor,
  recipients,
  boxesFor,
  labelsFor,
  hideLabel,
  hasMore,
  loadingMore,
  onLoadMore,
  onClickRow,
  onCheckRow,
  onKeyDown,
  onPick,
  targetsFor,
  restoreScroll,
  onScroll,
  tabPlace = null,
}: {
  conversations: Conversation[];
  /** The conversations chosen to act on together (Ctrl- and Shift-click), by key. */
  selected: Set<string>;
  /** The row the keyboard is on. */
  cursor: string | null;
  /** Sent and Drafts list who mail went to, not who it's from. */
  recipients: boolean;
  boxesFor: (accountId: string) => MailboxInfo[];
  labelsFor: (accountId: string) => MailLabels | undefined;
  /** The label the list is of, left off its rows. */
  hideLabel: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onClickRow: (e: MouseEvent, c: Conversation) => void;
  /** A row's checkbox clicked: Shift-click takes in the rows since the last one. */
  onCheckRow: (e: MouseEvent, c: Conversation) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  /** Something picked on a row: its menu, its star, or its hover buttons. */
  onPick: (pick: MenuPick, c: Conversation) => void;
  /** The conversations a menu on this row acts on: the selection if the row is in it. */
  targetsFor: (c: Conversation) => Conversation[];
  /** Where to scroll to on showing, once: where a window Din reopened was left. */
  restoreScroll?: () => number;
  onScroll?: (top: number) => void;
  /** The inbox tab the list is of, for its rows' Move to Tab. */
  tabPlace?: TabPlace | null;
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
  }, [hasMore, conversations.length]);

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
      {conversations.map((c) => (
        <ContextMenu key={c.key}>
          <ContextMenuTrigger asChild>
            <MessageRow
              conversation={c}
              recipients={recipients}
              labels={labelsFor(c.latest.accountId)}
              hideLabel={hideLabel}
              selected={selected.has(c.key)}
              cursor={cursor === c.key}
              onPick={(pick) => onPick(pick, c)}
              onCheck={(e) => onCheckRow(e, c)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MAIL_DRAG, JSON.stringify(targetsFor(c).flatMap((t) => t.items.map((i) => i.key))));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={(e) => onClickRow(e, c)}
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <RowMenu conversation={c} targets={targetsFor(c)} boxes={boxesFor(c.latest.accountId)} labels={labelsFor(c.latest.accountId)} place={tabPlace} onPick={onPick} />
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
function RowMenu({ conversation, targets, boxes, labels, place, onPick }: { conversation: Conversation; targets: Conversation[]; boxes: MailboxInfo[]; labels: MailLabels | undefined; place: TabPlace | null; onPick: (pick: MenuPick, c: Conversation) => void }) {
  return <ContextEntries entries={messageMenu(targets.flatMap((t) => t.items), boxes, labels, undefined, targets.length === 1, place)} onPick={(pick) => onPick(pick, conversation)} />;
}

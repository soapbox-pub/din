import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, ImageOff, Link, RotateCcw } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { PhoneMessage } from '@/lib/phone';
import { formatAddress } from '@/shared/phone';
import { cn } from '@/lib/utils';
import { Avatar } from './Avatar';
import { linkify, openLink } from './links';
import { colorsFor, separatorTime, type PersonColor } from './format';
import { QUICK_REACTIONS, threadReactions, type Reaction } from '@/shared/phoneReactions';

/** A new heading over the messages after this long a gap. */
const SEPARATOR_GAP_MS = 60 * 60_000;
/** Messages from one sender this close together are drawn as one run. */
const RUN_GAP_MS = 5 * 60_000;

/**
 * A conversation's messages, as bubbles: the user's on the right in the
 * accent color, everyone else's on the left. Scrolls to the newest, and
 * stays there as messages arrive unless the user has scrolled up.
 */
export function Thread({
  messages,
  loading,
  group,
  people,
  nameOf,
  onRetry,
  onReact,
}: {
  messages: PhoneMessage[];
  loading: boolean;
  group: boolean;
  /** Everyone else in the conversation, for their colors. */
  people: string[];
  nameOf: (address: string) => string;
  onRetry: (message: PhoneMessage) => void;
  /** React to a message (or take a reaction back), or null while texts can't be sent. */
  onReact: ((message: PhoneMessage, emoji: string, removed: boolean) => void) | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // A picture that loads after the scroll pushes the newest out of view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [messages]);

  // Reactions are drawn on the message they quote, not as texts of their own.
  const reactions = useMemo(() => threadReactions(messages), [messages]);
  const shown = useMemo(() => messages.filter((m) => !reactions.hidden.has(m.id)), [messages, reactions]);
  const lastOutgoing = [...shown].reverse().find((m) => m.outgoing);
  const colors = useMemo(() => colorsFor(people), [people]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      role="log"
      aria-live="polite"
      aria-label="Messages"
    >
      <div className="mx-auto flex max-w-3xl flex-col">
        {loading && shown.length === 0 ? (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-9 w-48 rounded-2xl" />
            <Skeleton className="ml-auto h-9 w-56 rounded-2xl" />
            <Skeleton className="h-14 w-64 rounded-2xl" />
          </div>
        ) : (
          shown.map((m, i) => {
            const before = shown[i - 1];
            const after = shown[i + 1];
            const bubble = {
              reactions: reactions.on.get(m.id) ?? [],
              nameOf,
              onReact: onReact && ((emoji: string, removed: boolean) => onReact(m, emoji, removed)),
              onRetry: () => onRetry(m),
            };
            const separator = !before || m.time - before.time > SEPARATOR_GAP_MS;
            const sameAs = (x: PhoneMessage | undefined) => !!x && x.outgoing === m.outgoing && x.sender === m.sender && Math.abs(x.time - m.time) < RUN_GAP_MS;
            const startsRun = separator || !sameAs(before);
            const endsRun = !sameAs(after) || (!!after && after.time - m.time > SEPARATOR_GAP_MS);
            return (
              <Fragment key={m.id}>
                {separator && (
                  <p className="mt-3 mb-2 text-center text-[11px] font-medium text-muted-foreground">{separatorTime(m.time)}</p>
                )}
                {group && !m.outgoing ? (
                  <GroupRow message={m} startsRun={startsRun} endsRun={endsRun} colors={colors} {...bubble} />
                ) : (
                  <Bubble message={m} startsRun={startsRun} endsRun={endsRun} {...bubble} />
                )}
                {m === lastOutgoing && m.status !== 'sent' && m.status !== null && (
                  <p className={cn('mt-0.5 mr-1 text-right text-[11px]', m.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                    {m.status === 'failed' ? 'Not sent' : 'Sending…'}
                  </p>
                )}
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Someone else's message in a group: their name over the first of a run, in
 * their color, and their avatar beside the last, so whose each run is reads
 * at a glance down the left edge.
 */
interface BubbleExtras {
  reactions: Reaction[];
  nameOf: (address: string) => string;
  onReact: ((emoji: string, removed: boolean) => void) | null;
  onRetry: () => void;
}

function GroupRow({
  message,
  startsRun,
  endsRun,
  colors,
  ...extras
}: {
  message: PhoneMessage;
  startsRun: boolean;
  endsRun: boolean;
  colors: (address: string) => PersonColor;
} & BubbleExtras) {
  const { nameOf } = extras;
  const sender = message.sender ?? '';
  const name = sender ? nameOf(sender) : 'Unknown';
  return (
    <>
      {startsRun && (
        <p className={cn('mt-2 mb-0.5 ml-12 truncate text-xs font-medium', sender ? colors(sender).text : 'text-muted-foreground')}>{name}</p>
      )}
      <div className="flex items-end gap-2">
        <div className="w-7 shrink-0">
          {endsRun && <Avatar people={[{ name, address: sender }]} colors={colors} className="size-7 text-[11px]" />}
        </div>
        <div className="min-w-0 flex-1">
          <Bubble message={message} startsRun={false} endsRun={endsRun} {...extras} />
        </div>
      </div>
    </>
  );
}

function failed(message: PhoneMessage): boolean {
  return message.status === 'failed';
}

/**
 * The reactions on a message, under it on its side: each emoji once, with
 * how many, the names on hover. One of the user's own is tinted, and a click
 * on any adds the user's or takes it back.
 */
function ReactionChips({
  reactions,
  mine,
  nameOf,
  onToggle,
}: {
  reactions: Reaction[];
  mine: boolean;
  nameOf: (address: string) => string;
  onToggle: ((emoji: string) => void) | null;
}) {
  const byEmoji = new Map<string, Reaction[]>();
  for (const r of reactions) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r]);
  return (
    <div className={cn('-mt-2 flex max-w-[70%] flex-wrap gap-1 px-2', mine ? 'justify-end' : 'justify-start')}>
      {[...byEmoji].map(([emoji, list]) => {
        const yours = list.some((r) => r.sender === null);
        const who = list.map((r) => (r.sender === null ? 'You' : nameOf(r.sender))).join(', ');
        return (
          <button
            key={emoji}
            type="button"
            disabled={!onToggle}
            title={`${who} reacted ${emoji}`}
            aria-label={`${emoji} from ${who}${onToggle ? (yours ? '. Take yours back' : '. Add yours') : ''}`}
            onClick={() => onToggle?.(emoji)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full px-1.5 text-sm leading-none ring-2 ring-background',
              yours ? 'bg-selected' : 'bg-muted',
              'enabled:hover:brightness-95 focus-visible:outline-none focus-visible:ring-ring/60 disabled:cursor-default',
            )}
          >
            <span>{emoji}</span>
            {list.length > 1 && <span className="text-xs font-medium text-muted-foreground">{list.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Bubble({
  message,
  startsRun,
  endsRun,
  reactions,
  nameOf,
  onReact,
  onRetry,
}: {
  message: PhoneMessage;
  startsRun: boolean;
  endsRun: boolean;
} & BubbleExtras) {
  const mine = message.outgoing;
  const myReactions = new Set(reactions.filter((r) => r.sender === null).map((r) => r.emoji));
  // A failed or unsent message, or a stand-in, has nothing on the phone to react to.
  const react = message.status === 'sending' || failed(message) || message.unfetched ? null : onReact;
  const toggle = (emoji: string) => react?.(emoji, myReactions.has(emoji));
  const failedSend = failed(message);
  const time = new Date(message.time).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const body = useMemo(() => linkify(message.body), [message.body]);
  // The link right-clicked, if it was one, for the menu to open or copy.
  const [link, setLink] = useState<string | null>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onContextMenu={(e) => setLink((e.target as Element).closest?.('a[href]')?.getAttribute('href') ?? null)}
          className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start', startsRun ? 'mt-2' : 'mt-0.5')}>
          {message.images.length > 0 && (
            <div className={cn('flex max-w-[70%] flex-wrap gap-1', mine && 'justify-end')}>
              {message.images.map((src, i) => (
                <img key={i} src={src} alt={`Attachment ${i + 1}`} draggable={false} className="max-h-60 max-w-full rounded-2xl object-cover" />
              ))}
            </div>
          )}
          {message.body && (
            <div
              title={time}
              className={cn(
                'max-w-[70%] px-3.5 py-2 text-[15px] leading-snug break-words whitespace-pre-wrap select-text',
                'rounded-[20px]',
                mine ? 'bg-muted text-foreground' : 'bg-foreground/[0.08] text-foreground',
                mine && endsRun && 'rounded-br-md',
                !mine && endsRun && 'rounded-bl-md',
                message.status === 'sending' && 'opacity-70',
                failedSend && 'bg-destructive/15 text-foreground ring-1 ring-destructive/40',
              )}
            >
              {body}
            </div>
          )}
          {message.unfetched && !message.body && message.images.length === 0 && (
            <div
              title={time}
              className={cn(
                'flex max-w-[70%] items-center gap-2 rounded-[20px] border border-dashed border-foreground/20 px-3.5 py-2 text-sm text-muted-foreground',
                !mine && endsRun && 'rounded-bl-md',
              )}
            >
              <ImageOff className="size-4.5 shrink-0" strokeWidth={1.75} aria-hidden />
              Picture message the phone hasn’t sent yet
            </div>
          )}
          {reactions.length > 0 && <ReactionChips reactions={reactions} mine={mine} nameOf={nameOf} onToggle={react ? toggle : null} />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {react && (
          <>
            <div role="group" aria-label="React" className="flex gap-0.5 px-1 pb-1">
              {QUICK_REACTIONS.map((emoji) => (
                <ContextMenuItem
                  key={emoji}
                  aria-label={myReactions.has(emoji) ? `Remove ${emoji}` : `React ${emoji}`}
                  onSelect={() => toggle(emoji)}
                  className={cn('size-9 justify-center rounded-full p-0 text-lg', myReactions.has(emoji) && 'bg-selected')}
                >
                  {emoji}
                </ContextMenuItem>
              ))}
            </div>
            <ContextMenuSeparator />
          </>
        )}
        {link && (
          <>
            <ContextMenuItem onSelect={() => openLink(link)}>
              <ExternalLink aria-hidden />
              Open Link
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(link)}>
              <Link aria-hidden />
              Copy Link
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {message.body && (
          <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(message.body)}>
            <Copy aria-hidden />
            Copy
          </ContextMenuItem>
        )}
        {message.sender && (
          <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(message.sender ?? '')}>
            <Copy aria-hidden />
            Copy {formatAddress(message.sender)}
          </ContextMenuItem>
        )}
        {failedSend && (
          <ContextMenuItem onSelect={onRetry}>
            <RotateCcw aria-hidden />
            Try Again
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Copy, ImageOff, RotateCcw } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { PhoneMessage } from '@/lib/phone';
import { formatAddress } from '@/shared/phone';
import { cn } from '@/lib/utils';
import { Avatar } from './Avatar';
import { colorsFor, separatorTime, type PersonColor } from './format';

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
}: {
  messages: PhoneMessage[];
  loading: boolean;
  group: boolean;
  /** Everyone else in the conversation, for their colors. */
  people: string[];
  nameOf: (address: string) => string;
  onRetry: (message: PhoneMessage) => void;
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

  const lastOutgoing = [...messages].reverse().find((m) => m.outgoing);
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
        {loading && messages.length === 0 ? (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-9 w-48 rounded-2xl" />
            <Skeleton className="ml-auto h-9 w-56 rounded-2xl" />
            <Skeleton className="h-14 w-64 rounded-2xl" />
          </div>
        ) : (
          messages.map((m, i) => {
            const before = messages[i - 1];
            const after = messages[i + 1];
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
                  <GroupRow message={m} startsRun={startsRun} endsRun={endsRun} nameOf={nameOf} colors={colors} onRetry={() => onRetry(m)} />
                ) : (
                  <Bubble message={m} startsRun={startsRun} endsRun={endsRun} onRetry={() => onRetry(m)} />
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
function GroupRow({
  message,
  startsRun,
  endsRun,
  nameOf,
  colors,
  onRetry,
}: {
  message: PhoneMessage;
  startsRun: boolean;
  endsRun: boolean;
  nameOf: (address: string) => string;
  colors: (address: string) => PersonColor;
  onRetry: () => void;
}) {
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
          <Bubble message={message} startsRun={false} endsRun={endsRun} onRetry={onRetry} />
        </div>
      </div>
    </>
  );
}

function Bubble({
  message,
  startsRun,
  endsRun,
  onRetry,
}: {
  message: PhoneMessage;
  startsRun: boolean;
  endsRun: boolean;
  onRetry: () => void;
}) {
  const mine = message.outgoing;
  const failed = message.status === 'failed';
  const time = new Date(message.time).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start', startsRun ? 'mt-2' : 'mt-0.5')}>
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
                failed && 'bg-destructive/15 text-foreground ring-1 ring-destructive/40',
              )}
            >
              {message.body}
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
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
        {failed && (
          <ContextMenuItem onSelect={onRetry}>
            <RotateCcw aria-hidden />
            Try Again
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

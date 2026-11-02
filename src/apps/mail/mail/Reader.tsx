import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown, Download, FileArchive, FileImage, FileText, File as FileIcon, Forward, MailMinus, Loader2, MoreVertical, Pencil, Reply, ReplyAll, ShieldCheck, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useDin } from '@/sdk/react';
import { cn } from '@/lib/utils';
import type { MailAddress, MailAttachmentInfo, MailMessage } from '@/lib/mail';
import { useConversation, useMail, useMessage, type Item } from './api';
import { displayName, fileSize, formatAddress, fullDate, initials, listDate } from './format';
import { HtmlBody, TextBody } from './MessageBody';
import { useOpenLink } from './links';
import type { MenuEntry, MenuPick } from './menu';
import { DropdownEntries } from './MenuEntries';

export const REMOTE_KEY = 'din:mail:remote-content';

export function Avatar({ who, className }: { who: MailAddress | undefined; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-b from-zinc-400 to-zinc-500 text-sm font-semibold text-white select-none dark:from-zinc-500 dark:to-zinc-600', className)}
    >
      {initials(who)}
    </div>
  );
}

function People({ label, list }: { label: string; list: MailAddress[] }) {
  if (!list.length) return null;
  return (
    <div className="truncate text-xs text-muted-foreground">
      <span>{label}: </span>
      {list.map((a, i) => (
        <span key={i} title={formatAddress(a)}>
          {i > 0 && ', '}
          <span className="text-foreground/80">{displayName(a)}</span>
        </span>
      ))}
    </div>
  );
}

function iconFor(type: string) {
  if (type.startsWith('image/')) return FileImage;
  if (type.startsWith('text/') || type === 'application/pdf') return FileText;
  if (/zip|tar|compressed|archive/.test(type)) return FileArchive;
  return FileIcon;
}

function useSaveAttachment(item: Item) {
  const din = useDin();
  const mail = useMail();
  return useCallback(
    async (a: MailAttachmentInfo) => {
      if (!mail) return;
      try {
        const handle = await din.files.save({ title: 'Save Attachment', suggestedName: a.filename, startIn: 'downloads' });
        if (!handle) return;
        const file = await mail.attachment(item.accountId, item.path, item.uid, a.index);
        await handle.write(file.content);
      } catch (error) {
        din.toast('Couldn’t save the attachment', { body: error instanceof Error ? error.message : String(error) });
      }
    },
    [din, mail, item.accountId, item.path, item.uid],
  );
}

/** A picture sent as an attachment, shown below the message as Apple Mail does. */
function ImagePreview({ item, a }: { item: Item; a: MailAttachmentInfo }) {
  const mail = useMail();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mail || a.size > 15 * 1024 * 1024) return;
    let made: string | null = null;
    let gone = false;
    void mail.attachment(item.accountId, item.path, item.uid, a.index).then((f) => {
      if (gone) return;
      made = URL.createObjectURL(new Blob([f.content as BlobPart], { type: f.contentType }));
      setUrl(made);
    }).catch(() => {});
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [mail, item.accountId, item.path, item.uid, a.index, a.size]);
  if (!url) return null;
  return <img src={url} alt={a.filename} className="max-h-[480px] max-w-full rounded-lg border border-border/60 object-contain" />;
}

function Attachments({ item, list }: { item: Item; list: MailAttachmentInfo[] }) {
  const save = useSaveAttachment(item);
  const files = list.filter((a) => !a.inline);
  if (!files.length) return null;
  const images = files.filter((a) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.contentType));
  return (
    <div className="mt-6 space-y-4">
      {images.map((a) => (
        <ImagePreview key={a.index} item={item} a={a} />
      ))}
      <div className="border-t border-border/60 pt-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          {files.length} {files.length === 1 ? 'Attachment' : 'Attachments'}
        </div>
        <div className="flex flex-wrap gap-2">
          {files.map((a) => {
            const Icon = iconFor(a.contentType);
            return (
              <ContextMenu key={a.index}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => void save(a)}
                    title={`Save ${a.filename}`}
                    className="flex max-w-64 items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <Icon className="size-5 shrink-0 text-primary" strokeWidth={1.5} />
                    <span className="min-w-0">
                      <span className="block truncate">{a.filename}</span>
                      <span className="block text-xs text-muted-foreground">{fileSize(a.size)}</span>
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void save(a)}>
                    <Download /> Save Attachment…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading message">
      <div className="flex gap-3">
        <div className="size-10 animate-pulse rounded-full bg-foreground/10 motion-reduce:animate-none" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-4 w-1/3 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
          <div className="h-3 w-1/4 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
        </div>
      </div>
      <div className="mt-8 space-y-2.5">
        {[100, 95, 98, 70, 90, 40].map((w, i) => (
          <div key={i} className="h-3.5 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

const unsubscribedOn = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function IconButton({ label, onClick, children, ...props }: ComponentProps<'button'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      {...props}
      className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}

/** Who a message went to, in a few words: "to me, Sam". */
function recipientLine(m: MailMessage, me: Set<string>): string {
  const names = [...m.to, ...m.cc].map((a) => (me.has(a.address.toLowerCase()) ? 'me' : displayName(a)));
  return names.length ? `to ${names.join(', ')}` : 'to undisclosed recipients';
}

function Header({ item, m, me, menu, onPick, onUnsubscribe, onCollapse }: { item: Item; m: MailMessage; me: Set<string>; menu: MenuEntry[]; onPick: (pick: MenuPick) => void; onUnsubscribe: () => void; onCollapse?: () => void }) {
  const [details, setDetails] = useState(false);
  const sender = m.from[0];
  return (
    <header className="flex gap-3">
      <Avatar who={sender} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCollapse}
            disabled={!onCollapse}
            aria-label={onCollapse ? `Collapse the message from ${displayName(sender) || 'Unknown Sender'}` : undefined}
            className="flex min-w-0 flex-1 items-baseline gap-2 rounded text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-text"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-semibold">{displayName(sender) || 'Unknown Sender'}</span>
              {sender?.name && sender.address && <span className="ml-1.5 text-xs text-muted-foreground select-text">&lt;{sender.address}&gt;</span>}
            </span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(m.date).toISOString()}>
              {fullDate(m.date)}
            </time>
          </button>
          <div className="flex shrink-0 items-center">
            <IconButton label={item.flagged ? 'Remove star' : 'Star'} onClick={() => onPick(item.flagged ? 'unflag' : 'flag')}>
              <Star className={cn('size-4', item.flagged && 'fill-amber-400 text-amber-500')} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Reply" onClick={() => onPick('reply')}>
              <Reply className="size-4" strokeWidth={1.75} />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="More">
                  <MoreVertical className="size-4" strokeWidth={1.75} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownEntries entries={menu} onPick={onPick} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDetails((d) => !d)}
          aria-expanded={details}
          className="flex max-w-full items-center gap-0.5 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="truncate">{recipientLine(m, me)}</span>
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', details && 'rotate-180')} />
        </button>
        {details && (
          <div className="mt-2 space-y-0.5 rounded-lg border border-border/60 p-3">
            <div className="truncate text-xs text-muted-foreground">From: <span className="text-foreground/80 select-text">{m.from.map(formatAddress).join(', ')}</span></div>
            <People label="To" list={m.to} />
            <People label="Cc" list={m.cc} />
            <People label="Bcc" list={m.bcc} />
            <People label="Reply-To" list={m.replyTo} />
            <div className="truncate text-xs text-muted-foreground">Date: <span className="text-foreground/80">{fullDate(m.date)}</span></div>
          </div>
        )}
        {m.unsubscribe && (
          <div className="mt-1 text-xs">
            {m.unsubscribe.unsubscribed ? (
              <span className="text-muted-foreground">Unsubscribed {unsubscribedOn.format(m.unsubscribe.unsubscribed)}</span>
            ) : (
              <button type="button" onClick={onUnsubscribe} className="inline-flex items-center gap-1 font-medium text-primary outline-none hover:underline focus-visible:underline">
                <MailMinus className="size-3.5" /> Unsubscribe
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function AnswerButton({ onClick, icon: Icon, children }: { onClick: () => void; icon: LucideIcon; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-2 rounded-full border border-border px-4 text-sm font-medium outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Icon className="size-4" strokeWidth={1.75} /> {children}
    </button>
  );
}

/** A message of the conversation folded to one line: who, the start of it, when. */
function Folded({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl py-2 pr-2 text-left text-sm outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Avatar who={item.from[0]} />
      <span className={cn('w-40 shrink-0 truncate', !item.seen && 'font-semibold')}>{displayName(item.from[0]) || 'Unknown Sender'}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.draft ? 'Draft' : item.preview ?? ''}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{listDate(item.date)}</span>
    </button>
  );
}

/** One message of the conversation, open. */
function Opened({
  item,
  me,
  menu,
  remote: alwaysRemote,
  onPick,
  onMailto,
  onUnsubscribe,
  onCollapse,
}: {
  item: Item;
  me: Set<string>;
  menu: MenuEntry[];
  remote: boolean;
  onPick: (pick: MenuPick) => void;
  onMailto: (url: string) => void;
  onUnsubscribe: () => void;
  onCollapse?: () => void;
}) {
  const query = useMessage(item);
  const [loadRemote, setLoadRemote] = useState(false);
  const [hasRemote, setHasRemote] = useState(false);
  const openLink = useOpenLink(onMailto);
  const m = query.data;
  const remote = alwaysRemote || loadRemote;

  if (query.isError) {
    return (
      <div className="rounded-xl border border-border/60 p-4 text-sm">
        <p className="font-medium">This message couldn’t be opened.</p>
        <p className="mt-1 text-muted-foreground">{query.error instanceof Error ? query.error.message : String(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()} className="mt-3 rounded-full bg-primary px-3 py-1.5 text-primary-foreground">
          Try Again
        </button>
      </div>
    );
  }
  if (!m) return <ReaderSkeleton />;
  return (
    <div className="py-2">
      <Header item={item} m={m} me={me} menu={menu} onPick={onPick} onUnsubscribe={onUnsubscribe} onCollapse={onCollapse} />
      <div className="mt-3 pl-13">
        {item.draft && (
          <div className="mb-3 flex items-center gap-3 rounded-lg bg-muted/50 px-4 py-2 text-[13px]">
            <span className="flex-1 text-muted-foreground">This message is a draft.</span>
            <button type="button" onClick={() => onPick('open-draft')} className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium hover:bg-accent">
              <Pencil className="size-3.5" /> Edit
            </button>
          </div>
        )}
        {m.html && hasRemote && !remote && (
          <div className="mb-3 flex items-center gap-3 rounded-lg bg-muted/50 px-4 py-2 text-[13px]">
            <ShieldCheck className="size-4 shrink-0 text-primary" />
            <span className="flex-1 text-muted-foreground">Remote content is hidden to keep the sender from seeing when you read this.</span>
            <button type="button" onClick={() => setLoadRemote(true)} className="shrink-0 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium hover:bg-accent">
              Load Remote Content
            </button>
          </div>
        )}
        {m.html ? <HtmlBody html={m.html} allowRemote={remote} onRemote={setHasRemote} onLink={openLink} /> : <TextBody text={m.text} onLink={openLink} />}
        <Attachments item={item} list={m.attachments} />
      </div>
    </div>
  );
}

/** "Re: Re: Fwd: Lunch" as "Lunch", for the conversation's title. */
function baseSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv|vs)(\[\d+\])?\s*:\s*)+/i, '').trim() || subject;
}

/**
 * A conversation, oldest first: the messages read before folded to a line,
 * the newest and the unread open, and Reply, Reply All and Forward below
 * for the newest.
 */
export function Reader({
  items: known,
  me,
  menuFor,
  onPick,
  onRead,
  onMailto,
  onUnsubscribe,
}: {
  /** The conversation's messages the list has. */
  items: Item[];
  /** The accounts' own addresses, lowercased, to call "me". */
  me: Set<string>;
  /** A message's ⋯ menu. */
  menuFor: (item: Item) => MenuEntry[];
  onPick: (pick: MenuPick, item: Item) => void;
  /** Mark these read: they're shown. */
  onRead: (items: Item[]) => void;
  onMailto: (url: string) => void;
  onUnsubscribe: (item: Item) => void;
}) {
  const { items, loading } = useConversation(known);
  const [alwaysRemote, setAlwaysRemote] = useState(() => localStorage.getItem(REMOTE_KEY) === 'always');
  // Open from the start: what was unread when it was first shown (it's read now).
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const fresh = items.filter((i) => !shown.has(i.key));
  if (fresh.length) {
    setShown(new Set([...shown, ...fresh.map((i) => i.key)]));
    const more = fresh.filter((i) => !i.seen);
    if (more.length) setUnread(new Set([...unread, ...more.map((i) => i.key)]));
  }

  // Reading a conversation reads all of it.
  const toRead = items.filter((i) => !i.seen && !i.draft);
  const toReadKey = toRead.map((i) => i.key).join(' ');
  const read = useRef(onRead);
  useEffect(() => {
    read.current = onRead;
  });
  useEffect(() => {
    if (toRead.length) read.current(toRead);
    // Once for each set of unread messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toReadKey]);

  useEffect(() => {
    const onStorage = () => setAlwaysRemote(localStorage.getItem(REMOTE_KEY) === 'always');
    window.addEventListener('storage', onStorage);
    window.addEventListener('din-mail-remote', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('din-mail-remote', onStorage);
    };
  }, []);

  const toggle = (key: string) =>
    setToggled((t) => {
      const n = new Set(t);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const last = items.at(-1);
  const answer = [...items].reverse().find((i) => !i.draft) ?? last;
  const subject = baseSubject(items[0]?.subject || known[0]?.subject || '') || 'No Subject';

  return (
    <article className="mx-auto max-w-5xl px-6 pt-4 pb-10" aria-label={subject}>
      <h1 className="mb-4 flex items-baseline gap-3 pl-13 text-[22px] leading-snug font-normal">
        <span className="select-text">{subject}</span>
        {items.length > 1 && <span className="text-sm text-muted-foreground tabular-nums">{items.length}</span>}
        {loading && <Loader2 aria-label="Finding the rest of the conversation" className="size-4 shrink-0 animate-spin self-center text-muted-foreground motion-reduce:animate-none" />}
      </h1>
      <div className="divide-y divide-border/60">
        {items.map((item) => {
          const isLast = item.key === last?.key;
          const open = (isLast || unread.has(item.key)) !== toggled.has(item.key);
          return open ? (
            <Opened
              key={item.key}
              item={item}
              me={me}
              menu={menuFor(item)}
              remote={alwaysRemote}
              onPick={(pick) => onPick(pick, item)}
              onMailto={onMailto}
              onUnsubscribe={() => onUnsubscribe(item)}
              onCollapse={items.length > 1 ? () => toggle(item.key) : undefined}
            />
          ) : (
            <Folded key={item.key} item={item} onOpen={() => toggle(item.key)} />
          );
        })}
      </div>
      {answer && !answer.draft && (
        <div className="mt-6 flex flex-wrap gap-3 pl-13">
          <AnswerButton icon={Reply} onClick={() => onPick('reply', answer)}>Reply</AnswerButton>
          <AnswerButton icon={ReplyAll} onClick={() => onPick('reply-all', answer)}>Reply all</AnswerButton>
          <AnswerButton icon={Forward} onClick={() => onPick('forward', answer)}>Forward</AnswerButton>
        </div>
      )}
    </article>
  );
}

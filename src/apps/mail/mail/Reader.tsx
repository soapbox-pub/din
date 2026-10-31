import { useCallback, useEffect, useState } from 'react';
import { Download, FileArchive, FileImage, FileText, File as FileIcon, Mails, Pencil, ShieldCheck } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useDin } from '@/sdk/react';
import { cn } from '@/lib/utils';
import type { MailAddress, MailAttachmentInfo, MailMessage } from '@/lib/mail';
import { useMail, useMessage, type Item } from './api';
import { displayName, fileSize, formatAddress, fullDate, initials } from './format';
import { HtmlBody, TextBody } from './MessageBody';
import { useOpenLink } from './links';

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
    <div className="space-y-4 px-6 pb-8">
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
    <div className="px-6 pt-6" aria-busy="true" aria-label="Loading message">
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

function Header({ m }: { m: MailMessage }) {
  const [details, setDetails] = useState(false);
  return (
    <header className="flex gap-3 border-b border-border/60 px-6 pt-5 pb-4">
      <Avatar who={m.from[0]} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={m.from.map(formatAddress).join(', ')}>
            {displayName(m.from[0]) || 'Unknown Sender'}
          </h2>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(m.date).toISOString()}>
            {fullDate(m.date)}
          </time>
        </div>
        <div className="mt-0.5 text-[13px] font-medium select-text">{m.subject || 'No Subject'}</div>
        <div className="mt-1 space-y-0.5">
          <People label="To" list={m.to} />
          {(details || m.to.length === 0) && <People label="Cc" list={m.cc} />}
          {details && <People label="Bcc" list={m.bcc} />}
          {details && <People label="Reply-To" list={m.replyTo} />}
          {details && (
            <div className="truncate text-xs text-muted-foreground">From: <span className="text-foreground/80 select-text">{m.from.map(formatAddress).join(', ')}</span></div>
          )}
        </div>
        {(m.cc.length > 0 || m.replyTo.length > 0 || m.bcc.length > 0 || m.from[0]?.name) && (
          <button type="button" onClick={() => setDetails((d) => !d)} className="mt-1 text-xs text-primary outline-none hover:underline focus-visible:underline">
            {details ? 'Hide Details' : 'Details'}
          </button>
        )}
      </div>
    </header>
  );
}

export function Reader({ item, count, onMailto, onEditDraft }: { item: Item | null; count: number; onMailto: (url: string) => void; onEditDraft: (item: Item) => void }) {
  const query = useMessage(count === 1 ? item : null);
  const [alwaysRemote, setAlwaysRemote] = useState(() => localStorage.getItem(REMOTE_KEY) === 'always');
  const [loadRemote, setLoadRemote] = useState<string | null>(null);
  const [hasRemote, setHasRemote] = useState(false);
  const openLink = useOpenLink(onMailto);

  useEffect(() => {
    const onStorage = () => setAlwaysRemote(localStorage.getItem(REMOTE_KEY) === 'always');
    window.addEventListener('storage', onStorage);
    window.addEventListener('din-mail-remote', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('din-mail-remote', onStorage);
    };
  }, []);

  if (count > 1) {
    return (
      <div className="grid h-full place-items-center text-center text-muted-foreground">
        <div>
          <Mails className="mx-auto mb-3 size-12 opacity-40" strokeWidth={1.25} />
          <p className="text-lg font-medium">{count} messages selected</p>
        </div>
      </div>
    );
  }
  if (!item) {
    return (
      <div className="grid h-full place-items-center text-lg font-medium text-muted-foreground/70 select-none">No Message Selected</div>
    );
  }
  if (query.isError) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="font-medium">This message couldn’t be opened.</p>
          <p className="mt-1 text-sm text-muted-foreground">{query.error instanceof Error ? query.error.message : String(query.error)}</p>
          <button type="button" onClick={() => void query.refetch()} className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
            Try Again
          </button>
        </div>
      </div>
    );
  }
  const m = query.data;
  if (!m) return <ReaderSkeleton />;
  const remote = alwaysRemote || loadRemote === item.key;

  return (
    <article className="min-h-full" aria-label={m.subject || 'Message'}>
      <Header m={m} />
      {item.draft && (
        <div className="flex items-center gap-3 border-b border-border/60 bg-muted/40 px-6 py-2 text-[13px]">
          <span className="flex-1 text-muted-foreground">This message is a draft.</span>
          <button type="button" onClick={() => onEditDraft(item)} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent">
            <Pencil className="size-3.5" /> Edit
          </button>
        </div>
      )}
      {m.html && hasRemote && !remote && (
        <div className="flex items-center gap-3 border-b border-border/60 bg-muted/40 px-6 py-2 text-[13px]">
          <ShieldCheck className="size-4 shrink-0 text-primary" />
          <span className="flex-1 text-muted-foreground">Remote content in this message is hidden to keep the sender from seeing when you read it.</span>
          <button type="button" onClick={() => setLoadRemote(item.key)} className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent">
            Load Remote Content
          </button>
        </div>
      )}
      <div className={cn(m.html && 'p-3')}>
        {m.html ? <HtmlBody html={m.html} allowRemote={remote} onRemote={setHasRemote} onLink={openLink} /> : <TextBody text={m.text} onLink={openLink} />}
      </div>
      <Attachments item={item} list={m.attachments} />
    </article>
  );
}

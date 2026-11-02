import { useMemo, useState, type ComponentProps, type DragEvent } from 'react';
import { ChevronRight, Folder, Inbox, MailCheck, MailMinus, RefreshCw, Settings2, TriangleAlert, UserPlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { MailAccount, MailboxInfo, SpecialMailbox } from '@/lib/mail';
import { sameSelection, type Selection } from './api';
import { MAIL_DRAG, mailboxTitle, SPECIAL_ICONS, SPECIAL_NAMES } from './mailboxes';
import { shortCount } from './format';

/** Special mailboxes first, in a fixed order. */
const ORDER: SpecialMailbox[] = ['inbox', 'drafts', 'sent', 'junk', 'trash', 'archive', 'all', 'flagged'];

interface Node {
  box: MailboxInfo;
  depth: number;
}

function tree(list: MailboxInfo[]): Node[] {
  const children = new Map<string, MailboxInfo[]>();
  const paths = new Set(list.map((b) => b.path));
  for (const b of list) {
    const parent = paths.has(b.parent) ? b.parent : '';
    children.set(parent, [...(children.get(parent) ?? []), b]);
  }
  const rank = (b: MailboxInfo) => (b.special ? ORDER.indexOf(b.special) : ORDER.length);
  const out: Node[] = [];
  const walk = (parent: string, depth: number) => {
    const kids = (children.get(parent) ?? []).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const b of kids) {
      out.push({ box: b, depth });
      walk(b.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

const Row = ({
  icon: Icon,
  label,
  count,
  selected,
  depth = 0,
  disabled,
  tone,
  className,
  onDrop,
  ...props
}: ComponentProps<'button'> & { icon: LucideIcon; label: string; count?: number; selected: boolean; depth?: number; tone?: 'flag'; onDrop?: (e: DragEvent) => void }) => {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      {...props}
      disabled={disabled}
      aria-current={selected ? 'page' : undefined}
      onDragOver={onDrop ? (e) => {
        if (!e.dataTransfer.types.includes(MAIL_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      } : undefined}
      onDragLeave={onDrop ? () => setOver(false) : undefined}
      onDrop={onDrop ? (e) => {
        setOver(false);
        onDrop(e);
      } : undefined}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/60',
        selected ? 'bg-foreground/10 font-medium' : 'hover:bg-foreground/5',
        over && 'bg-primary/20 ring-2 ring-primary/60',
        disabled && 'opacity-50',
        className,
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <Icon className={cn('size-4 shrink-0', tone === 'flag' ? 'text-amber-500' : 'text-primary')} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className={cn('shrink-0 text-xs tabular-nums', selected ? 'font-semibold' : 'text-muted-foreground')} title={count.toLocaleString()}>{shortCount(count)}</span> : null}
    </button>
  );
};

function Section({ title, open, onToggle, children, menu }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode; menu?: React.ReactNode }) {
  const header = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-[11px] font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <ChevronRight className={cn('size-3.5 opacity-0 transition-transform group-hover:opacity-100 group-focus-visible:opacity-100', open && 'rotate-90')} />
    </button>
  );
  return (
    <div className="mb-3">
      {menu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent>{menu}</ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}
      {open && <div className="space-y-px">{children}</div>}
    </div>
  );
}

export function Sidebar({
  accounts,
  boxes,
  errors,
  selection,
  onSelect,
  onDropMessages,
  onRefresh,
  onMarkAllRead,
  onAccountSettings,
  onAddAccount,
}: {
  accounts: MailAccount[];
  boxes: Map<string, MailboxInfo[]>;
  errors: Map<string, string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onDropMessages: (e: DragEvent, accountId: string, path: string) => void;
  onRefresh: () => void;
  /** Mark everything in a mailbox (or every inbox) read, asking first. */
  onMarkAllRead: (s: Selection) => void;
  onAccountSettings: (accountId: string) => void;
  onAddAccount: () => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const favorites = useMemo(() => {
    const all = [...boxes.values()].flat();
    const unseen = (special: SpecialMailbox) => all.filter((b) => b.special === special).reduce((n, b) => n + b.unseen, 0);
    const has = (special: SpecialMailbox) => all.some((b) => b.special === special);
    return (['inbox', 'flagged', 'drafts', 'sent'] as SpecialMailbox[])
      .filter((s) => s === 'flagged' || s === 'inbox' || has(s))
      .map((special) => ({ special, unseen: special === 'inbox' ? unseen('inbox') : 0 }));
  }, [boxes]);

  const accountMenu = (id: string) => (
    <>
      <ContextMenuItem onSelect={onRefresh}>
        <RefreshCw /> Get New Mail
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onAccountSettings(id)}>
        <Settings2 /> Account Settings…
      </ContextMenuItem>
      <ContextMenuItem onSelect={onAddAccount}>
        <UserPlus /> Add Account…
      </ContextMenuItem>
    </>
  );

  return (
    <nav aria-label="Mailboxes" className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
      <Section title="Favorites" open={!closed.has('favorites')} onToggle={() => toggle('favorites')}>
        {favorites.map(({ special, unseen }) => {
          const s: Selection = { kind: 'all', special };
          const row = (
            <Row
              icon={SPECIAL_ICONS[special]}
              tone={special === 'flagged' ? 'flag' : undefined}
              label={special === 'inbox' && accounts.length > 1 ? 'All Inboxes' : SPECIAL_NAMES[special]}
              count={unseen}
              selected={sameSelection(selection, s)}
              onClick={() => onSelect(s)}
            />
          );
          if (special !== 'inbox') return <div key={special}>{row}</div>;
          return (
            <ContextMenu key={special}>
              <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onSelect(s)}>
                  <Inbox /> Open
                </ContextMenuItem>
                <ContextMenuItem disabled={!unseen} onSelect={() => onMarkAllRead(s)}>
                  <MailCheck /> Mark All as Read
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={onRefresh}>
                  <RefreshCw /> Get New Mail
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        <Row
          icon={MailMinus}
          label="Subscriptions"
          title="Mailing lists in your inbox, to unsubscribe from"
          selected={selection.kind === 'subscriptions'}
          onClick={() => onSelect({ kind: 'subscriptions' })}
        />
      </Section>

      {accounts.map((a) => {
        const list = boxes.get(a.id);
        const error = errors.get(a.id);
        return (
          <Section key={a.id} title={a.name} open={!closed.has(a.id)} onToggle={() => toggle(a.id)} menu={accountMenu(a.id)}>
            {error && !list && (
              <button
                type="button"
                onClick={() => onAccountSettings(a.id)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-foreground/5"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span className="line-clamp-3">{error}</span>
              </button>
            )}
            {!list && !error && (
              <div className="space-y-1.5 px-2 py-1" aria-hidden>
                {[70, 55, 60].map((w) => (
                  <div key={w} className="h-4 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" style={{ width: `${w}%` }} />
                ))}
              </div>
            )}
            {list &&
              tree(list).map(({ box, depth }) => {
                const s: Selection = { kind: 'mailbox', accountId: a.id, path: box.path };
                const row = (
                  <Row
                    icon={box.special ? SPECIAL_ICONS[box.special] : Folder}
                    tone={box.special === 'flagged' ? 'flag' : undefined}
                    label={mailboxTitle(box)}
                    depth={depth}
                    count={box.special === 'sent' || box.special === 'trash' || box.special === 'all' ? 0 : box.unseen}
                    selected={sameSelection(selection, s)}
                    disabled={!box.selectable}
                    onClick={() => onSelect(s)}
                    onDrop={box.selectable ? (e) => onDropMessages(e, a.id, box.path) : undefined}
                  />
                );
                return (
                  <ContextMenu key={box.path}>
                    <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                    <ContextMenuContent>
                      {box.selectable && (
                        <>
                          <ContextMenuItem onSelect={() => onSelect(s)}>
                            <Inbox /> Open
                          </ContextMenuItem>
                          <ContextMenuItem disabled={!box.unseen} onSelect={() => onMarkAllRead(s)}>
                            <MailCheck /> Mark All as Read
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                        </>
                      )}
                      {accountMenu(a.id)}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
          </Section>
        );
      })}
    </nav>
  );
}

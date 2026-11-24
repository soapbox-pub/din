import { useMemo, useState, type ComponentProps, type DragEvent, type ReactNode } from 'react';
import { ChevronRight, Folder, Inbox, MailCheck, MailMinus, MoreHorizontal, Palette, Pencil, Plus, RefreshCw, Settings2, Tag, Trash2, TriangleAlert, UserPlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SidebarHeading, ToolButton } from '@/shared/appChrome';
import { focusRing, sidebarHeadingClass, sidebarRowClass } from '@/shared/appChromeStyles';
import { LABEL_COLORS, type LabelColor, type MailAccount, type MailboxInfo, type MailLabel, type MailLabels, type SpecialMailbox } from '@/lib/mail';
import { sameSelection, type Selection } from './api';
import { accountDot } from './accounts';
import { MAIL_DRAG, mailboxTitle, SPECIAL_ICONS, SPECIAL_NAMES } from './mailboxes';
import { shortCount } from './format';
import { COLOR_NAMES, LABEL_STYLES, labelColor } from './labels';
import type { MenuEntry } from './menu';
import { ContextEntries, DropdownEntries } from './MenuEntries';

/** Special mailboxes first, in a fixed order. */
const ORDER: SpecialMailbox[] = ['inbox', 'drafts', 'sent', 'junk', 'trash', 'archive', 'all', 'flagged'];

/**
 * With several accounts, these are one row each over every account, which
 * opens to each account's own; account sections keep the rest.
 */
const UNIFIED: SpecialMailbox[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

/** Which sidebar sections and unified rows are open, where the user changed it. */
const OPEN_KEY = 'mail:sidebar-open';

function savedOpen(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
}

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

/**
 * An account's folders: on Gmail, without its labels, which are listed as
 * labels (and the folders left holding nothing but them).
 */
function folders(list: MailboxInfo[] | undefined, info: MailLabels | undefined): MailboxInfo[] | undefined {
  if (!list || info?.kind !== 'gmail') return list;
  const labelPaths = new Set(info.labels.map((l) => l.path));
  const rest = list.filter((b) => !labelPaths.has(b.path));
  return rest.filter((b) => b.selectable || rest.some((c) => c.parent === b.path));
}

const Row = ({
  icon: Icon,
  dot,
  indent = 0,
  label,
  count,
  selected,
  depth = 0,
  disabled,
  tone,
  iconClassName,
  dropEffect = 'move',
  className,
  onDrop,
  ...props
}: ComponentProps<'button'> & { icon?: LucideIcon; dot?: string; indent?: number; label: string; count?: number; selected: boolean; depth?: number; tone?: 'flag'; iconClassName?: string; dropEffect?: 'move' | 'copy'; onDrop?: (e: DragEvent) => void }) => {
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
        e.dataTransfer.dropEffect = dropEffect;
        setOver(true);
      } : undefined}
      onDragLeave={onDrop ? () => setOver(false) : undefined}
      onDrop={onDrop ? (e) => {
        setOver(false);
        onDrop(e);
      } : undefined}
      className={cn(
        sidebarRowClass(selected),
        over && 'bg-selected ring-2 ring-ring/60',
        disabled && 'opacity-50',
        className,
      )}
      style={{ paddingLeft: 10 + indent + depth * 16 }}
    >
      {dot ? (
        <span aria-hidden className="grid size-4.5 shrink-0 place-items-center"><span className={cn('size-2 rounded-full', dot)} /></span>
      ) : Icon ? (
        <Icon className={cn('size-4.5 shrink-0', iconClassName ?? (tone === 'flag' ? 'text-amber-500' : 'text-ink-accent'))} strokeWidth={1.75} />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className={cn('shrink-0 text-xs tabular-nums', selected ? 'font-semibold' : 'text-muted-foreground')} title={count.toLocaleString()}>{shortCount(count)}</span> : null}
    </button>
  );
};

/** What a label's menus can pick. */
export type LabelPick = 'open' | 'edit' | 'delete' | { color: LabelColor };

function labelMenu(label: MailLabel): MenuEntry<LabelPick>[] {
  const color = labelColor(label);
  return [
    { kind: 'item', pick: 'open', label: 'Open', icon: Tag },
    { kind: 'separator' },
    { kind: 'item', pick: 'edit', label: 'Edit Label…', icon: Pencil },
    { kind: 'sub', label: 'Color', icon: Palette, items: LABEL_COLORS.map((c) => ({ kind: 'check', pick: { color: c }, label: COLOR_NAMES[c], checked: c === color, color: c })) },
    { kind: 'separator' },
    { kind: 'item', pick: 'delete', label: 'Delete Label…', icon: Trash2, destructive: true },
  ];
}

/** A label in the sidebar, with its menu on a right-click and on the ⋯ that shows on hover. */
function LabelRow({ label, count, selected, onPick, onDrop }: { label: MailLabel; count: number; selected: boolean; onPick: (pick: LabelPick) => void; onDrop: (e: DragEvent) => void }) {
  const entries = labelMenu(label);
  return (
    <div className="group/label relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Row
            icon={Tag}
            iconClassName={cn('fill-current', LABEL_STYLES[labelColor(label)].icon)}
            label={label.name}
            title={label.name}
            count={count}
            selected={selected}
            dropEffect="copy"
            onDrop={onDrop}
            onClick={() => onPick('open')}
            className="group-focus-within/label:pr-9 group-hover/label:pr-9"
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextEntries entries={entries} onPick={onPick} />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolButton
            size="xs"
            label={`More for ${label.name}`}
            title="More"
            className="absolute top-1 right-1 opacity-0 group-hover/label:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </ToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownEntries entries={entries} onPick={onPick} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function Section({ title, dot, open, onToggle, children, menu }: { title: string; dot?: string; open: boolean; onToggle: () => void; children: ReactNode; menu?: ReactNode }) {
  const header = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn('group w-full rounded-md text-left', sidebarHeadingClass, focusRing)}
    >
      {dot && <span aria-hidden className={cn('mb-1 size-2 shrink-0 rounded-full', dot)} />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <ChevronRight className={cn('size-3.5 transition-transform motion-reduce:transition-none', open ? 'rotate-90 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100' : 'opacity-70')} />
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
      {open && <div className="space-y-0.5">{children}</div>}
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
  labels,
  onLabel,
  onNewLabel,
  onDropOnLabel,
}: {
  accounts: MailAccount[];
  boxes: Map<string, MailboxInfo[]>;
  errors: Map<string, string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onDropMessages: (e: DragEvent, accountId: string, path: string) => void;
  labels: Map<string, MailLabels>;
  /** Something picked on a label's menu (Open is `onSelect`'s). */
  onLabel: (accountId: string, label: MailLabel, pick: Exclude<LabelPick, 'open'>) => void;
  onNewLabel: (accountId: string) => void;
  /** Messages dropped on a label get it. */
  onDropOnLabel: (e: DragEvent, accountId: string, labelId: string) => void;
  onRefresh: () => void;
  /** Mark everything in a mailbox (or every inbox) read, asking first. */
  onMarkAllRead: (s: Selection) => void;
  onAccountSettings: (accountId: string) => void;
  onAddAccount: () => void;
}) {
  const several = accounts.length > 1;
  const [open, setOpen] = useState<Record<string, boolean>>(savedOpen);
  // Account sections start closed when there are several: their standard
  // mailboxes are in the unified rows above, each account's under its own.
  const isOpen = (k: string) => open[k] ?? (k.startsWith('unified:') ? false : k.startsWith('account:') ? !several : true);
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = { ...o, [k]: !isOpen(k) };
      localStorage.setItem(OPEN_KEY, JSON.stringify(n));
      return n;
    });

  const favorites = useMemo(() => {
    const all = [...boxes.values()].flat();
    const has = (special: SpecialMailbox) => all.some((b) => b.special === special && b.selectable);
    const list: SpecialMailbox[] = several ? ['inbox', 'flagged', ...UNIFIED.filter((s) => s !== 'inbox')] : ['inbox', 'flagged', 'drafts', 'sent'];
    return list.filter((s) => s === 'flagged' || s === 'inbox' || has(s));
  }, [boxes, several]);

  /** What a mailbox's row counts: not the read-anyway ones. */
  const countOf = (box: MailboxInfo) => (box.special === 'sent' || box.special === 'trash' || box.special === 'all' ? 0 : box.unseen);

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

  /** One account's mailbox, with its menu. */
  const mailboxRow = (a: MailAccount, box: MailboxInfo, props: Partial<ComponentProps<typeof Row>> = {}) => {
    const s: Selection = { kind: 'mailbox', accountId: a.id, path: box.path };
    return (
      <ContextMenu key={`${a.id}\u0000${box.path}`}>
        <ContextMenuTrigger asChild>
          <Row
            icon={box.special ? SPECIAL_ICONS[box.special] : Folder}
            tone={box.special === 'flagged' ? 'flag' : undefined}
            label={mailboxTitle(box)}
            count={countOf(box)}
            selected={sameSelection(selection, s)}
            disabled={!box.selectable}
            onClick={() => onSelect(s)}
            onDrop={box.selectable ? (e) => onDropMessages(e, a.id, box.path) : undefined}
            {...props}
          />
        </ContextMenuTrigger>
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
  };

  return (
    <nav aria-label="Mailboxes" className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
      <Section title={several ? 'Mailboxes' : 'Favorites'} open={isOpen('favorites')} onToggle={() => toggle('favorites')}>
        {favorites.map((special) => {
          const s: Selection = { kind: 'all', special };
          const name = special === 'inbox' && several ? 'All Inboxes' : SPECIAL_NAMES[special];
          // Each account's own, under the unified row (Starred is the inboxes' starred mail, not a mailbox).
          const each = several && special !== 'flagged'
            ? accounts.flatMap((a) => {
                const box = boxes.get(a.id)?.find((b) => b.special === special && b.selectable);
                return box ? [{ account: a, box }] : [];
              })
            : [];
          const unseen = special === 'flagged' ? 0 : several ? each.reduce((n, e) => n + countOf(e.box), 0) : [...boxes.values()].flat().filter((b) => b.special === 'inbox').reduce((n, b) => n + (special === 'inbox' ? b.unseen : 0), 0);
          const key = `unified:${special}`;
          const expanded = each.length > 0 && isOpen(key);
          return (
            <div key={special}>
              <div className="relative">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <Row
                      icon={SPECIAL_ICONS[special]}
                      tone={special === 'flagged' ? 'flag' : undefined}
                      label={name}
                      count={unseen}
                      indent={several ? 16 : 0}
                      selected={sameSelection(selection, s)}
                      onClick={() => onSelect(s)}
                    />
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => onSelect(s)}>
                      <Inbox /> Open
                    </ContextMenuItem>
                    {special !== 'flagged' && (
                      <ContextMenuItem disabled={!unseen} onSelect={() => onMarkAllRead(s)}>
                        <MailCheck /> Mark All as Read
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={onRefresh}>
                      <RefreshCw /> Get New Mail
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                {each.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={expanded ? `Hide each account’s ${name}` : `Show each account’s ${name}`}
                    title={expanded ? 'Hide accounts' : 'Show accounts'}
                    onClick={() => toggle(key)}
                    className={cn('absolute top-1.5 left-1 grid size-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground', focusRing)}
                  >
                    <ChevronRight className={cn('size-3.5 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
                  </button>
                )}
              </div>
              {expanded && (
                <div role="group" aria-label={`Each account’s ${name}`} className="mt-0.5 space-y-0.5">
                  {each.map(({ account, box }) =>
                    mailboxRow(account, box, { icon: undefined, dot: accountDot(accounts, account.id), label: account.email, title: `${mailboxTitle(box)} of ${account.email}`, indent: 16, depth: 1 }),
                  )}
                </div>
              )}
            </div>
          );
        })}
        <Row
          icon={MailMinus}
          label="Subscriptions"
          title="Mailing lists in your inbox, to unsubscribe from"
          indent={several ? 16 : 0}
          selected={selection.kind === 'subscriptions'}
          onClick={() => onSelect({ kind: 'subscriptions' })}
        />
      </Section>

      {accounts.map((a) => {
        const info = labels.get(a.id);
        const all = folders(boxes.get(a.id), info);
        // With several accounts, the standard mailboxes are the unified rows'.
        const list = several ? all?.filter((b) => !b.special || !UNIFIED.includes(b.special)) : all;
        const error = errors.get(a.id);
        const hasLabels = !!info && info.kind !== 'none';
        if (several && list && !list.length && !hasLabels && !error) return null;
        return (
          <Section key={a.id} title={a.email} dot={several ? accountDot(accounts, a.id) : undefined} open={isOpen(`account:${a.id}`)} onToggle={() => toggle(`account:${a.id}`)} menu={accountMenu(a.id)}>
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
            {list && tree(list).map(({ box, depth }) => mailboxRow(a, box, { depth }))}
            {list && info && hasLabels && (
              <div className={cn(list.length > 0 && 'pt-2')} role="group" aria-label={`${a.email} labels`}>
                <SidebarHeading className="pr-1">
                  <span className="min-w-0 flex-1 truncate">Labels</span>
                  <ToolButton size="xs" label={`New label in ${a.email}`} title="New label" onClick={() => onNewLabel(a.id)}>
                    <Plus className="size-4" />
                  </ToolButton>
                </SidebarHeading>
                {info.labels.map((l) => {
                  const s: Selection = { kind: 'label', accountId: a.id, id: l.id };
                  const box = l.path ? boxes.get(a.id)?.find((b) => b.path === l.path) : undefined;
                  return (
                    <LabelRow
                      key={l.id}
                      label={l}
                      count={box?.unseen ?? 0}
                      selected={sameSelection(selection, s)}
                      onPick={(pick) => (pick === 'open' ? onSelect(s) : onLabel(a.id, l, pick))}
                      onDrop={(e) => onDropOnLabel(e, a.id, l.id)}
                    />
                  );
                })}
                {!info.labels.length && (
                  <button type="button" onClick={() => onNewLabel(a.id)} className={cn(sidebarRowClass(false), 'text-muted-foreground')}>
                    Create a label…
                  </button>
                )}
              </div>
            )}
          </Section>
        );
      })}
    </nav>
  );
}

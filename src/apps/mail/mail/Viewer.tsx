import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Archive, ChevronDown, ChevronLeft, Flag, Forward, ListFilter, Loader2, Mail as MailIcon, MailOpen, OctagonAlert, PanelLeft, RefreshCw, Reply, ReplyAll, Search, SquarePen, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useDin, useMenuBar, useWindowState, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { cn } from '@/lib/utils';
import { parseMailto } from '@/lib/mailto';
import type { MailAccount, MailboxInfo, MessageFilter, SpecialMailbox } from '@/lib/mail';
import type { MenuItem } from '@/sdk/din';
import { itemKey, sourcesOf, useAccounts, useLiveUpdates, useMail, useMailboxes, useMessages, type Item, type Selection } from './api';
import { useMessageActions, type MessageAction } from './actions';
import { blankSeed, displayName, parseAddresses } from './format';
import { rememberAddresses } from './contacts';
import { Sidebar } from './Sidebar';
import { MAIL_DRAG, mailboxTitle, SPECIAL_NAMES } from './mailboxes';
import { ListSkeleton, MessageList } from './MessageList';
import { Reader } from './Reader';
import { AccountSetup } from './AccountSetup';
import { AccountSettings } from './AccountSettings';

const SELECTION_KEY = 'din:mail:selection';
const SIDEBAR_KEY = 'din:mail:sidebar';
const WIDTHS_KEY = 'din:mail:widths';

function loadSelection(): Selection {
  try {
    const s = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as Selection | null;
    if (s && (s.kind === 'all' || (s.kind === 'mailbox' && typeof s.accountId === 'string' && typeof s.path === 'string'))) return s;
  } catch {
    // The default below.
  }
  return { kind: 'all', special: 'inbox' };
}

function loadWidths(): { sidebar: number; list: number } {
  try {
    const w = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as { sidebar?: number; list?: number } | null;
    return { sidebar: w?.sidebar ?? 220, list: w?.list ?? 360 };
  } catch {
    return { sidebar: 220, list: 360 };
  }
}

/** A border to drag, between two panes. */
function Splitter({ onDrag, onDone, label }: { onDrag: (dx: number) => void; onDone: () => void; label: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let x = e.clientX;
        const move = (ev: PointerEvent) => {
          onDrag(ev.clientX - x);
          x = ev.clientX;
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          onDone();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}

function ToolButton({ label, onClick, disabled, children, active, className }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; active?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none',
        'hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-35',
        active && 'bg-foreground/10 text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm text-center">
        <img src="/icons/apps/mail.png" alt="" className="mx-auto mb-4 size-28 drop-shadow-md" />
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Mail</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">Read and send email from iCloud, Gmail, Fastmail, Yahoo or any account with IMAP.</p>
        <button type="button" onClick={onAdd} className="mt-6 rounded-lg bg-primary px-4 py-2 text-[15px] font-medium text-primary-foreground shadow-sm outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60">
          Add an Account
        </button>
      </div>
    </div>
  );
}

export function Viewer() {
  const din = useDin();
  const mail = useMail();
  const qc = useQueryClient();
  const accountsQuery = useAccounts();
  const accounts = useMemo<MailAccount[]>(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const { boxes, errors, fetching: boxesFetching } = useMailboxes(accounts);
  useLiveUpdates();

  const [chosenMailbox, setSelectionState] = useState<Selection>(loadSelection);
  const [filter, setFilter] = useState<MessageFilter>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [listActive, setListActive] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden');
  const [widths, setWidths] = useState(loadWidths);
  const [dialog, setDialog] = useState<{ kind: 'setup' } | { kind: 'settings'; accountId: string | null } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { bounds } = useWindowState();
  const width = bounds.width || window.innerWidth;
  const narrow = width < 640;
  const showSidebar = sidebarOpen && width >= 860;

  const setSelection = useCallback((s: Selection) => {
    setSelectionState(s);
    setSelected(new Set());
    anchor.current = null;
    localStorage.setItem(SELECTION_KEY, JSON.stringify(s));
  }, []);

  // A mailbox whose account went away falls back to the inboxes.
  const selection = useMemo<Selection>(
    () => (chosenMailbox.kind === 'mailbox' && accountsQuery.data && !accounts.some((a) => a.id === chosenMailbox.accountId) ? { kind: 'all', special: 'inbox' } : chosenMailbox),
    [chosenMailbox, accounts, accountsQuery.data],
  );

  // Searching waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const sources = useMemo(() => sourcesOf(selection, boxes), [selection, boxes]);
  const effectiveFilter: MessageFilter = selection.kind === 'all' && selection.special === 'flagged' ? 'flagged' : filter;
  const messages = useMessages(sources, effectiveFilter, query);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const page of messages.data?.pages ?? []) {
      for (const i of page.items) {
        if (seen.has(i.key)) continue;
        seen.add(i.key);
        out.push(i);
      }
    }
    return out;
  }, [messages.data]);
  const total = messages.data?.pages[0]?.total ?? 0;

  // People in the list become address suggestions.
  useEffect(() => {
    rememberAddresses(items.slice(0, 50).flatMap((i) => i.from));
  }, [items]);

  // The first message is selected when a mailbox opens, as in Apple Mail.
  const selected = useMemo(() => (chosen.size || narrow || !items.length ? chosen : new Set([items[0].key])), [chosen, narrow, items]);
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.key)), [items, selected]);
  const current = selectedItems.length === 1 ? selectedItems[0] : null;

  const box = (accountId: string, path: string): MailboxInfo | undefined => boxes.get(accountId)?.find((b) => b.path === path);
  const special = selection.kind === 'all' ? selection.special : box(selection.accountId, selection.path)?.special ?? null;
  const recipients = special === 'sent' || special === 'drafts';

  const title =
    selection.kind === 'all'
      ? selection.special === 'inbox' && accounts.length > 1
        ? 'All Inboxes'
        : SPECIAL_NAMES[selection.special]
      : mailboxTitle(box(selection.accountId, selection.path)) || selection.path;
  const unseenHere = sources.reduce((n, s) => n + (box(s.accountId, s.path)?.unseen ?? 0), 0);
  const subtitle = query
    ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`
    : effectiveFilter === 'unread'
      ? `${total.toLocaleString()} unread`
      : `${total.toLocaleString()} ${total === 1 ? 'message' : 'messages'}${unseenHere ? `, ${unseenHere.toLocaleString()} unread` : ''}`;

  useWindowTitle(title ? `${title}` : null);

  // Badge: unread mail in every inbox.
  const inboxUnseen = useMemo(() => [...boxes.values()].flat().filter((b) => b.special === 'inbox').reduce((n, b) => n + b.unseen, 0), [boxes]);
  useEffect(() => {
    din.notifications.setBadge(inboxUnseen || null);
  }, [din, inboxUnseen]);
  useEffect(() => () => din.notifications.setBadge(null), [din]);

  // New mail while the window isn't in front: a notification per message.
  const lastUnseen = useRef(new Map<string, number>());
  useEffect(() => {
    if (!mail) return;
    for (const [accountId, list] of boxes) {
      const inbox = list.find((b) => b.special === 'inbox');
      if (!inbox) continue;
      const before = lastUnseen.current.get(accountId);
      lastUnseen.current.set(accountId, inbox.unseen);
      if (before === undefined || inbox.unseen <= before || din.window.state.focused) continue;
      const fresh = inbox.unseen - before;
      void mail.messages(accountId, inbox.path, { filter: 'unread', limit: Math.min(fresh, 5) }).then((page) => {
        for (const m of page.messages) {
          if (Date.now() - m.date > 30 * 60_000) continue;
          void din.notifications.show(displayName(m.from[0]) || 'New Mail', {
            body: [m.subject, m.preview].filter(Boolean).join('\n'),
            tag: itemKey(accountId, inbox.path, m.uid),
          });
        }
      }).catch(() => {});
    }
  }, [boxes, mail, din]);

  // A message on screen is read: its notification has nothing more to say.
  useEffect(() => {
    for (const key of selected) din.notifications.close(key);
  }, [din, selected]);

  useEffect(
    () =>
      din.notifications.onAction(({ tag }) => {
        din.window.focus();
        if (!tag) return;
        const [accountId, path] = tag.split('\u0000');
        if (!accountId || !path) return;
        setSelection({ kind: 'mailbox', accountId, path });
        setSelected(new Set([tag]));
      }),
    [din, setSelection],
  );

  // Choosing a message reads it.
  const onRemoved = useCallback(
    (keys: Set<string>) => {
      setSelected((sel) => {
        if (sel.size && ![...sel].some((k) => keys.has(k))) return sel;
        const at = items.findIndex((i) => keys.has(i.key));
        const next = items.slice(at).find((i) => !keys.has(i.key)) ?? items.slice(0, at).reverse().find((i) => !keys.has(i.key));
        anchor.current = next?.key ?? null;
        return next ? new Set([next.key]) : new Set();
      });
    },
    [items],
  );
  const { run, moveTo, newMessage, compose } = useMessageActions(accounts, onRemoved);

  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!current || current.seen || current.draft || marked.current === current.key) return;
    marked.current = current.key;
    void run('read', [current]);
  }, [current, run]);

  const targetsFor = useCallback((item: Item) => (selected.has(item.key) ? selectedItems : [item]), [selected, selectedItems]);

  const onClickRow = (e: MouseEvent, item: Item) => {
    const from = anchor.current ?? [...selected][0];
    if (e.shiftKey && from) {
      const a = items.findIndex((i) => i.key === from);
      const b = items.findIndex((i) => i.key === item.key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(items.slice(lo, hi + 1).map((i) => i.key)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected);
      if (n.has(item.key)) n.delete(item.key);
      else n.add(item.key);
      setSelected(n);
      anchor.current = item.key;
      return;
    }
    setSelected(new Set([item.key]));
    anchor.current = item.key;
  };

  const onListKey = (e: KeyboardEvent) => {
    const at = items.findIndex((i) => i.key === ([...selected].at(-1) ?? anchor.current));
    const go = (index: number) => {
      const target = items[Math.max(0, Math.min(items.length - 1, index))];
      if (!target) return;
      if (e.shiftKey && anchor.current) {
        const a = items.findIndex((i) => i.key === anchor.current);
        const [lo, hi] = a < index ? [a, index] : [index, a];
        const keys = items.slice(lo, hi + 1).map((i) => i.key);
        // The moving end goes last, for scrolling and the next step.
        setSelected(new Set([...keys.filter((k) => k !== target.key), target.key]));
      } else {
        setSelected(new Set([target.key]));
        anchor.current = target.key;
      }
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(items.length - 1);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length) {
      e.preventDefault();
      void run('trash', selectedItems);
    } else if (e.key === 'Enter' && current?.draft) {
      void run('open-draft', [current]);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.key)));
    }
  };

  const onDropMessages = (e: DragEvent, accountId: string, path: string) => {
    e.preventDefault();
    let keys: string[] = [];
    try {
      keys = JSON.parse(e.dataTransfer.getData(MAIL_DRAG)) as string[];
    } catch {
      return;
    }
    const moving = items.filter((i) => keys.includes(i.key));
    void moveTo(moving, accountId, path);
  };

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['mail', 'mailboxes'] });
    void qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
  }, [qc]);

  const defaultAccount = selection.kind === 'mailbox' ? selection.accountId : current?.accountId ?? accounts[0]?.id ?? null;
  const act = (action: MessageAction) => void run(action, selectedItems);
  const has = selectedItems.length > 0;
  const allFlagged = has && selectedItems.every((i) => i.flagged);
  const allRead = has && selectedItems.every((i) => i.seen);
  const inJunk = special === 'junk';
  const refreshing = boxesFetching || messages.isRefetching;

  const openMailto = useCallback(
    (url: string) => {
      const m = parseMailto(url);
      compose({ ...blankSeed(defaultAccount), to: parseAddresses(m.to.join(',')), cc: parseAddresses(m.cc.join(',')), bcc: parseAddresses(m.bcc.join(',')), subject: m.subject, html: m.body ? `<p>${m.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` : '' });
    },
    [compose, defaultAccount],
  );

  // Without the sidebar, the list's title picks the mailbox.
  const pickMailbox = async (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const favorites: MenuItem[] = (['inbox', 'flagged', 'drafts', 'sent'] as const).map((sp) => ({
      id: `all:${sp}`,
      label: sp === 'inbox' && accounts.length > 1 ? 'All Inboxes' : SPECIAL_NAMES[sp],
      type: 'radio',
      group: 'mailbox',
      checked: selection.kind === 'all' && selection.special === sp,
    }));
    const perAccount: MenuItem[] = accounts.map((a) => ({
      id: `account:${a.id}`,
      label: a.name,
      type: 'submenu',
      items: (boxes.get(a.id) ?? []).filter((b) => b.selectable).map((b) => ({ id: `box:${a.id}\u0000${b.path}`, label: mailboxTitle(b) })),
    }));
    const choice = await din.menus.popup([...favorites, { type: 'separator' }, ...perAccount], { x: r.left, y: r.bottom + 4 });
    if (!choice) return;
    if (choice.startsWith('all:')) setSelection({ kind: 'all', special: choice.slice(4) as SpecialMailbox });
    else if (choice.startsWith('box:')) {
      const [accountId, path] = choice.slice(4).split('\u0000');
      setSelection({ kind: 'mailbox', accountId, path });
    }
  };

  useMenuBar(
    [
      {
        label: 'File',
        items: [
          { id: 'new', label: 'New Message', accelerator: 'Ctrl+N' },
          { id: 'window', label: 'New Viewer Window', accelerator: 'Ctrl+Alt+N' },
          { type: 'separator' },
          { id: 'add-account', label: 'Add Account…' },
          { id: 'settings', label: 'Settings…', accelerator: 'Ctrl+,' },
        ],
      },
      {
        label: 'View',
        items: [
          { id: 'sidebar', label: 'Show Sidebar', type: 'checkbox', checked: sidebarOpen, accelerator: 'Ctrl+Alt+S' },
          { id: 'unread', label: 'Show Only Unread', type: 'checkbox', checked: filter === 'unread', accelerator: 'Ctrl+Alt+U' },
          { type: 'separator' },
          { id: 'search', label: 'Search', accelerator: 'Ctrl+F', notInFields: true },
        ],
      },
      {
        label: 'Mailbox',
        items: [{ id: 'refresh', label: 'Get All New Mail', accelerator: 'Ctrl+Shift+N' }],
      },
      {
        label: 'Message',
        items: [
          { id: 'reply', label: 'Reply', accelerator: 'Ctrl+R', enabled: !!current },
          { id: 'reply-all', label: 'Reply All', accelerator: 'Ctrl+Shift+R', enabled: !!current },
          { id: 'forward', label: 'Forward', accelerator: 'Ctrl+Shift+F', enabled: !!current },
          { type: 'separator' },
          { id: allRead ? 'unread-msg' : 'read-msg', label: allRead ? 'Mark as Unread' : 'Mark as Read', accelerator: 'Ctrl+Shift+U', enabled: has },
          { id: allFlagged ? 'unflag' : 'flag', label: allFlagged ? 'Unflag' : 'Flag', accelerator: 'Ctrl+Shift+L', enabled: has },
          { type: 'separator' },
          { id: 'archive', label: 'Archive', accelerator: 'Ctrl+Shift+A', enabled: has },
          { id: inJunk ? 'not-junk' : 'junk', label: inJunk ? 'Not Junk' : 'Move to Junk', accelerator: 'Ctrl+Shift+J', enabled: has },
          { id: 'trash', label: 'Delete', accelerator: 'Delete', notInFields: true, enabled: has, destructive: true },
        ],
      },
    ],
    (id) => {
      switch (id) {
        case 'new': return newMessage(defaultAccount);
        case 'window': return void din.app.open('mail', { viewer: true });
        case 'add-account': return setDialog({ kind: 'setup' });
        case 'settings': return setDialog({ kind: 'settings', accountId: null });
        case 'sidebar':
          setSidebarOpen((v) => {
            localStorage.setItem(SIDEBAR_KEY, v ? 'hidden' : 'shown');
            return !v;
          });
          return;
        case 'unread': return setFilter((f) => (f === 'unread' ? null : 'unread'));
        case 'search': return searchInput.current?.focus();
        case 'refresh': return refresh();
        case 'read-msg': return act('read');
        case 'unread-msg': return act('unread');
        case 'reply':
        case 'reply-all':
        case 'forward':
        case 'flag':
        case 'unflag':
        case 'archive':
        case 'junk':
        case 'not-junk':
        case 'trash':
          return act(id);
      }
    },
  );

  if (!mail) {
    return (
      <div className="flex h-full flex-col bg-background">
        <WindowDragRegion className="flex h-12 shrink-0 items-center justify-end px-3"><WindowControls /></WindowDragRegion>
        <div className="grid flex-1 place-items-center p-8 text-center text-muted-foreground">Mail needs the Din desktop app to reach mail servers.</div>
      </div>
    );
  }

  const noAccounts = accountsQuery.isSuccess && accounts.length === 0;
  const readerOnly = narrow && !!current;

  const toolbar = (
    <WindowDragRegion className="flex h-13 shrink-0 items-center gap-0.5 border-b border-border/60 pr-3 pl-2">
      {narrow && current && (
        <ToolButton label="Back to messages" onClick={() => setSelected(new Set())}><ChevronLeft className="size-4.5" /></ToolButton>
      )}
      <ToolButton label="Archive" onClick={() => act('archive')} disabled={!has}><Archive className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label="Delete" onClick={() => act('trash')} disabled={!has}><Trash2 className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label={inJunk ? 'Not Junk' : 'Move to Junk'} onClick={() => act(inJunk ? 'not-junk' : 'junk')} disabled={!has}><OctagonAlert className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <span className="mx-1.5 h-5 w-px bg-border" />
      <ToolButton label="Reply" onClick={() => act('reply')} disabled={!current}><Reply className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label="Reply All" onClick={() => act('reply-all')} disabled={!current}><ReplyAll className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label="Forward" onClick={() => act('forward')} disabled={!current}><Forward className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <span className="mx-1.5 h-5 w-px bg-border" />
      <ToolButton label={allFlagged ? 'Unflag' : 'Flag'} onClick={() => act(allFlagged ? 'unflag' : 'flag')} disabled={!has} active={allFlagged}>
        <Flag className={cn('size-4.5', allFlagged && 'fill-orange-500 text-orange-500')} strokeWidth={1.75} />
      </ToolButton>
      <ToolButton label={allRead ? 'Mark as Unread' : 'Mark as Read'} onClick={() => act(allRead ? 'unread' : 'read')} disabled={!has}>
        {allRead ? <MailIcon className="size-4.5" strokeWidth={1.75} /> : <MailOpen className="size-4.5" strokeWidth={1.75} />}
      </ToolButton>
      <div className="min-w-2 flex-1" />
      <div className="relative mr-2 w-full max-w-56 min-w-28">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={searchInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearch('');
              listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
            }
          }}
          placeholder="Search"
          aria-label={`Search ${title}`}
          className="h-7 w-full rounded-md bg-foreground/[0.06] pr-7 pl-7 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        />
        {search && (
          <button type="button" aria-label="Clear search" onClick={() => setSearch('')} className="absolute top-1/2 right-1.5 grid size-4 -translate-y-1/2 place-items-center rounded-full bg-muted-foreground/40 text-background">
            <X className="size-3" />
          </button>
        )}
      </div>
      <WindowControls />
    </WindowDragRegion>
  );

  return (
    <div className="relative flex h-full text-foreground">
      {showSidebar && !noAccounts && (
        <>
          <aside className="flex shrink-0 flex-col border-r border-border/60 bg-background/30" style={{ width: widths.sidebar }}>
            <WindowDragRegion className="flex h-13 shrink-0 items-center justify-end gap-0.5 px-2">
              <ToolButton label={refreshing ? 'Getting new mail' : 'Get new mail'} onClick={refresh}>
                <RefreshCw className={cn('size-4', refreshing && 'animate-spin motion-reduce:animate-none')} strokeWidth={1.75} />
              </ToolButton>
              <ToolButton label="Hide sidebar" onClick={() => { setSidebarOpen(false); localStorage.setItem(SIDEBAR_KEY, 'hidden'); }}>
                <PanelLeft className="size-4" strokeWidth={1.75} />
              </ToolButton>
            </WindowDragRegion>
            <Sidebar
              accounts={accounts}
              boxes={boxes}
              errors={errors}
              selection={selection}
              onSelect={setSelection}
              onDropMessages={onDropMessages}
              onRefresh={refresh}
              onAccountSettings={(accountId) => setDialog({ kind: 'settings', accountId })}
              onAddAccount={() => setDialog({ kind: 'setup' })}
            />
          </aside>
          <Splitter
            label="Resize sidebar"
            onDrag={(dx) => setWidths((w) => ({ ...w, sidebar: Math.min(360, Math.max(170, w.sidebar + dx)) }))}
            onDone={() => setWidths((w) => (localStorage.setItem(WIDTHS_KEY, JSON.stringify(w)), w))}
          />
        </>
      )}

      {noAccounts ? (
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <WindowDragRegion className="flex h-13 shrink-0 items-center justify-end px-3"><WindowControls /></WindowDragRegion>
          <Welcome onAdd={() => setDialog({ kind: 'setup' })} />
        </div>
      ) : (
        <>
          {!readerOnly && (
            <section
              ref={listRef}
              aria-label={title}
              className={cn('flex min-w-0 shrink-0 flex-col border-r border-border/60 bg-background', narrow && 'flex-1')}
              style={narrow ? undefined : { width: widths.list }}
            >
              <WindowDragRegion className="flex h-13 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-3">
                {!showSidebar && (
                  <ToolButton label="Show sidebar" onClick={() => { setSidebarOpen(true); localStorage.setItem(SIDEBAR_KEY, 'shown'); }} disabled={width < 860}>
                    <PanelLeft className="size-4" strokeWidth={1.75} />
                  </ToolButton>
                )}
                <div className="min-w-0 flex-1 pl-1 leading-tight">
                  {showSidebar ? (
                    <h1 className="truncate text-[15px] font-bold">{title}</h1>
                  ) : (
                    <button type="button" onClick={(e) => void pickMailbox(e)} className="flex max-w-full items-center gap-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-haspopup="menu">
                      <h1 className="truncate text-[15px] font-bold">{title}</h1>
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  )}
                  <p className="truncate text-[11px] text-muted-foreground">{messages.isPending && sources.length ? 'Checking for mail…' : subtitle}</p>
                </div>
                <ToolButton label={filter === 'unread' ? 'Show all messages' : 'Show only unread'} active={filter === 'unread'} onClick={() => setFilter((f) => (f === 'unread' ? null : 'unread'))}>
                  <ListFilter className={cn('size-4', filter === 'unread' && 'text-primary')} strokeWidth={1.75} />
                </ToolButton>
                <ToolButton label="New message" onClick={() => newMessage(defaultAccount)}>
                  <SquarePen className="size-4" strokeWidth={1.75} />
                </ToolButton>
                {narrow && <WindowControls />}
              </WindowDragRegion>
              {messages.isPending && sources.length > 0 ? (
                <ListSkeleton />
              ) : messages.isError ? (
                <div className="p-6 text-center text-[13px] text-muted-foreground">
                  <p>{messages.error instanceof Error ? messages.error.message : 'Mail couldn’t load this mailbox.'}</p>
                  <button type="button" onClick={() => void messages.refetch()} className="mt-3 text-primary hover:underline">Try Again</button>
                </div>
              ) : !items.length ? (
                <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-muted-foreground">
                  {sources.length === 0 && boxes.size < accounts.length ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" /> : query ? 'No Results' : effectiveFilter ? `No ${effectiveFilter === 'unread' ? 'Unread' : 'Flagged'} Messages` : 'No Messages'}
                </div>
              ) : (
                <MessageList
                  items={items}
                  selected={selected}
                  recipients={recipients}
                  boxesFor={(id) => boxes.get(id) ?? []}
                  hasMore={!!messages.hasNextPage}
                  loadingMore={messages.isFetchingNextPage}
                  onLoadMore={() => {
                    if (!messages.isFetchingNextPage) void messages.fetchNextPage();
                  }}
                  onClickRow={onClickRow}
                  onOpenRow={(item) => (item.draft ? void run('open-draft', [item]) : undefined)}
                  onKeyDown={onListKey}
                  onAction={(action, item) => void run(action, targetsFor(item))}
                  onMove={(item, path) => void moveTo(targetsFor(item), item.accountId, path)}
                  targetsFor={targetsFor}
                  active={listActive}
                  onActiveChange={setListActive}
                />
              )}
            </section>
          )}
          {!narrow && (
            <Splitter
              label="Resize message list"
              onDrag={(dx) => setWidths((w) => ({ ...w, list: Math.min(600, Math.max(260, w.list + dx)) }))}
              onDone={() => setWidths((w) => (localStorage.setItem(WIDTHS_KEY, JSON.stringify(w)), w))}
            />
          )}
          {(!narrow || readerOnly) && (
            <main className="flex min-w-0 flex-1 flex-col bg-background">
              {toolbar}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Reader item={current} count={selectedItems.length} onMailto={openMailto} onEditDraft={(item) => void run('open-draft', [item])} />
              </div>
            </main>
          )}
        </>
      )}

      {dialog?.kind === 'setup' && (
        <AccountSetup
          first={accounts.length === 0}
          onClose={() => setDialog(null)}
          onAdded={(a) => {
            setDialog(null);
            setSelection({ kind: 'all', special: 'inbox' });
            void qc.invalidateQueries({ queryKey: ['mail', 'mailboxes', a.id] });
          }}
        />
      )}
      {dialog?.kind === 'settings' && (
        <AccountSettings accounts={accounts} initial={dialog.accountId} onClose={() => setDialog(null)} onAdd={() => setDialog({ kind: 'setup' })} />
      )}
    </div>
  );
}


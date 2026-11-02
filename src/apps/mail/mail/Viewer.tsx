import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Archive, ArrowLeft, Mail as MailIcon, MailOpen, Menu, MoreVertical, Search, SquarePen, Star, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useDin, useMenuBar, useWindowState, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { cn } from '@/lib/utils';
import { parseMailto } from '@/lib/mailto';
import type { MailAccount, MailboxInfo, MailSubscription, MessageFilter, SpecialMailbox } from '@/lib/mail';
import type { MenuItem } from '@/sdk/din';
import { sourcesOf, useAccounts, useLiveUpdates, useMail, useMailboxes, useMessage, useMessages, type Item, type Selection } from './api';
import { useMessageActions } from './actions';
import { blankSeed, parseAddresses } from './format';
import { rememberAddresses } from './contacts';
import { Sidebar } from './Sidebar';
import { MAIL_DRAG, mailboxTitle, SPECIAL_NAMES } from './mailboxes';
import { ListSkeleton, MessageList } from './MessageList';
import { Reader } from './Reader';
import { messageMenu, type MenuPick } from './menu';
import { DropdownEntries } from './MenuEntries';
import { groupConversations, type Conversation } from './conversations';
import { messageTarget, savedViewer, type SavedWindow } from './restore';
import { AccountSetup } from './AccountSetup';
import { AccountSettings } from './AccountSettings';
import { Subscriptions, UnsubscribeDialog } from './Subscriptions';

const SELECTION_KEY = 'din:mail:selection';
const SIDEBAR_KEY = 'din:mail:sidebar';
const WIDTHS_KEY = 'din:mail:widths';

/** The narrowest window that has room for the sidebar beside the list. */
const SIDEBAR_MIN_WIDTH = 760;

/** What the toolbars have as buttons, so their ⋯ menus leave out. */
const TOOLBAR_PICKS = new Set<MenuPick>(['archive', 'trash', 'read', 'unread', 'reply', 'reply-all', 'forward']);
const SELECTION_PICKS = new Set<MenuPick>(['archive', 'trash', 'read', 'unread', 'flag', 'unflag']);
const READER_PICKS = new Set<MenuPick>(['reply', 'flag', 'unflag']);

function loadSelection(): Selection {
  try {
    const s = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as Selection | null;
    if (s && (s.kind === 'all' || s.kind === 'subscriptions' || (s.kind === 'mailbox' && typeof s.accountId === 'string' && typeof s.path === 'string'))) return s;
  } catch {
    // The default below.
  }
  return { kind: 'all', special: 'inbox' };
}

function loadSidebarWidth(): number {
  try {
    const w = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as { sidebar?: number } | null;
    return w?.sidebar ?? 232;
  } catch {
    return 232;
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

function ToolButton({ label, onClick, disabled, children, className, ...props }: React.ComponentProps<'button'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      {...props}
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground outline-none',
        'hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-35',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The row of buttons above an open message, or above messages chosen together. */
function ActionBar({ children }: { children: ReactNode }) {
  return <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">{children}</div>;
}

function MoreMenu({ entries, onPick }: { entries: ReturnType<typeof messageMenu>; onPick: (pick: MenuPick) => void }) {
  if (!entries.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton label="More">
          <MoreVertical className="size-4.5" strokeWidth={1.75} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownEntries entries={entries} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
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
  const me = useMemo(() => new Set(accounts.map((a) => a.email.toLowerCase())), [accounts]);
  const { boxes, errors } = useMailboxes(accounts);
  useLiveUpdates();

  // A window Din reopened comes back as it was left; one opened for a
  // message (a new mail notification's click) opens on it.
  const [restored] = useState(() => {
    const target = din.app.launch.reason === 'restore' ? null : messageTarget(din.app.launch.params);
    if (!target) return savedViewer(din.app.launch.state);
    const selection: Selection = { kind: 'mailbox', accountId: target.accountId, path: target.path };
    return { selection, filter: null, search: '', message: target.key, scroll: 0 };
  });
  const [chosenMailbox, setSelectionState] = useState<Selection>(() => restored?.selection ?? loadSelection());
  const [filter, setFilter] = useState<MessageFilter>(restored?.filter ?? null);
  const [search, setSearch] = useState(restored?.search ?? '');
  const [query, setQuery] = useState(() => restored?.search.trim() ?? '');
  /** Conversations chosen to act on together, with Ctrl- and Shift-click, by key. */
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  /** The conversation open in place of the list. */
  const [opened, setOpened] = useState<Conversation | null>(null);
  /** The row the keyboard is on. */
  const [cursor, setCursor] = useState<string | null>(null);
  /** A message to open once the list has it: where the window was left, or a notification's. */
  const [restoring, setRestoring] = useState<string | null>(restored?.message ?? null);
  const restoreScroll = useRef(restored?.scroll ?? 0);
  const scrollTop = useRef(restored?.scroll ?? 0);
  const anchor = useRef<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden');
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [dialog, setDialog] = useState<{ kind: 'setup' } | { kind: 'settings'; accountId: string | null } | null>(null);
  const [leaving, setLeaving] = useState<Item | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  const { bounds } = useWindowState();
  const width = bounds.width || window.innerWidth;
  const sidebarFits = width >= SIDEBAR_MIN_WIDTH;
  const showSidebar = sidebarOpen && sidebarFits;

  const setSelection = useCallback((s: Selection) => {
    setSelectionState(s);
    setChosen(new Set());
    setOpened(null);
    setCursor(null);
    setRestoring(null);
    restoreScroll.current = 0;
    scrollTop.current = 0;
    anchor.current = null;
    localStorage.setItem(SELECTION_KEY, JSON.stringify(s));
  }, []);

  const toggleSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem(SIDEBAR_KEY, open ? 'shown' : 'hidden');
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

  const conversations = useMemo(() => groupConversations(items), [items]);

  // People in the list become address suggestions.
  useEffect(() => {
    rememberAddresses(items.slice(0, 50).flatMap((i) => i.from));
  }, [items]);

  // The message to open (in its conversation), once the list has it. A few
  // older pages are read to find it, and then it's given up on.
  const restoreMore = !!messages.hasNextPage && (messages.data?.pages.length ?? 0) < 5;
  const restoreFound = restoring ? conversations.find((c) => c.items.some((i) => i.key === restoring)) : undefined;
  const restoreGone = !restoring || messages.isError || (!restoreFound && messages.isSuccess && !messages.isFetching && !restoreMore);
  if (restoring && (restoreFound || restoreGone)) {
    setRestoring(null);
    if (restoreFound) {
      setOpened(restoreFound);
      setCursor(restoreFound.key);
    }
  }
  const { isSuccess, isFetching, fetchNextPage } = messages;
  useEffect(() => {
    if (restoring && !restoreFound && isSuccess && !isFetching && restoreMore) void fetchNextPage();
  }, [restoring, restoreFound, isSuccess, isFetching, restoreMore, fetchNextPage]);

  // The open conversation as the list has it now (new mail in it, its
  // flags), or as it was opened.
  const current = useMemo(() => {
    if (!opened) return null;
    const keys = new Set(opened.items.map((i) => i.key));
    return conversations.find((c) => c.items.some((i) => keys.has(i.key))) ?? opened;
  }, [opened, conversations]);
  const chosenConversations = useMemo(() => conversations.filter((c) => chosen.has(c.key)), [conversations, chosen]);
  const selectedItems = useMemo(() => chosenConversations.flatMap((c) => c.items), [chosenConversations]);
  const cursorConversation = useMemo(() => conversations.find((c) => c.key === cursor) ?? null, [conversations, cursor]);
  /** What the menu bar and keyboard act on: the open conversation, else the chosen ones, else the keyboard's row. */
  const targetConversations = useMemo(() => (current ? [current] : chosenConversations.length ? chosenConversations : cursorConversation ? [cursorConversation] : []), [current, chosenConversations, cursorConversation]);
  const targets = useMemo(() => targetConversations.flatMap((c) => c.items), [targetConversations]);

  // Kept for Din to reopen the window with: the mailbox, filter, search,
  // the open message and the list's scroll.
  const savedMessage = current?.latest.key ?? (restoreGone ? null : restoring);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveWindow = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const state: SavedWindow = { kind: 'viewer', selection: chosenMailbox, filter, search, message: savedMessage, scroll: Math.round(scrollTop.current) };
      din.app.saveState(state);
    }, 300);
  }, [din, chosenMailbox, filter, search, savedMessage]);
  useEffect(() => {
    saveWindow();
  }, [saveWindow]);
  const onListScroll = useCallback(
    (top: number) => {
      scrollTop.current = top;
      saveWindow();
    },
    [saveWindow],
  );

  const box = (accountId: string, path: string): MailboxInfo | undefined => boxes.get(accountId)?.find((b) => b.path === path);
  const special = selection.kind === 'all' ? selection.special : selection.kind === 'mailbox' ? box(selection.accountId, selection.path)?.special ?? null : null;
  const recipients = special === 'sent' || special === 'drafts';

  const title =
    selection.kind === 'subscriptions'
      ? 'Subscriptions'
      : selection.kind === 'all'
        ? selection.special === 'inbox' && accounts.length > 1
          ? 'All Inboxes'
          : SPECIAL_NAMES[selection.special]
        : mailboxTitle(box(selection.accountId, selection.path)) || selection.path;

  useWindowTitle(current ? current.items.at(-1)?.subject || 'No Subject' : title);

  // A message to open (a new mail notification's click, see MailHost):
  // its mailbox, and the message once the list has it.
  useEffect(
    () =>
      din.app.onLaunch((launch) => {
        const target = messageTarget(launch.params);
        if (!target) return;
        setSelection({ kind: 'mailbox', accountId: target.accountId, path: target.path });
        setRestoring(target.key);
      }),
    [din, setSelection],
  );

  // Messages that left the list: a conversation they were all of closes,
  // back to the list on the one after it.
  const onRemoved = useCallback(
    (keys: Set<string>) => {
      const gone = (c: Conversation) => c.items.every((i) => keys.has(i.key));
      const goneKeys = new Set(conversations.filter(gone).map((c) => c.key));
      const at = conversations.findIndex(gone);
      const next = at < 0 ? undefined : conversations.slice(at).find((c) => !gone(c)) ?? conversations.slice(0, at).reverse().find((c) => !gone(c));
      setOpened((o) => {
        if (!o || !o.items.every((i) => keys.has(i.key))) return o;
        restoreScroll.current = scrollTop.current;
        return null;
      });
      setChosen((sel) => (sel.size ? new Set([...sel].filter((k) => !goneKeys.has(k))) : sel));
      setCursor((c) => (c && !goneKeys.has(c) ? c : next?.key ?? c));
      anchor.current = null;
    },
    [conversations],
  );
  const { run, moveTo, newMessage, compose } = useMessageActions(accounts, onRemoved);

  const pickFor = useCallback(
    (pick: MenuPick, list: Item[]) => {
      if (!list.length) return;
      if (typeof pick === 'object') return void moveTo(list, list[0].accountId, pick.move);
      if (pick === 'unsubscribe') return setLeaving(list[0]);
      // An open conversation marked unread goes back to the list, as it would be read again otherwise.
      if (pick === 'unread' && current && list.some((i) => current.items.some((c) => c.key === i.key))) setOpened(null);
      void run(pick, list);
    },
    [moveTo, run, current],
  );

  const currentMessage = useMessage(current?.latest ?? null);
  const canUnsubscribe = !!current && (current.latest.listUnsubscribe || !!currentMessage.data?.unsubscribe);

  const openConversation = useCallback(
    (c: Conversation) => {
      // A draft by itself is written on, not read.
      if (c.items.length === 1 && c.latest.draft) return void run('open-draft', [c.latest]);
      // The list comes back where it was left.
      restoreScroll.current = scrollTop.current;
      setOpened(c);
      setCursor(c.key);
      setChosen(new Set());
    },
    [run],
  );

  const backToList = useCallback(() => {
    setOpened(null);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus());
  }, []);

  // The open message takes the keyboard, for Escape to go back.
  useEffect(() => {
    if (opened) readerRef.current?.focus({ preventScroll: true });
  }, [opened]);

  // A list's mail, from Subscriptions: its sender searched for in its inbox.
  const showListMail = useCallback(
    (sub: MailSubscription) => {
      const inbox = boxes.get(sub.accountId)?.find((b) => b.special === 'inbox')?.path ?? 'INBOX';
      setSelection({ kind: 'mailbox', accountId: sub.accountId, path: inbox });
      setSearch(sub.address);
      setQuery(sub.address);
    },
    [boxes, setSelection],
  );

  const filterUnread = () => setFilter((f) => (f === 'unread' ? null : 'unread'));

  const onSearch = (value: string) => {
    if (selection.kind === 'subscriptions') setSelection({ kind: 'all', special: 'inbox' });
    setOpened(null);
    setSearch(value);
  };

  const targetsFor = useCallback((c: Conversation) => (chosen.has(c.key) ? chosenConversations : [c]), [chosen, chosenConversations]);

  /**
   * What a pick on conversations acts on: the newest message for Reply and
   * Forward; the newest for a star, and every starred message to take it
   * off; all of them otherwise.
   */
  const pickTargets = (pick: MenuPick, list: Conversation[]): Item[] => {
    if (pick === 'reply' || pick === 'reply-all' || pick === 'forward' || pick === 'open-draft') return list.slice(0, 1).map((c) => c.latest);
    if (pick === 'flag') return list.map((c) => c.latest);
    if (pick === 'unflag') return list.flatMap((c) => c.items.filter((i) => i.flagged));
    if (pick === 'unread') return list.map((c) => c.latest);
    return list.flatMap((c) => c.items);
  };

  const onClickRow = (e: MouseEvent, c: Conversation) => {
    const from = anchor.current ?? cursor;
    if (e.shiftKey && from) {
      const a = conversations.findIndex((x) => x.key === from);
      const b = conversations.findIndex((x) => x.key === c.key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setChosen(new Set(conversations.slice(lo, hi + 1).map((x) => x.key)));
      setCursor(c.key);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(chosen);
      if (n.has(c.key)) n.delete(c.key);
      else n.add(c.key);
      setChosen(n);
      setCursor(c.key);
      anchor.current = c.key;
      return;
    }
    anchor.current = c.key;
    openConversation(c);
  };

  const onListKey = (e: KeyboardEvent) => {
    const at = conversations.findIndex((c) => c.key === cursor);
    const go = (index: number) => {
      const target = conversations[Math.max(0, Math.min(conversations.length - 1, index))];
      if (!target) return;
      if (e.shiftKey) {
        const from = anchor.current ?? cursor ?? target.key;
        anchor.current = from;
        const a = conversations.findIndex((c) => c.key === from);
        const [lo, hi] = a < index ? [a, index] : [index, a];
        setChosen(new Set(conversations.slice(lo, hi + 1).map((c) => c.key)));
      } else {
        anchor.current = target.key;
      }
      setCursor(target.key);
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(at < 0 ? 0 : at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(conversations.length - 1);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && targets.length) {
      e.preventDefault();
      void run('trash', targets);
    } else if (e.key === 'Enter' && cursorConversation) {
      e.preventDefault();
      openConversation(cursorConversation);
    } else if (e.key === ' ' && cursorConversation) {
      e.preventDefault();
      const n = new Set(chosen);
      if (n.has(cursorConversation.key)) n.delete(cursorConversation.key);
      else n.add(cursorConversation.key);
      setChosen(n);
    } else if (e.key === 'Escape' && chosen.size) {
      setChosen(new Set());
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setChosen(new Set(conversations.map((c) => c.key)));
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

  const defaultAccount = selection.kind === 'mailbox' ? selection.accountId : current?.latest.accountId ?? accounts[0]?.id ?? null;
  const has = targets.length > 0;
  const allFlagged = has && targetConversations.every((c) => c.flagged);
  const allRead = has && targetConversations.every((c) => !c.unread);
  const inJunk = has && box(targets[0].accountId, targets[0].path)?.special === 'junk';

  const openMailto = useCallback(
    (url: string) => {
      const m = parseMailto(url);
      compose({ ...blankSeed(defaultAccount), to: parseAddresses(m.to.join(',')), cc: parseAddresses(m.cc.join(',')), bcc: parseAddresses(m.bcc.join(',')), subject: m.subject, html: m.body ? `<p>${m.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` : '' });
    },
    [compose, defaultAccount],
  );

  // Without the sidebar, the menu button picks the mailbox.
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
    const subscriptions: MenuItem = { id: 'subscriptions', label: 'Subscriptions', type: 'radio', group: 'mailbox', checked: selection.kind === 'subscriptions' };
    const choice = await din.menus.popup([...favorites, subscriptions, { type: 'separator' }, ...perAccount], { x: r.left, y: r.bottom + 4 });
    if (!choice) return;
    if (choice === 'subscriptions') setSelection({ kind: 'subscriptions' });
    else if (choice.startsWith('all:')) setSelection({ kind: 'all', special: choice.slice(4) as SpecialMailbox });
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
          { id: 'sidebar', label: 'Show Sidebar', type: 'checkbox', checked: sidebarOpen, enabled: sidebarFits, accelerator: 'Ctrl+Alt+S' },
          { id: 'unread-only', label: 'Show Only Unread', type: 'checkbox', checked: filter === 'unread', accelerator: 'Ctrl+Alt+U' },
          { type: 'separator' },
          { id: 'back', label: 'Back to Messages', enabled: !!current },
          { id: 'search', label: 'Search', accelerator: 'Ctrl+F', notInFields: true },
        ],
      },
      {
        label: 'Mailbox',
        items: [
          { id: 'refresh', label: 'Get All New Mail', accelerator: 'Ctrl+Shift+N' },
          { type: 'separator' },
          { id: 'subscriptions', label: 'Subscriptions' },
        ],
      },
      {
        label: 'Message',
        items: [
          { id: 'reply', label: 'Reply', accelerator: 'Ctrl+R', enabled: targetConversations.length === 1 },
          { id: 'reply-all', label: 'Reply All', accelerator: 'Ctrl+Shift+R', enabled: targetConversations.length === 1 },
          { id: 'forward', label: 'Forward', accelerator: 'Ctrl+Shift+F', enabled: targetConversations.length === 1 },
          { type: 'separator' },
          { id: allRead ? 'unread' : 'read', label: allRead ? 'Mark as Unread' : 'Mark as Read', accelerator: 'Ctrl+Shift+U', enabled: has },
          { id: allFlagged ? 'unflag' : 'flag', label: allFlagged ? 'Remove Star' : 'Star', accelerator: 'Ctrl+Shift+L', enabled: has },
          { type: 'separator' },
          { id: 'archive', label: 'Archive', accelerator: 'Ctrl+Shift+A', enabled: has },
          { id: inJunk ? 'not-junk' : 'junk', label: inJunk ? 'Not Junk' : 'Move to Junk', accelerator: 'Ctrl+Shift+J', enabled: has },
          { id: 'trash', label: 'Delete', accelerator: 'Delete', notInFields: true, enabled: has, destructive: true },
          { type: 'separator' },
          { id: 'unsubscribe', label: 'Unsubscribe…', enabled: canUnsubscribe },
        ],
      },
    ],
    (id) => {
      switch (id) {
        case 'new': return newMessage(defaultAccount);
        case 'window': return void din.app.open('mail', { viewer: true });
        case 'add-account': return setDialog({ kind: 'setup' });
        case 'settings': return setDialog({ kind: 'settings', accountId: null });
        case 'sidebar': return toggleSidebar(!sidebarOpen);
        case 'unread-only': return filterUnread();
        case 'back': return backToList();
        case 'search': return searchInput.current?.focus();
        case 'refresh': return refresh();
        case 'subscriptions': return setSelection({ kind: 'subscriptions' });
        case 'unsubscribe': return current ? setLeaving(current.latest) : undefined;
        case 'read':
        case 'unread':
        case 'reply':
        case 'reply-all':
        case 'forward':
        case 'flag':
        case 'unflag':
        case 'archive':
        case 'junk':
        case 'not-junk':
        case 'trash':
          return pickFor(id, pickTargets(id, targetConversations));
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

  const header = (
    <WindowDragRegion className="flex h-14 shrink-0 items-center gap-2 pr-3 pl-2">
      <div className="flex shrink-0 items-center gap-1" style={showSidebar && !noAccounts ? { width: sidebarWidth - 8 } : undefined}>
        {!noAccounts && (
          <ToolButton
            label={sidebarFits ? (showSidebar ? 'Hide sidebar' : 'Show sidebar') : 'Mailboxes'}
            aria-haspopup={sidebarFits ? undefined : 'menu'}
            onClick={(e) => (sidebarFits ? toggleSidebar(!showSidebar) : void pickMailbox(e))}
          >
            <Menu className="size-4.5" strokeWidth={1.75} />
          </ToolButton>
        )}
        <img src="/icons/apps/mail.png" alt="" aria-hidden draggable={false} className="size-6 shrink-0 object-contain" />
        {(showSidebar || noAccounts) && <span className="truncate pl-1 font-[family-name:var(--font-title)] text-lg text-foreground/90">Mail</span>}
      </div>
      {!noAccounts && (
        <div className="relative max-w-3xl min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchInput}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onSearch('');
                listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
              } else if (e.key === 'Enter') {
                setQuery(search.trim());
              }
            }}
            placeholder={selection.kind === 'all' && selection.special === 'inbox' ? 'Search mail' : `Search ${title}`}
            aria-label={`Search ${title}`}
            className="h-10 w-full rounded-full bg-foreground/[0.06] pr-10 pl-10 text-sm outline-none placeholder:text-muted-foreground focus-visible:bg-background focus-visible:shadow-sm focus-visible:ring-1 focus-visible:ring-border"
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => onSearch('')} className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground">
              <X className="size-4" />
            </button>
          )}
        </div>
      )}
      <div className="min-w-2 flex-1" />
      {!showSidebar && !noAccounts && (
        <ToolButton label="New message" onClick={() => newMessage(defaultAccount)}>
          <SquarePen className="size-4.5" strokeWidth={1.75} />
        </ToolButton>
      )}
      <WindowControls />
    </WindowDragRegion>
  );

  const first = targets[0];
  const boxesOf = (accountId: string) => boxes.get(accountId) ?? [];

  const readerBar = current && (
    <ActionBar>
      <ToolButton label="Back to messages" onClick={backToList}><ArrowLeft className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <span className="mx-1 h-5 w-px bg-border" />
      <ToolButton label="Archive" onClick={() => pickFor('archive', current.items)}><Archive className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label="Delete" onClick={() => pickFor('trash', current.items)}><Trash2 className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label="Mark as unread" onClick={() => pickFor('unread', [current.latest])}><MailIcon className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <MoreMenu entries={messageMenu(current.items, boxesOf(current.latest.accountId), TOOLBAR_PICKS, true)} onPick={(pick) => pickFor(pick, pickTargets(pick, [current]))} />
    </ActionBar>
  );

  const selectionBar = !current && chosenConversations.length > 0 && first && (
    <ActionBar>
      <ToolButton label="Clear selection" onClick={() => setChosen(new Set())}><X className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <span className="mr-2 text-sm font-medium tabular-nums">{chosenConversations.length.toLocaleString()} selected</span>
      <ToolButton label="Archive" onClick={() => pickFor('archive', selectedItems)}><Archive className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label="Delete" onClick={() => pickFor('trash', selectedItems)}><Trash2 className="size-4.5" strokeWidth={1.75} /></ToolButton>
      <ToolButton label={allRead ? 'Mark as unread' : 'Mark as read'} onClick={() => pickFor(allRead ? 'unread' : 'read', pickTargets(allRead ? 'unread' : 'read', chosenConversations))}>
        {allRead ? <MailIcon className="size-4.5" strokeWidth={1.75} /> : <MailOpen className="size-4.5" strokeWidth={1.75} />}
      </ToolButton>
      <ToolButton label={allFlagged ? 'Remove star' : 'Star'} onClick={() => pickFor(allFlagged ? 'unflag' : 'flag', pickTargets(allFlagged ? 'unflag' : 'flag', chosenConversations))}>
        <Star className={cn('size-4.5', allFlagged && 'fill-amber-400 text-amber-500')} strokeWidth={1.75} />
      </ToolButton>
      <MoreMenu entries={messageMenu(selectedItems, boxesOf(first.accountId), SELECTION_PICKS, chosenConversations.length === 1)} onPick={(pick) => pickFor(pick, pickTargets(pick, chosenConversations))} />
    </ActionBar>
  );

  const list = (
    <section ref={listRef} aria-label={title} className="flex min-h-0 flex-1 flex-col">
      {selectionBar}
      {filter === 'unread' && !current && (
        <div className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-1">
          <button type="button" onClick={filterUnread} className="flex h-7 items-center gap-1.5 rounded-full bg-primary/12 pr-2 pl-3 text-xs font-medium outline-none hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring/60">
            Unread only <X className="size-3.5" aria-label="Show all" />
          </button>
        </div>
      )}
      {messages.isPending && sources.length > 0 ? (
        <ListSkeleton />
      ) : messages.isError ? (
        <div className="p-6 text-center text-[13px] text-muted-foreground">
          <p>{messages.error instanceof Error ? messages.error.message : 'Mail couldn’t load this mailbox.'}</p>
          <button type="button" onClick={() => void messages.refetch()} className="mt-3 text-primary hover:underline">Try Again</button>
        </div>
      ) : !conversations.length ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
          {sources.length === 0 && boxes.size < accounts.length ? <ListSkeleton /> : query ? 'No messages matched your search.' : effectiveFilter ? `No ${effectiveFilter === 'unread' ? 'unread' : 'starred'} messages.` : 'Nothing here.'}
        </div>
      ) : (
        <MessageList
          conversations={conversations}
          selected={chosen}
          cursor={cursor}
          recipients={recipients}
          boxesFor={boxesOf}
          hasMore={!!messages.hasNextPage}
          loadingMore={messages.isFetchingNextPage}
          onLoadMore={() => {
            if (!messages.isFetchingNextPage) void messages.fetchNextPage();
          }}
          onClickRow={onClickRow}
          onKeyDown={onListKey}
          onPick={(pick, c) => pickFor(pick, pickTargets(pick, targetsFor(c)))}
          targetsFor={targetsFor}
          restoreScroll={() => {
            const top = restoreScroll.current;
            restoreScroll.current = 0;
            return top;
          }}
          onScroll={onListScroll}
        />
      )}
    </section>
  );

  return (
    <div className="relative flex h-full flex-col text-foreground">
      {header}
      <div className="flex min-h-0 flex-1">
        {showSidebar && !noAccounts && (
          <>
            <aside className="flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
              <div className="shrink-0 px-2 pt-1 pb-3">
                <button
                  type="button"
                  onClick={() => newMessage(defaultAccount)}
                  className="flex h-12 items-center gap-3 rounded-2xl bg-primary/15 pr-6 pl-4 text-sm font-medium outline-none hover:bg-primary/20 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <SquarePen className="size-4.5" strokeWidth={1.75} /> Compose
                </button>
              </div>
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
              onDrag={(dx) => setSidebarWidth((w) => Math.min(360, Math.max(180, w + dx)))}
              onDone={() => setSidebarWidth((w) => (localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: w })), w))}
            />
          </>
        )}

        <main className={cn('flex min-w-0 flex-1 flex-col overflow-hidden bg-background', showSidebar && !noAccounts && 'mr-2 mb-2 rounded-2xl', !showSidebar && 'border-t border-border/60')}>
          {noAccounts ? (
            <Welcome onAdd={() => setDialog({ kind: 'setup' })} />
          ) : selection.kind === 'subscriptions' ? (
            <Subscriptions accounts={accounts} onShowMail={showListMail} />
          ) : current ? (
            <>
              {readerBar}
              <div
                ref={readerRef}
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !e.defaultPrevented) backToList();
                }}
                className="min-h-0 flex-1 overflow-y-auto outline-none"
              >
                <Reader
                  key={opened?.key}
                  items={current.items}
                  me={me}
                  menuFor={(item) => messageMenu([item], boxesOf(item.accountId), READER_PICKS)}
                  onPick={(pick, item) => pickFor(pick, [item])}
                  onRead={(list) => void run('read', list)}
                  onMailto={openMailto}
                  onUnsubscribe={setLeaving}
                />
              </div>
            </>
          ) : (
            list
          )}
        </main>
      </div>

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
      {leaving && <UnsubscribeDialog item={leaving} onClose={() => setLeaving(null)} />}
      {dialog?.kind === 'settings' && (
        <AccountSettings accounts={accounts} initial={dialog.accountId} onClose={() => setDialog(null)} onAdd={() => setDialog({ kind: 'setup' })} />
      )}
    </div>
  );
}

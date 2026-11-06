import { useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode, type Ref } from 'react';
import { ChevronRight, Folder, FolderInput, GitBranch, GitFork, Loader2, MessageSquare, Pencil, Plus, SquarePen, SquarePlus, Trash2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ConversationTitleInput, DeleteConversationDialog } from '@/shared/assistant/ConversationActions';
import { LoadMore } from '@/shared/assistant/LoadMore';
import { OpenCodeUpdate } from '@/shared/assistant/OpenCodeUpdate';
import { ProjectIcon } from '@/shared/assistant/ProjectIcon';
import { useAssistantHost } from '@/shared/assistant/host';
import {
  useAssistantSessions,
  useAssistantWork,
  useHomeDirectory,
  useMainCheckouts,
  useMoveSession,
  usePendingRequests,
  useProjectIcons,
  useProjectSessions,
  useSessionSearch,
} from '@/hooks/useAssistant';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { cleanAssistantError, directoryName, relativeTime, sessionTitle, tildify, type SessionInfo } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { SearchField, SidebarTitle, SidebarTitleIcon, ToolButton } from '@/shared/appChrome';
import { focusRing, searchRow, sidebarHeadingClass, sidebarRowClass, sidebarWidthClass } from '@/shared/appChromeStyles';

/** How many conversations a project shows before "Show more". */
const PROJECT_LIMIT = 5;

/** What a conversation dragged out of the list carries: its ID. */
const SESSION_DRAG_TYPE = 'application/x-din-assistant-session';

interface Project {
  key: string;
  /** The main checkout, or the folder itself outside git. */
  root: string;
  label: string;
  sessions: SessionInfo[];
}

/**
 * Conversations by project, the project used most recently first. Every
 * worktree of a repository counts as the repository: OpenCode gives them
 * the same project ID, and their `.git` files lead back to the main
 * checkout, whose folder names the project.
 */
function groupByProject(sessions: SessionInfo[], mains: Map<string, string>, home: string | undefined): Project[] {
  const byKey = new Map<string, { roots: Set<string>; sessions: SessionInfo[] }>();
  for (const session of sessions) {
    const root = mains.get(session.location.directory) ?? session.location.directory;
    const key = session.projectID ?? root;
    const group = byKey.get(key) ?? { roots: new Set<string>(), sessions: [] };
    group.roots.add(root);
    group.sessions.push(session);
    byKey.set(key, group);
  }

  const projects = [...byKey].map(([key, { roots, sessions }]) => {
    const root = [...roots].reduce((a, b) => (b.length < a.length ? b : a));
    return {
      key,
      root,
      label: directoryName(root, home),
      sessions: sessions.sort((a, b) => b.time.updated - a.time.updated),
    };
  });

  // Two projects called "app" are told apart by their paths.
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  for (const p of projects) if ((counts.get(p.label) ?? 0) > 1) p.label = tildify(p.root, home);

  return projects.sort((a, b) => b.sessions[0].time.updated - a.sessions[0].time.updated);
}

/** The list's order when the pointer came in, kept until it leaves. */
interface HeldOrder {
  projects: string[];
  sessions: string[];
  needsYou: string[];
}

/** `items` in `order`, the ones it doesn't know after the rest. */
function inOrder<T>(items: T[], order: string[], id: (item: T) => string): T[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  const at = (item: T) => rank.get(id(item)) ?? order.length;
  return [...items].sort((a, b) => at(a) - at(b));
}

/**
 * The conversation list: one line per conversation, under the project it
 * belongs to, with the ones waiting on the user pulled out on top so a
 * collapsed project can't hide them. Searching flattens it. Middle-clicking
 * a conversation opens it in a new tab; right-clicking one does that too, or
 * forks, moves, renames or deletes it; right-clicking a project starts a conversation there.
 * Dragging a conversation onto another project moves it to that project's folder.
 */
export function SessionList({
  selected,
  onSelect,
  onOpenInNewTab,
  onNew,
  onFork,
  onDeleted,
  searchRef,
  unread,
  menu,
  className,
  style,
}: {
  selected: string | null;
  /** More in the list's title bar, before New conversation: the app's menu. */
  menu?: ReactNode;
  /** Conversations with unread notifications. */
  unread?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpenInNewTab: (id: string) => void;
  /** Start a new conversation, in `directory` when given. */
  onNew: (directory?: string) => void;
  /** Continue a conversation in a new one with its history. */
  onFork: (id: string) => void;
  /** A conversation was deleted from the list. */
  onDeleted: (id: string) => void;
  /** The search field, for Ctrl+K. */
  searchRef?: Ref<HTMLInputElement>;
  className?: string;
  style?: CSSProperties;
}) {
  const sessionPages = useAssistantSessions();
  const { data: sessions, isLoading } = sessionPages;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Working, or still running a command or subagent it started.
  const { busy } = useAssistantWork();
  const pending = usePendingRequests();
  const home = useHomeDirectory();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useLocalStorage<string[]>('din.assistant.collapsedProjects', []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  // Rename puts focus in the title field; the closing menu mustn't take it back.
  const keepFocus = useRef(false);
  const move = useMoveSession();
  const { notify } = useAssistantHost();
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const listed = useMemo(() => (sessions ?? []).filter((s) => !s.time.archived), [sessions]);
  const directories = useMemo(() => [...new Set(listed.map((s) => s.location.directory))], [listed]);
  const mains = useMainCheckouts(directories);
  const waitingNow = useMemo(
    () => new Set([...pending.permissions, ...pending.forms, ...pending.passwords].map((request) => request.sessionID)),
    [pending],
  );

  // Running agents re-sort the list several times a second. Under the
  // pointer that moves rows between press and release, and the click is
  // lost or lands on another project, so the order holds while it's there.
  const [held, setHeld] = useState<HeldOrder | null>(null);
  const grouped = groupByProject(listed, mains, home);
  const waiting = held ? new Set(held.needsYou) : waitingNow;
  const projects = held
    ? inOrder(grouped, held.projects, (p) => p.key).map((p) => ({
        ...p,
        sessions: inOrder(p.sessions, held.sessions, (s) => s.id),
      }))
    : grouped;
  const icons = useProjectIcons([...new Set(projects.map((p) => p.root))]);
  const projectOf = new Map(projects.flatMap((p) => p.sessions.map((s) => [s.id, p] as const)));
  const needsYou = held
    ? inOrder(
        listed.filter((s) => waiting.has(s.id)),
        held.needsYou,
        (s) => s.id,
      )
    : listed.filter((s) => waiting.has(s.id));
  const hold = () =>
    setHeld({
      projects: grouped.map((p) => p.key),
      sessions: grouped.flatMap((p) => p.sessions.map((s) => s.id)),
      needsYou: listed.filter((s) => waitingNow.has(s.id)).map((s) => s.id),
    });

  const moveTo = (session: SessionInfo, project: Project) => {
    if (projectOf.get(session.id)?.key === project.key) return;
    // Open the project it goes to, so it doesn't vanish into a collapsed one.
    setCollapsed((prev) => prev.filter((k) => k !== project.key));
    move.mutate(
      { sessionID: session.id, directory: project.root },
      {
        onError: (error) =>
          notify({ title: 'Couldn’t move the conversation', description: cleanAssistantError(error), destructive: true }),
      },
    );
  };
  const draggedSession = dragging ? listed.find((s) => s.id === dragging) : undefined;
  const endDrag = () => {
    draggingRef.current = false;
    setDragging(null);
    setDropTarget(null);
  };

  const needle = filter.trim().toLowerCase();
  // The server searches every conversation's title; the ones loaded here
  // can match by folder or project too.
  const search = useSessionSearch(useDebouncedValue(needle, 250));
  const found = useMemo(() => (search.data ?? []).filter((s) => !s.time.archived), [search.data]);
  const matches = needle
    ? [
        ...new Map(
          [
            ...listed.filter(
              (s) =>
                sessionTitle(s).toLowerCase().includes(needle) ||
                s.location.directory.toLowerCase().includes(needle) ||
                projectOf.get(s.id)?.label.toLowerCase().includes(needle),
            ),
            ...found.filter((s) => sessionTitle(s).toLowerCase().includes(needle)),
          ].map((s) => [s.id, s]),
        ).values(),
      ].sort((a, b) => b.time.updated - a.time.updated)
    : [];
  const searching = needle !== '' && (search.isFetching || search.isPending);

  const row = (session: SessionInfo, tag?: string) => (
    <li key={session.id}>
      {renaming === session.id ? (
        <ConversationTitleInput session={session} onDone={() => setRenaming(null)} className="h-8" />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <SessionRow
              session={session}
              tag={tag}
              worktree={mains.has(session.location.directory)}
              selected={session.id === selected}
              running={busy.has(session.id)}
              waiting={waitingNow.has(session.id)}
              unread={unread?.has(session.id) ?? false}
              home={home}
              dragged={session.id === dragging}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
                e.dataTransfer.effectAllowed = 'move';
                // The drag cancels the pointer, which then "leaves" the list;
                // the order holds until the drop all the same.
                draggingRef.current = true;
                if (!held) hold();
                setDragging(session.id);
              }}
              onDragEnd={(e) => {
                endDrag();
                const nav = e.currentTarget.closest('nav')?.getBoundingClientRect();
                const inside =
                  nav && e.clientX >= nav.left && e.clientX <= nav.right && e.clientY >= nav.top && e.clientY <= nav.bottom;
                if (!inside) setHeld(null);
              }}
              onSelect={() => onSelect(session.id)}
              onAuxClick={(e) => {
                // Middle-click opens it in a new tab, like a link.
                if (e.button === 1) onOpenInNewTab(session.id);
              }}
              onMouseDown={(e) => {
                // No autoscroll.
                if (e.button === 1) e.preventDefault();
              }}
            />
          </ContextMenuTrigger>
          <ContextMenuContent
            onCloseAutoFocus={(e) => {
              if (keepFocus.current) e.preventDefault();
              keepFocus.current = false;
            }}
          >
            <ContextMenuItem onSelect={() => onSelect(session.id)}>
              <MessageSquare aria-hidden /> Open
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onOpenInNewTab(session.id)}>
              <SquarePlus aria-hidden /> Open in New Tab
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onNew(session.location.directory)}>
              <SquarePen aria-hidden /> New Conversation in This Folder
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onFork(session.id)}>
              <GitFork aria-hidden /> Fork
            </ContextMenuItem>
            {projects.some((p) => p.key !== projectOf.get(session.id)?.key) && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <FolderInput aria-hidden /> Move to Project
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="max-h-80 overflow-y-auto">
                  {projects
                    .filter((p) => p.key !== projectOf.get(session.id)?.key)
                    .map((p) => (
                      <ContextMenuItem key={p.key} title={tildify(p.root, home)} onSelect={() => moveTo(session, p)}>
                        <ProjectIcon src={icons.get(p.root)} fallback={<Folder aria-hidden />} />
                        <span className="truncate">{p.label}</span>
                      </ContextMenuItem>
                    ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => {
                keepFocus.current = true;
                setRenaming(session.id);
              }}
            >
              <Pencil aria-hidden /> Rename
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onSelect={() => setDeleting(session)}>
              <Trash2 aria-hidden /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </li>
  );

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <nav
      aria-label="Conversations"
      onPointerEnter={hold}
      onPointerLeave={() => !draggingRef.current && setHeld(null)}
      style={style}
      className={cn(sidebarWidthClass, 'shrink-0 flex-col', className)}>
      {/* The window's title bar runs across the list's top, so it drags the window too. */}
      <SidebarTitle icon={<SidebarTitleIcon src="/icons/apps/assistant.png" />} title="Assistant">
        {menu}
        <ToolButton label="New conversation" onClick={() => onNew()}>
          <SquarePen className="size-4.5" strokeWidth={1.75} aria-hidden />
        </ToolButton>
      </SidebarTitle>
      <div className={searchRow}>
        <SearchField
          ref={searchRef}
          size="sm"
          value={filter}
          onValueChange={setFilter}
          placeholder="Search"
          aria-label="Search conversations"
          title="Search conversations (Ctrl+K)"
          className="flex-1"
        />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading ? (
          <div className="space-y-2 p-2" aria-label="Loading conversations">
            <Skeleton className="h-3 w-1/3" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-4/5" />
            ))}
          </div>
        ) : needle ? (
          matches.length === 0 ? (
            searching ? (
              <p className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Searching…
              </p>
            ) : (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">No conversation matches.</p>
            )
          ) : (
            <>
              <ul className="space-y-0.5">
                {matches.map((s) => row(s, projectOf.get(s.id)?.label ?? directoryName(mains.get(s.location.directory) ?? s.location.directory, home)))}
              </ul>
              {search.hasNextPage && (
                <LoadMore
                  scrollRef={scrollRef}
                  edge="bottom"
                  loaded={found.length}
                  loading={search.isFetching}
                  failed={search.isFetchNextPageError}
                  onLoad={() => void search.fetchNextPage()}
                  label="Show more matches"
                  loadingLabel="Searching…"
                  className="mt-2"
                />
              )}
            </>
          )
        ) : listed.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Conversations you start show up here.</p>
        ) : (
          <div className="space-y-3">
            {needsYou.length > 0 && (
              <section aria-labelledby="assistant-needs-you">
                <h3 id="assistant-needs-you" className={cn(sidebarHeadingClass, 'gap-1.5 text-ink-accent')}>
                  Needs you
                  <span className="mb-1 size-1.5 rounded-full bg-primary" aria-hidden />
                </h3>
                <ul className="space-y-0.5">{needsYou.map((s) => row(s, projectOf.get(s.id)?.label))}</ul>
              </section>
            )}
            {projects.map((project) => {
              const open = !collapsed.includes(project.key);
              const all = expanded.has(project.key);
              const sessions = project.sessions.filter((s) => !waiting.has(s.id));
              const shown = all
                ? sessions
                : sessions.filter((s, i) => i < PROJECT_LIMIT || s.id === selected || busy.has(s.id));
              const hidden = sessions.length - shown.length;
              if (sessions.length === 0) return null;
              const accepts = draggedSession !== undefined && projectOf.get(draggedSession.id)?.key !== project.key;
              return (
                <section
                  key={project.key}
                  aria-label={project.label}
                  onDragOver={(e) => {
                    if (!accepts || !e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropTarget(project.key);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDropTarget((key) => (key === project.key ? null : key));
                    }
                  }}
                  onDrop={(e) => {
                    if (!accepts) return;
                    e.preventDefault();
                    moveTo(draggedSession, project);
                    endDrag();
                  }}
                  className={cn(
                    'rounded-lg motion-safe:transition-colors',
                    dropTarget === project.key && accepts && 'bg-selected ring-2 ring-ring/60',
                  )}
                >
                  <div className="group flex items-center gap-1">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggleCollapsed(project.key)}
                          title={tildify(project.root, home)}
                          // The project's icon (a folder when it has none) on the
                          // rows' line, then its name; the chevron at the end
                          // only while pointed at or reached by keyboard, not
                          // left showing by the click that collapsed it.
                          className={cn('flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground', focusRing)}
                        >
                          <ProjectIcon
                            src={icons.get(project.root)}
                            className="size-4 shrink-0"
                            fallback={<Folder className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />}
                          />
                          <span className="truncate">{project.label}</span>
                          <ChevronRight
                            className={cn(
                              'ml-auto size-3.5 shrink-0 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 motion-safe:transition-transform',
                              open && 'rotate-90',
                            )}
                            aria-hidden
                          />
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => onNew(project.root)}>
                          <SquarePen aria-hidden /> New Conversation
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => toggleCollapsed(project.key)}>
                          {open ? 'Collapse' : 'Expand'}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    <ToolButton
                      size="xs"
                      label={`New conversation in ${project.label}`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => onNew(project.root)}
                    >
                      <Plus className="size-4" aria-hidden />
                    </ToolButton>
                  </div>
                  {open && (
                    <ProjectSessions
                      projectID={project.sessions[0].projectID}
                      sessions={sessions}
                      shown={shown}
                      expanded={all}
                      // The project may have older ones than the list has loaded.
                      mayHaveOlder={hidden > 0 || (sessions.length >= PROJECT_LIMIT && !!sessionPages.hasNextPage)}
                      waiting={waiting}
                      onToggle={() => toggleExpanded(project.key)}
                      row={row}
                    />
                  )}
                </section>
              );
            })}
            {sessionPages.hasNextPage && (
              <LoadMore
                scrollRef={scrollRef}
                edge="bottom"
                loaded={listed.length}
                loading={sessionPages.isFetching}
                failed={sessionPages.isFetchNextPageError}
                // Most of a page goes under projects' "Show more", so a page may not fill the view.
                auto={false}
                onLoad={() => void sessionPages.fetchNextPage()}
                label="Show older conversations"
                loadingLabel="Loading older conversations…"
              />
            )}
          </div>
        )}
      </div>
      <OpenCodeUpdate className="mx-2.5 mb-2.5 shrink-0" />
      <DeleteConversationDialog
        session={deleting ?? undefined}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => deleting && onDeleted(deleting.id)}
      />
    </nav>
  );
}

/**
 * A project's conversations: the first few, or once expanded all the list
 * has loaded and then the project's older ones from the server, a page at a
 * time.
 */
function ProjectSessions({
  projectID,
  sessions,
  shown,
  expanded,
  mayHaveOlder,
  waiting,
  onToggle,
  row,
}: {
  projectID: string | undefined;
  /** The ones the list has loaded. */
  sessions: SessionInfo[];
  /** Those of them shown while it's not expanded. */
  shown: SessionInfo[];
  expanded: boolean;
  mayHaveOlder: boolean;
  /** Conversations shown under "Needs you" instead. */
  waiting: ReadonlySet<string>;
  onToggle: () => void;
  row: (session: SessionInfo) => ReactNode;
}) {
  const own = useProjectSessions(projectID ?? '', expanded && projectID !== undefined);
  const all = useMemo(() => {
    if (!expanded) return shown;
    const known = new Set(sessions.map((s) => s.id));
    // Older than any the list has loaded, so they go after them.
    return [...sessions, ...(own.data ?? []).filter((s) => !known.has(s.id) && !s.time.archived && !waiting.has(s.id))];
  }, [expanded, shown, sessions, own.data, waiting]);
  const hidden = sessions.length - shown.length;
  const more = 'w-full rounded-md px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <ul className="space-y-0.5">
      {all.map((s) => row(s))}
      {expanded && (own.hasNextPage || own.isFetchingNextPage) && (
        <li>
          <button type="button" disabled={own.isFetching} onClick={() => void own.fetchNextPage()} className={cn(more, 'flex items-center gap-1.5')}>
            {own.isFetchingNextPage && <Loader2 className="size-3 animate-spin" aria-hidden />}
            Show older
          </button>
        </li>
      )}
      {(expanded || mayHaveOlder) && (
        <li>
          <button type="button" onClick={onToggle} className={more}>
            {expanded ? 'Show less' : hidden > 0 ? `Show ${hidden} more` : 'Show more'}
          </button>
        </li>
      )}
    </ul>
  );
}

function SessionRow({
  session,
  tag,
  worktree,
  selected,
  running,
  waiting,
  unread,
  home,
  dragged,
  onSelect,
  ...props
}: Omit<ComponentProps<'button'>, 'onSelect'> & {
  session: SessionInfo;
  /** The project's name, where the list doesn't already say it. */
  tag?: string;
  /** It ran in a worktree, not the project's main checkout. */
  worktree: boolean;
  selected: boolean;
  running: boolean;
  waiting: boolean;
  /** It has unread notifications. */
  unread: boolean;
  home?: string;
  /** It's being dragged to another project. */
  dragged?: boolean;
  onSelect: () => void;
}) {
  const where = tildify(session.location.directory, home);
  return (
    <button
      {...props}
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'page' : undefined}
      title={`${sessionTitle(session)}\n${where}`}
      className={cn(
        sidebarRowClass(selected),
        dragged && 'opacity-50',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{sessionTitle(session)}</span>
      {tag && <span className="max-w-20 shrink-0 truncate text-xs text-muted-foreground">{tag}</span>}
      {worktree && (
        <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-label={`In the worktree ${directoryName(where, home)}`} />
      )}
      {waiting ? (
        <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Waiting for you" />
      ) : running ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Working" />
      ) : unread ? (
        <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread notification" />
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(session.time.updated)}</span>
      )}
    </button>
  );
}

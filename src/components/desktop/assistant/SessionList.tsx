import { useMemo, useRef, useState, type ComponentProps, type CSSProperties, type Ref } from 'react';
import { ChevronRight, GitBranch, Loader2, MessageSquare, Pencil, Plus, Search, SquarePen, SquarePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ConversationTitleInput, DeleteConversationDialog } from '@/components/desktop/assistant/ConversationActions';
import { ProjectIcon } from '@/components/desktop/assistant/ProjectIcon';
import { WindowDragRegion } from '@/components/desktop/WindowHeader';
import {
  useActiveSessions,
  useAssistantSessions,
  useHomeDirectory,
  useMainCheckouts,
  usePendingRequests,
  useProjectIcons,
} from '@/hooks/useAssistant';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { directoryName, relativeTime, sessionTitle, tildify, type SessionInfo } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** How many conversations a project shows before "Show more". */
const PROJECT_LIMIT = 5;

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
 * renames or deletes it; right-clicking a project starts a conversation there.
 */
export function SessionList({
  selected,
  onSelect,
  onOpenInNewTab,
  onNew,
  onDeleted,
  searchRef,
  className,
  style,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenInNewTab: (id: string) => void;
  /** Start a new conversation, in `directory` when given. */
  onNew: (directory?: string) => void;
  /** A conversation was deleted from the list. */
  onDeleted: (id: string) => void;
  /** The search field, for Ctrl+F. */
  searchRef?: Ref<HTMLInputElement>;
  className?: string;
  style?: CSSProperties;
}) {
  const { data: sessions, isLoading } = useAssistantSessions();
  const { data: active = [] } = useActiveSessions();
  const pending = usePendingRequests();
  const home = useHomeDirectory();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useLocalStorage<string[]>('din.assistant.collapsedProjects', []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  // Rename puts focus in the title field; the closing menu mustn't take it back.
  const keepFocus = useRef(false);

  const listed = useMemo(() => (sessions ?? []).filter((s) => !s.time.archived), [sessions]);
  const directories = useMemo(() => [...new Set(listed.map((s) => s.location.directory))], [listed]);
  const mains = useMainCheckouts(directories);
  const waitingNow = useMemo(
    () => new Set([...pending.permissions.map((p) => p.sessionID), ...pending.forms.map((f) => f.sessionID)]),
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

  const needle = filter.trim().toLowerCase();
  const matches = needle
    ? listed.filter(
        (s) =>
          sessionTitle(s).toLowerCase().includes(needle) ||
          s.location.directory.toLowerCase().includes(needle) ||
          projectOf.get(s.id)?.label.toLowerCase().includes(needle),
      )
    : [];

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
              running={active.includes(session.id)}
              waiting={waitingNow.has(session.id)}
              home={home}
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
      onPointerLeave={() => setHeld(null)}
      style={style}
      className={cn('w-64 shrink-0 flex-col border-r border-border/60 bg-muted/30', className)}>
      {/* The window's title bar runs across the list's top, so it drags the window too. */}
      <WindowDragRegion className="flex h-9 shrink-0 items-center gap-2 pl-3 pr-2">
        <img src="/icons/apps/assistant.png" alt="" aria-hidden draggable={false} className="size-4 shrink-0 object-contain" />
        {/* In the theme's title font, like a window's title. */}
        <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">
          Assistant
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => onNew()}
        >
          <SquarePen className="size-4" aria-hidden />
        </Button>
      </WindowDragRegion>
      <div className="relative shrink-0 px-2 pb-1">
        <Search className="pointer-events-none absolute left-4.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          ref={searchRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !filter) return;
            e.stopPropagation();
            setFilter('');
          }}
          placeholder="Search"
          aria-label="Search conversations"
          title="Search conversations (Ctrl+F)"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-2 p-2" aria-label="Loading conversations">
            <Skeleton className="h-3 w-1/3" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-4/5" />
            ))}
          </div>
        ) : needle ? (
          matches.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">No conversation matches.</p>
          ) : (
            <ul className="space-y-px">{matches.map((s) => row(s, projectOf.get(s.id)?.label))}</ul>
          )
        ) : listed.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Conversations you start show up here.</p>
        ) : (
          <div className="space-y-3">
            {needsYou.length > 0 && (
              <section aria-labelledby="assistant-needs-you">
                <h3 id="assistant-needs-you" className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-primary">
                  <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                  Needs you
                </h3>
                <ul className="space-y-px">{needsYou.map((s) => row(s, projectOf.get(s.id)?.label))}</ul>
              </section>
            )}
            {projects.map((project) => {
              const open = !collapsed.includes(project.key);
              const all = expanded.has(project.key);
              const sessions = project.sessions.filter((s) => !waiting.has(s.id));
              const shown = all
                ? sessions
                : sessions.filter((s, i) => i < PROJECT_LIMIT || s.id === selected || active.includes(s.id));
              const hidden = sessions.length - shown.length;
              if (sessions.length === 0) return null;
              return (
                <section key={project.key} aria-label={project.label}>
                  <div className="group flex items-center gap-1">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggleCollapsed(project.key)}
                          title={tildify(project.root, home)}
                          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronRight
                            className={cn('size-3.5 shrink-0 motion-safe:transition-transform', open && 'rotate-90')}
                            aria-hidden
                          />
                          <ProjectIcon src={icons.get(project.root)} />
                          <span className="truncate">{project.label}</span>
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`New conversation in ${project.label}`}
                      title={`New conversation in ${project.label}`}
                      onClick={() => onNew(project.root)}
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                  {open && (
                    <ul className="space-y-px">
                      {shown.map((s) => row(s))}
                      {(hidden > 0 || all) && sessions.length > PROJECT_LIMIT && (
                        <li>
                          <button
                            type="button"
                            onClick={() => toggleExpanded(project.key)}
                            className="w-full rounded-md px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {all ? 'Show less' : `Show ${hidden} more`}
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
      <DeleteConversationDialog
        session={deleting ?? undefined}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => deleting && onDeleted(deleting.id)}
      />
    </nav>
  );
}

function SessionRow({
  session,
  tag,
  worktree,
  selected,
  running,
  waiting,
  home,
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
  home?: string;
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
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'bg-foreground/10' : 'hover:bg-foreground/5',
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
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(session.time.updated)}</span>
      )}
    </button>
  );
}

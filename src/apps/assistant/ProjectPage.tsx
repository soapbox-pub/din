import { useMemo, useState, type ReactNode } from 'react';
import { FolderOpen, SquarePen, SquareTerminal } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentedControl } from '@/shared/appChrome';
import { focusRing, roomyMenu } from '@/shared/appChromeStyles';
import { ProjectIcon } from '@/shared/assistant/ProjectIcon';
import { useAssistantHost } from '@/shared/assistant/host';
import {
  useAssistantSessions,
  useMainCheckouts,
  usePreferredModel,
  useProjectIcons,
  useProjectStats,
} from '@/hooks/useAssistant';
import {
  cleanAssistantError,
  directoryName,
  formatCost,
  formatCount,
  modelKey,
  relativeTime,
  sessionTitle,
  tildify,
  totalTokens,
  type AssistantStats,
  type StatsSpan,
} from '@/lib/assistant';
import { cn } from '@/lib/utils';

/*
 * The Assistant's pages for projects: the tiles a new tab offers, and a
 * project's own page, which a tile, the project's heading in the
 * conversation list and `din assistant project` open.
 */

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** A project's icon as a clay tile: its favicon, or the first letter of its name. */
export function ProjectTileIcon({ src, name, size = 'md' }: { src: string | undefined; name: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-16 rounded-[20px]' : 'size-12 rounded-2xl';
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center bg-card clay', box)}>
      <ProjectIcon
        src={src}
        className={cn('rounded-md', size === 'lg' ? 'size-10' : 'size-7')}
        fallback={
          <span className={cn('font-semibold uppercase text-ink-accent', size === 'lg' ? 'text-2xl' : 'text-lg')}>
            {name.replace(/^[^\p{L}\p{N}]+/u, '')[0] ?? name[0]}
          </span>
        }
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The new tab's tiles
// ---------------------------------------------------------------------------

/** What can be done with a project from its tile. */
export interface ProjectActions {
  /** Show its page, in this tab or a new one. */
  onOpen: (directory: string, newTab?: boolean) => void;
  /** Start a conversation in it, in this tab. */
  onNew: (directory: string) => void;
}

/** The projects worked in lately, a row of tiles as the Web Browser's new tab has sites. */
export function ProjectTiles({ folders, home, onOpen, onNew }: ProjectActions & { folders: string[]; home: string | undefined }) {
  const icons = useProjectIcons(folders);
  if (folders.length === 0) return null;
  return (
    <ul aria-label="Recent projects" className="flex flex-wrap justify-center gap-2">
      {folders.map((folder) => (
        <li key={folder} className="w-24">
          <ProjectTile folder={folder} icon={icons.get(folder)} home={home} onOpen={onOpen} onNew={onNew} />
        </li>
      ))}
    </ul>
  );
}

function ProjectTile({
  folder,
  icon,
  home,
  onOpen,
  onNew,
}: ProjectActions & { folder: string; icon: string | undefined; home: string | undefined }) {
  const { openPath, openApp } = useAssistantHost();
  const name = directoryName(folder, home);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={tildify(folder, home)}
          onClick={() => onOpen(folder)}
          onAuxClick={(e) => e.button === 1 && onOpen(folder, true)}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          className={cn('group flex w-full min-w-0 flex-col items-center gap-2 rounded-xl p-2 hover:bg-foreground/5', focusRing)}
        >
          <span className="motion-safe:transition-transform motion-safe:group-hover:scale-105">
            <ProjectTileIcon src={icon} name={name} />
          </span>
          <span className="w-full truncate text-center text-[13px] text-foreground/80">{name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className={cn('w-56', roomyMenu)}>
        <ProjectMenuItems folder={folder} onOpen={onOpen} onNew={onNew} openPath={openPath} openApp={openApp} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ProjectMenuItems({
  folder,
  onOpen,
  onNew,
  openPath,
  openApp,
}: ProjectActions & {
  folder: string;
  openPath: ReturnType<typeof useAssistantHost>['openPath'];
  openApp: ReturnType<typeof useAssistantHost>['openApp'];
}) {
  return (
    <>
      <ContextMenuItem onSelect={() => onOpen(folder)}>Open</ContextMenuItem>
      <ContextMenuItem onSelect={() => onOpen(folder, true)}>Open in New Tab</ContextMenuItem>
      <ContextMenuItem onSelect={() => onNew(folder)}>
        <SquarePen aria-hidden /> New Conversation
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => openPath(folder, 'directory')}>
        <FolderOpen aria-hidden /> Open Folder
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openApp('terminal', { cwd: folder })}>
        <SquareTerminal aria-hidden /> Open in Terminal
      </ContextMenuItem>
    </>
  );
}

// ---------------------------------------------------------------------------
// A project's page
// ---------------------------------------------------------------------------

/** The top of a project's page: its icon, name and folder. */
export function ProjectHeading({ directory, home }: { directory: string; home: string | undefined }) {
  const icon = useProjectIcons([directory]).get(directory);
  const name = directoryName(directory, home);
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <ProjectTileIcon src={icon} name={name} size="lg" />
      <div className="min-w-0 max-w-full">
        <h1 className="truncate font-[family-name:var(--font-title)] text-4xl font-semibold tracking-tight">{name}</h1>
        <p className="mt-1 truncate text-sm text-muted-foreground" title={directory}>
          {tildify(directory, home)}
        </p>
      </div>
    </div>
  );
}

const SPANS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const satisfies readonly { value: StatsSpan; label: string }[];

/** How many of a project's conversations its page lists. */
const RECENT_CONVERSATIONS = 6;

/**
 * Below a project's page's composer: its latest conversations, and what the
 * agent has done in it (OpenCode's statistics, as `opencode stats` shows).
 */
export function ProjectOverview({
  directory,
  home,
  onOpenSession,
}: {
  directory: string;
  home: string | undefined;
  onOpenSession: (sessionID: string) => void;
}) {
  const [span, setSpan] = useState<StatsSpan>('30');
  const stats = useProjectStats(directory, span);
  const data = stats.data;

  return (
    <div className="flex flex-col gap-8">
      <RecentConversations directory={directory} home={home} onOpenSession={onOpenSession} />
      <section aria-labelledby="project-activity" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="project-activity" className="text-sm font-semibold">
            Activity
          </h2>
          <SegmentedControl label="How far back" value={span} options={SPANS} onValueChange={setSpan} />
        </div>
        {stats.isError && !data ? (
          <p className="rounded-xl bg-foreground/[0.04] px-4 py-6 text-center text-sm text-muted-foreground">
            Couldn’t load the statistics: {cleanAssistantError(stats.error)}
          </p>
        ) : !data ? (
          <StatsSkeleton />
        ) : data.sessions === 0 && data.steps === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {span === 'all' ? 'Nothing’s been done here yet.' : `Nothing’s been done here in the last ${span} days.`}
          </p>
        ) : (
          <div className={cn('flex flex-col gap-4 motion-safe:transition-opacity', stats.isPlaceholderData && 'opacity-60')}>
            <StatGrid stats={data} />
            <ActivityChart stats={data} />
            <ModelUsage stats={data} />
          </div>
        )}
      </section>
    </div>
  );
}

function RecentConversations({
  directory,
  home,
  onOpenSession,
}: {
  directory: string;
  home: string | undefined;
  onOpenSession: (sessionID: string) => void;
}) {
  const { data: sessions, isLoading } = useAssistantSessions();
  const listed = useMemo(() => (sessions ?? []).filter((s) => !s.time.archived), [sessions]);
  const directories = useMemo(() => [...new Set(listed.map((s) => s.location.directory))], [listed]);
  const mains = useMainCheckouts(directories);
  // Its worktrees' too: they're the project as much as its main checkout.
  const own = listed
    .filter((s) => (mains.get(s.location.directory) ?? s.location.directory) === directory)
    .slice(0, RECENT_CONVERSATIONS);
  if (!isLoading && own.length === 0) return null;
  return (
    <section aria-labelledby="project-recent" className="flex flex-col gap-2">
      <h2 id="project-recent" className="text-sm font-semibold">
        Recent conversations
      </h2>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5 rounded-xl bg-foreground/[0.03] p-1">
          {own.map((session) => {
            const where = session.location.directory;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(session.id)}
                  title={`${sessionTitle(session)}\n${tildify(where, home)}`}
                  className={cn('flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-foreground/5', focusRing)}
                >
                  <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
                  {where !== directory && (
                    <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{directoryName(where, home)}</span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(session.time.updated)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading the statistics">
      <div className="grid grid-cols-2 gap-2 @xl/assistant:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-28 rounded-xl" />
    </div>
  );
}

function Stat({ label, value, detail, title }: { label: string; value: string; detail?: ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-foreground/[0.04] px-4 py-3" title={title}>
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
    </div>
  );
}

function StatGrid({ stats }: { stats: AssistantStats }) {
  const tokens = totalTokens(stats.tokens);
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return (
    <div className="grid grid-cols-2 gap-2 @xl/assistant:grid-cols-3">
      <Stat
        label="Conversations"
        value={stats.sessions.toLocaleString()}
        detail={stats.subagents > 0 ? `and ${plural(stats.subagents, 'subagent')}` : undefined}
      />
      <Stat label="Messages sent" value={stats.prompts.toLocaleString()} />
      <Stat label="Steps" value={formatCount(stats.steps)} title={`${stats.steps.toLocaleString()} steps: the model’s replies and tool calls`} />
      <Stat
        label="Tokens"
        value={formatCount(tokens)}
        detail={`${formatCount(stats.tokens.output + stats.tokens.reasoning)} written`}
        title={[
          `${stats.tokens.input.toLocaleString()} input`,
          `${stats.tokens.output.toLocaleString()} output`,
          `${stats.tokens.reasoning.toLocaleString()} reasoning`,
          `${stats.tokens.cache.read.toLocaleString()} read from cache`,
          `${stats.tokens.cache.write.toLocaleString()} written to cache`,
        ].join('\n')}
      />
      <Stat label="Cost" value={formatCost(stats.cost) || '$0'} detail={stats.cost > 0 ? 'at the providers’ prices' : 'on plans and free models'} />
      <Stat
        label="Days active"
        value={stats.activeDays.toLocaleString()}
        detail={stats.streak > 1 ? `${stats.streak} in a row` : undefined}
      />
    </div>
  );
}

/** A local day as OpenCode's activity names it. */
function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Past this many days, the chart shows weeks. */
const MAX_DAY_BARS = 120;

/** Steps a day (or a week, over a long span), as bars. */
function ActivityChart({ stats }: { stats: AssistantStats }) {
  const bars = useMemo(() => {
    const steps = new Map(stats.activity.map((a) => [a.date, a.steps]));
    const start = new Date(stats.range.from);
    start.setHours(0, 0, 0, 0);
    // Asked for up to a millisecond past the moment it was asked (projectStats).
    const end = new Date(stats.range.to - 1);
    const days: { date: Date; steps: number }[] = [];
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.push({ date: new Date(d), steps: steps.get(dayKey(d)) ?? 0 });
    }
    if (days.length <= MAX_DAY_BARS) return { unit: 'day' as const, bars: days };
    const weeks: { date: Date; steps: number }[] = [];
    for (let i = 0; i < days.length; i += 7) {
      const week = days.slice(i, i + 7);
      weeks.push({ date: week[0].date, steps: week.reduce((sum, d) => sum + d.steps, 0) });
    }
    return { unit: 'week' as const, bars: weeks };
  }, [stats]);
  const most = Math.max(1, ...bars.bars.map((b) => b.steps));
  const format = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const first = bars.bars[0];
  const last = bars.bars.at(-1);
  return (
    <figure className="flex flex-col gap-2 rounded-xl bg-foreground/[0.04] px-4 pt-4 pb-3">
      <div className="flex h-24 items-end gap-px" role="img" aria-label={`Steps a ${bars.unit}, the most ${most.toLocaleString()}`}>
        {bars.bars.map((bar) => (
          <span
            key={bar.date.getTime()}
            title={`${bars.unit === 'week' ? `Week of ${format(bar.date)}` : format(bar.date)}: ${bar.steps.toLocaleString()} steps`}
            className="flex h-full min-w-0 flex-1 items-end"
          >
            <span
              className={cn('w-full rounded-t-sm', bar.steps > 0 ? 'bg-pigment' : 'bg-foreground/10')}
              style={{ height: bar.steps > 0 ? `${Math.max(4, (bar.steps / most) * 100)}%` : '2px' }}
            />
          </span>
        ))}
      </div>
      {first && last && (
        <figcaption className="flex justify-between text-xs text-muted-foreground">
          <span>{format(first.date)}</span>
          <span>Steps a {bars.unit}</span>
          <span>{last === first ? '' : format(last.date)}</span>
        </figcaption>
      )}
    </figure>
  );
}

/** Which models did the work, by their share of the steps. */
function ModelUsage({ stats }: { stats: AssistantStats }) {
  const { models } = usePreferredModel();
  const names = useMemo(() => new Map(models.map((m) => [modelKey(m), m.name])), [models]);
  // A model used under several thinking levels is one model here.
  const used = useMemo(() => {
    const byKey = new Map<string, { key: string; steps: number; cost: number; tokens: number }>();
    for (const m of stats.models) {
      const key = modelKey(m.model);
      const entry = byKey.get(key) ?? { key, steps: 0, cost: 0, tokens: 0 };
      entry.steps += m.steps;
      entry.cost += m.cost;
      entry.tokens += totalTokens(m.tokens);
      byKey.set(key, entry);
    }
    return [...byKey.values()].sort((a, b) => b.steps - a.steps);
  }, [stats.models]);
  const steps = used.reduce((sum, m) => sum + m.steps, 0);
  if (used.length === 0 || steps === 0) return null;
  return (
    <section aria-label="Models" className="flex flex-col gap-3 rounded-xl bg-foreground/[0.04] px-4 py-3">
      <h3 className="text-xs text-muted-foreground">Models</h3>
      <ul className="flex flex-col gap-3">
        {used.map((m) => {
          const share = m.steps / steps;
          const cost = formatCost(m.cost);
          return (
            <li key={m.key} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate" title={m.key}>
                  {names.get(m.key) ?? m.key.split('/').slice(1).join('/')}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {[`${Math.round(share * 100)}%`, `${formatCount(m.tokens)} tokens`, cost].filter(Boolean).join(' · ')}
                </span>
              </div>
              <span className="h-1.5 overflow-hidden rounded-full bg-foreground/10" aria-hidden>
                <span className="block h-full rounded-full bg-pigment" style={{ width: `${Math.max(1, share * 100)}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

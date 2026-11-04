import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cog,
  OctagonX,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps, type InstalledAppsManager } from '@/contexts/InstalledAppsContext';
import { SYSTEM_HISTORY_LENGTH, useSystemMonitor } from '@/hooks/useSystemMonitor';
import { useToast } from '@/hooks/useToast';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { WEB_APP_ICON } from '@/lib/appIcons';
import { formatBytes } from '@/lib/fs';
import {
  cleanSystemMonitorError,
  getSystemMonitorBridge,
  type DiskTotals,
  type FilesystemSpace,
  type PageInfo,
  type ProcessInfo,
  type SpaceLevel,
  type SystemSnapshot,
} from '@/lib/systemMonitor';
import { cn } from '@/lib/utils';

const ROW_HEIGHT = 40;
const DIN_ICON = '/din-logo.svg';
/** Background programs Din can't put a face to. */
const PROCESS_ICON: LucideIcon = Cog;

type SortKey = 'name' | 'cpu' | 'gpu' | 'memory' | 'pid' | 'user';
interface SortOrder {
  key: SortKey;
  descending: boolean;
}

/** One process inside a group, labelled for it. */
interface Member {
  process: ProcessInfo;
  label: string;
  detail: string;
}

/**
 * What the table lists at the top level: an app with all its processes (a
 * native app and its children, the Web Browser's tabs, Din itself), or one
 * process on its own.
 */
interface Group {
  key: string;
  label: string;
  icon: LucideIcon | string;
  members: Member[];
}

/** One line of the table: a group, or one of an expanded group's processes. */
interface Row {
  key: string;
  depth: 0 | 1;
  label: string;
  detail: string;
  icon: LucideIcon | string | null;
  cpu: number;
  /** Null when it can't be read. */
  gpu: number | null;
  memory: number;
  /** Null for a group of several processes. */
  pid: number | null;
  user: string;
  /** What ending this row ends. */
  pids: number[];
  blocked: string | null;
  notResponding: boolean;
  expandable: boolean;
  expanded: boolean;
  /** Tooltip: the command line(s). */
  title: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function pageLabel(page: PageInfo): string {
  switch (page.kind) {
    case 'private-tab':
      return 'Private tab';
    case 'devtools':
      return 'Developer Tools';
    default:
      return page.title.trim() || hostOf(page.url) || 'Page';
  }
}

function pagesLabel(pages: PageInfo[]): string {
  const first = pageLabel(pages[0]);
  return pages.length > 1 ? `${first} and ${pages.length - 1} more` : first;
}

/** Sort processes into the groups the table shows. */
function groupProcesses(
  processes: ProcessInfo[],
  apps: Pick<InstalledAppsManager, 'getApp' | 'findAppIdForUrl'>,
): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, icon: LucideIcon | string, member: Member) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, label, icon, members: [] };
      groups.set(key, group);
    }
    group.members.push(member);
  };
  const toDin = (member: Member) => add('din', 'Din', DIN_ICON, member);

  for (const process of processes) {
    const { role } = process;
    const plain = { process, label: process.name, detail: process.detail };
    if (!role) {
      add(`pid:${process.pid}`, process.name, PROCESS_ICON, plain);
      continue;
    }
    switch (role.kind) {
      case 'din':
        toDin({ ...plain, label: role.label, detail: process.name });
        break;
      case 'helper':
        toDin(plain);
        break;
      case 'app': {
        const app = apps.getApp(role.appId);
        add(`app:${role.appId}`, app?.name ?? process.name, app?.icon ?? PROCESS_ICON, plain);
        break;
      }
      case 'pages': {
        const [first] = role.pages;
        if (!first) {
          toDin({ ...plain, label: 'Spare page process' });
          break;
        }
        const member = {
          process,
          label: pagesLabel(role.pages),
          detail: first.kind === 'private-tab' ? '' : hostOf(first.url),
        };
        if (first.kind === 'web-app') {
          const appId = apps.findAppIdForUrl(first.url);
          const app = appId && apps.getApp(appId);
          if (app) add(`app:${app.id}`, app.name, app.icon, member);
          else add(`pid:${process.pid}`, member.label, WEB_APP_ICON, member);
        } else if (first.kind === 'page') {
          toDin(member);
        } else {
          const browser = apps.getApp('web-browser');
          add('app:web-browser', browser?.name ?? 'Web Browser', browser?.icon ?? WEB_APP_ICON, member);
        }
        break;
      }
    }
  }
  return [...groups.values()];
}

function memberMatches(member: Member, query: string): boolean {
  const { process } = member;
  return (
    member.label.toLowerCase().includes(query) ||
    member.detail.toLowerCase().includes(query) ||
    process.name.toLowerCase().includes(query) ||
    process.command.toLowerCase().includes(query) ||
    process.user.toLowerCase().includes(query) ||
    String(process.pid) === query
  );
}

function notResponding(process: ProcessInfo): boolean {
  return process.role?.kind === 'pages' && process.role.pages.some((page) => !page.responding);
}

function stateNote(process: ProcessInfo): string | null {
  if (process.state === 'Z') return 'Exited';
  if (process.state === 'T' || process.state === 't') return 'Paused';
  return null;
}

function memberRow(groupKey: string, member: Member): Row {
  const { process } = member;
  const note = stateNote(process);
  return {
    key: `${groupKey}/${process.pid}`,
    depth: 1,
    label: member.label,
    detail: note ?? (member.detail === member.label ? '' : member.detail),
    icon: null,
    cpu: process.cpu,
    gpu: process.gpu,
    memory: process.memory,
    pid: process.pid,
    user: process.user,
    pids: [process.pid],
    blocked: process.blocked,
    notResponding: notResponding(process),
    expandable: false,
    expanded: false,
    title: process.command,
  };
}

function groupRow(group: Group, members: Member[], expanded: boolean): Row {
  const single = members.length === 1 ? members[0] : null;
  const users = [...new Set(members.map((m) => m.process.user))];
  let detail = `${members.length} processes`;
  if (single) {
    const note = stateNote(single.process);
    detail = note ?? (single.label === group.label ? single.detail : single.label);
  }
  return {
    key: group.key,
    depth: 0,
    label: group.label,
    detail,
    icon: group.icon,
    cpu: members.reduce((sum, m) => sum + m.process.cpu, 0),
    gpu: members.reduce<number | null>(
      (sum, m) => (m.process.gpu === null ? sum : (sum ?? 0) + m.process.gpu),
      null,
    ),
    memory: members.reduce((sum, m) => sum + m.process.memory, 0),
    pid: single ? single.process.pid : null,
    user: users.join(', '),
    pids: members.map((m) => m.process.pid),
    blocked: members.find((m) => m.process.blocked)?.process.blocked ?? null,
    notResponding: members.some((m) => notResponding(m.process)),
    expandable: members.length > 1,
    expanded: members.length > 1 && expanded,
    title: members.map((m) => m.process.command).join('\n'),
  };
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function compareRows(a: Row, b: Row, sort: SortOrder): number {
  let order = 0;
  if (sort.key === 'cpu') order = a.cpu - b.cpu;
  else if (sort.key === 'gpu') order = (a.gpu ?? -1) - (b.gpu ?? -1);
  else if (sort.key === 'memory') order = a.memory - b.memory;
  else if (sort.key === 'pid') order = (a.pid ?? Math.min(...a.pids)) - (b.pid ?? Math.min(...b.pids));
  else if (sort.key === 'user') order = NAME_COLLATOR.compare(a.user, b.user);
  if (order === 0) order = NAME_COLLATOR.compare(a.label, b.label);
  if (order === 0) order = (a.pid ?? 0) - (b.pid ?? 0);
  return sort.descending ? -order : order;
}

/** The table's lines, filtered, grouped, sorted and flattened. */
function buildRows(
  groups: Group[],
  { mineOnly, query, sort, expanded }: { mineOnly: boolean; query: string; sort: SortOrder; expanded: Set<string> },
): Row[] {
  const q = query.trim().toLowerCase();
  const tops: { row: Row; children: Row[] }[] = [];
  for (const group of groups) {
    let members = mineOnly ? group.members.filter((m) => m.process.mine) : group.members;
    if (q && !group.label.toLowerCase().includes(q)) members = members.filter((m) => memberMatches(m, q));
    if (members.length === 0) continue;
    // A search opens the groups it found something inside.
    const open = expanded.has(group.key) || (q !== '' && !group.label.toLowerCase().includes(q));
    const row = groupRow(group, members, open);
    const children = row.expanded
      ? members.map((m) => memberRow(group.key, m)).sort((a, b) => compareRows(a, b, sort))
      : [];
    tops.push({ row, children });
  }
  tops.sort((a, b) => compareRows(a.row, b.row, sort));
  return tops.flatMap(({ row, children }) => [row, ...children]);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** A small line graph of the last minute, from 0 to `max`. */
function Sparkline({ values, max = 100, className }: { values: number[]; max?: number; className?: string }) {
  const width = SYSTEM_HISTORY_LENGTH - 1;
  const start = width - (values.length - 1);
  const points = values.map(
    (v, i) => `${start + i},${(100 - Math.min(100, Math.max(0, (v / max) * 100))).toFixed(2)}`,
  );
  const line = points.length > 1 ? `M${points.join('L')}` : '';
  return (
    <svg
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      className={cn('overflow-visible', className)}
      aria-hidden
    >
      {line && (
        <>
          <path d={`${line}L${width},100L${start},100Z`} className="fill-current opacity-15" />
          <path
            d={line}
            className="fill-none stroke-current"
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}

function StatCard({
  label,
  value,
  detail,
  detailTitle,
  history,
  max,
  tone,
  warning = 'ok',
  className,
  children,
}: {
  label: string;
  value: string;
  detail: string;
  /** Tooltip on the detail line. */
  detailTitle?: string;
  history: number[];
  /** The graph's top; 100 for percentages. */
  max?: number;
  tone: string;
  warning?: SpaceLevel;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-gradient-to-b to-transparent p-3 shadow-xs',
        warning === 'critical'
          ? 'border-destructive/60 from-destructive/[0.08]'
          : warning === 'low'
            ? 'border-amber-500/60 from-amber-500/[0.08]'
            : 'border-border/60 from-foreground/[0.03]',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
        <p className="text-xl font-semibold tabular-nums" aria-live="off">
          {value}
        </p>
      </div>
      <p
        title={detailTitle}
        className={cn(
          'flex items-center gap-1 truncate text-xs',
          warning === 'critical'
            ? 'font-medium text-destructive'
            : warning === 'low'
              ? 'font-medium text-amber-700 dark:text-amber-300'
              : 'text-muted-foreground',
        )}
      >
        {warning !== 'ok' && <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate">{detail}</span>
      </p>
      <Sparkline values={history} max={max} className={cn('mt-2 h-10 w-full flex-auto', tone)} />
      {children}
    </section>
  );
}

const SPACE_RANK: Record<SpaceLevel, number> = { ok: 0, low: 1, critical: 2 };

/** Disk traffic, like "24 MB/s". */
function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/** The smallest top the disk graph scales to, so an idle disk's trickle stays near the floor. */
const DISK_GRAPH_FLOOR = 1024 * 1024;

/** One filesystem's space, as a bar of what's used. */
function SpaceBar({ fs }: { fs: FilesystemSpace }) {
  const used = fs.total > 0 ? ((fs.total - fs.free) / fs.total) * 100 : 0;
  const text = `${formatBytes(fs.free)} free of ${formatBytes(fs.total)}`;
  return (
    <div className="space-y-1" title={fs.mountPoint}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{fs.label}</span>
        <span
          className={cn(
            'truncate tabular-nums',
            fs.level === 'critical'
              ? 'text-destructive'
              : fs.level === 'low'
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-muted-foreground',
          )}
        >
          {text}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${fs.label} disk space used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={`${Math.round(used)}% used, ${text}`}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={cn(
            'h-full rounded-full motion-safe:transition-[width]',
            fs.level === 'critical' ? 'bg-destructive' : fs.level === 'low' ? 'bg-amber-500' : 'bg-chart-4',
          )}
          style={{ width: `${Math.min(100, used)}%` }}
        />
      </div>
    </div>
  );
}

function DiskCard({ disk, history, className }: { disk: DiskTotals; history: number[]; className?: string }) {
  const { io, filesystems } = disk;
  const worst = filesystems.reduce<FilesystemSpace | null>(
    (w, fs) => (fs.level !== 'ok' && (!w || SPACE_RANK[fs.level] > SPACE_RANK[w.level]) ? fs : w),
    null,
  );
  const max = Math.max(DISK_GRAPH_FLOOR, ...history);
  let detail = io ? `read ${formatRate(io.readRate)} · write ${formatRate(io.writeRate)}` : 'Traffic unavailable';
  if (worst) {
    detail = `${worst.label} disk ${worst.level === 'critical' ? 'is running out of space' : 'almost full'}: ${formatBytes(worst.free)} left`;
  }
  const first = filesystems[0];
  return (
    <StatCard
      label="Disk"
      value={
        io
          ? formatRate(io.readRate + io.writeRate)
          : first
            ? formatPercent(first.total > 0 ? ((first.total - first.free) / first.total) * 100 : 0)
            : '–'
      }
      detail={detail}
      detailTitle={
        io
          ? `Read ${formatRate(io.readRate)}, write ${formatRate(io.writeRate)}. Busy ${formatPercent(io.activeTime)} of the time.`
          : undefined
      }
      history={history}
      max={max}
      tone="text-chart-4"
      warning={worst?.level ?? 'ok'}
      className={className}
    >
      {filesystems.length > 0 && (
        <div className="mt-2 space-y-2">
          {filesystems.map((fs) => (
            <SpaceBar key={fs.mountPoint} fs={fs} />
          ))}
        </div>
      )}
    </StatCard>
  );
}

function SystemHeader({
  snapshot,
  cpuHistory,
  memoryHistory,
  gpuHistory,
  diskHistory,
}: {
  snapshot: SystemSnapshot | null;
  cpuHistory: number[];
  memoryHistory: number[];
  gpuHistory: number[];
  diskHistory: number[];
}) {
  if (!snapshot) {
    return (
      <div className="grid grid-cols-2 gap-3 p-3 pb-2 @2xl:grid-cols-3" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={cn('space-y-2 rounded-xl border border-border/60 p-3', i === 2 && 'col-span-2 @2xl:col-span-1')}
          >
            <div className="flex justify-between">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    );
  }
  const { memory, gpu, disk } = snapshot;
  const swap =
    memory.swapTotal > 0 ? ` · swap ${formatBytes(memory.swapUsed)} of ${formatBytes(memory.swapTotal)}` : '';
  return (
    <div className={cn('grid grid-cols-2 gap-3 p-3 pb-2', gpu ? '@2xl:grid-cols-4' : '@2xl:grid-cols-3')}>
      <StatCard
        label="CPU"
        value={formatPercent(snapshot.cpu)}
        detail={`${snapshot.cpuCount} ${snapshot.cpuCount === 1 ? 'core' : 'cores'} · up ${formatUptime(snapshot.uptime)}`}
        history={cpuHistory}
        tone="text-chart-1"
      />
      <StatCard
        label="Memory"
        value={formatPercent(memory.total > 0 ? (memory.used / memory.total) * 100 : 0)}
        detail={`${formatBytes(memory.used)} of ${formatBytes(memory.total)}${swap}`}
        history={memoryHistory}
        tone="text-chart-2"
      />
      {gpu && (
        <StatCard
          label="GPU"
          value={formatPercent(gpu.busy)}
          detail={gpu.memoryTotal > 0
            ? `${formatBytes(gpu.memoryUsed)} of ${formatBytes(gpu.memoryTotal)}${
              gpu.sharedUsed > 0 ? ` · ${formatBytes(gpu.sharedUsed)} shared` : ''
            }`
            : 'Uses system memory'}
          history={gpuHistory}
          tone="text-chart-3"
        />
      )}
      <DiskCard disk={disk} history={diskHistory} className={cn(!gpu && 'col-span-2 @2xl:col-span-1')} />
    </div>
  );
}

const COLUMNS: { key: SortKey; label: string; className: string; align?: 'right' }[] = [
  { key: 'name', label: 'Name', className: 'min-w-0 flex-1' },
  { key: 'cpu', label: 'CPU', className: 'w-16 shrink-0', align: 'right' },
  { key: 'gpu', label: 'GPU', className: 'hidden w-16 shrink-0 @md:flex', align: 'right' },
  { key: 'memory', label: 'Memory', className: 'w-20 shrink-0', align: 'right' },
  { key: 'pid', label: 'PID', className: 'hidden w-16 shrink-0 @lg:flex', align: 'right' },
  { key: 'user', label: 'User', className: 'hidden w-24 shrink-0 @2xl:flex' },
];

function TableHeader({
  sort,
  onSort,
  showGpu,
}: {
  sort: SortOrder;
  onSort: (key: SortKey) => void;
  showGpu: boolean;
}) {
  return (
    <div
      role="row"
      className="flex h-8 shrink-0 items-stretch gap-3 border-y border-border/60 bg-background/95 pl-4 pr-5 text-xs text-muted-foreground"
    >
      {COLUMNS.filter((col) => showGpu || col.key !== 'gpu').map((col) => {
        const active = sort.key === col.key;
        return (
          <button
            key={col.key}
            type="button"
            role="columnheader"
            aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
            onClick={() => onSort(col.key)}
            className={cn(
              col.className,
              'flex items-center gap-1 rounded-sm font-medium hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              col.align === 'right' && 'justify-end',
              active && 'text-foreground',
            )}
          >
            {col.label}
            {active &&
              (sort.descending ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronUp className="size-3.5" aria-hidden />
              ))}
          </button>
        );
      })}
    </div>
  );
}

function rowDomId(key: string): string {
  return `system-monitor-row-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

const TableRow = memo(function TableRow({
  row,
  index,
  selected,
  focused,
  showGpu,
  onSelect,
  onToggle,
}: {
  row: Row;
  index: number;
  selected: boolean;
  focused: boolean;
  showGpu: boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      id={rowDomId(row.key)}
      role="row"
      aria-selected={selected}
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-rowindex={index + 2}
      title={row.title}
      className={cn(
        'absolute inset-x-0 flex items-center gap-3 rounded-md pl-2 pr-3 text-sm',
        selected ? (focused ? 'bg-primary/20' : 'bg-foreground/10') : 'hover:bg-foreground/5',
      )}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      onMouseDown={(e) => {
        if (e.button === 0 || e.button === 2) onSelect(row.key);
      }}
      onDoubleClick={() => row.expandable && onToggle(row.key)}
    >
      <div role="gridcell" className={cn('flex min-w-0 flex-1 items-center gap-2', row.depth === 1 && 'pl-9')}>
        {row.depth === 0 && (
          <span className="flex size-5 shrink-0 items-center justify-center">
            {row.expandable && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={row.expanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(row.key);
                }}
                className="rounded-sm text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={cn('size-4 motion-safe:transition-transform', row.expanded && 'rotate-90')}
                  aria-hidden
                />
              </button>
            )}
          </span>
        )}
        {row.icon && (
          <AppIcon
            icon={row.icon}
            className={cn(
              'size-6 shrink-0 object-contain',
              typeof row.icon !== 'string' && 'p-0.5 text-muted-foreground',
            )}
          />
        )}
        <span className="min-w-0 truncate">
          <span className="text-foreground">{row.label}</span>
          {row.detail && <span className="ml-2 text-xs text-muted-foreground">{row.detail}</span>}
        </span>
        {row.notResponding && (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            Not responding
          </span>
        )}
      </div>
      <span role="gridcell" className="w-16 shrink-0 text-right text-xs tabular-nums">
        {formatPercent(row.cpu)}
      </span>
      {showGpu && (
        <span role="gridcell" className="hidden w-16 shrink-0 text-right text-xs tabular-nums @md:block">
          {row.gpu === null ? '–' : formatPercent(row.gpu)}
        </span>
      )}
      <span role="gridcell" className="w-20 shrink-0 text-right text-xs tabular-nums">
        {formatBytes(row.memory)}
      </span>
      <span
        role="gridcell"
        className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground @lg:block"
      >
        {row.pid ?? ''}
      </span>
      <span role="gridcell" className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground @2xl:block">
        {row.user}
      </span>
    </div>
  );
});

function TableSkeleton() {
  return (
    <div className="space-y-1 px-2 py-1" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-3 px-2">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${40 + ((i * 37) % 45)}%` }} />
          <span className="flex-1" />
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * The System Monitor: what's running, what it costs, and a way to stop what
 * won't stop. Apps are listed with everything they started folded under
 * them; CPU is a share of the whole machine, so the column adds up to the
 * total in the header. GPU shows where the driver says how busy it is.
 * Disk shows traffic, not a percentage, and how full /home is.
 */
export function SystemMonitor() {
  const { available, snapshot, cpuHistory, memoryHistory, gpuHistory, diskHistory } = useSystemMonitor();
  const { getApp, findAppIdForUrl } = useInstalledApps();
  const { toast } = useToast();

  const [mineOnly, setMineOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOrder>({ key: 'cpu', descending: true });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [gridFocused, setGridFocused] = useState(false);
  const [confirming, setConfirming] = useState<Row | null>(null);

  const groups = useMemo(
    () => (snapshot ? groupProcesses(snapshot.processes, { getApp, findAppIdForUrl }) : []),
    [snapshot, getApp, findAppIdForUrl],
  );
  const rows = useMemo(
    () => buildRows(groups, { mineOnly, query, sort, expanded }),
    [groups, mineOnly, query, sort, expanded],
  );
  const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
  const selected = selectedIndex >= 0 ? rows[selectedIndex] : null;

  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({
    count: rows.length,
    rowHeight: ROW_HEIGHT,
    overscan: 8,
  });

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, descending: !prev.descending }
        : // Numbers read best biggest first; names and users A to Z.
          { key, descending: key === 'cpu' || key === 'gpu' || key === 'memory' },
    );
  }, []);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const endRow = useCallback(
    async (row: Row, force: boolean) => {
      const bridge = getSystemMonitorBridge();
      if (!bridge) return;
      if (row.blocked) {
        toast({ title: `Can’t end ${row.label}`, description: row.blocked, variant: 'destructive' });
        return;
      }
      const results = await Promise.allSettled(
        row.pids.map((pid) => (force ? bridge.forceQuit(pid) : bridge.end(pid))),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        toast({
          title: `Couldn’t ${force ? 'force quit' : 'end'} ${row.label}`,
          description: cleanSystemMonitorError(failed.reason),
          variant: 'destructive',
        });
      }
    },
    [toast],
  );

  // Keep the keyboard's row in view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
    // Only when the selection moves, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const page = Math.max(1, Math.floor((containerRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const move = (index: number) => {
      e.preventDefault();
      setSelectedKey(rows[Math.min(rows.length - 1, Math.max(0, index))].key);
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(selectedIndex + 1);
      case 'ArrowUp':
        return move(selectedIndex < 0 ? 0 : selectedIndex - 1);
      case 'PageDown':
        return move(selectedIndex + page);
      case 'PageUp':
        return move(selectedIndex - page);
      case 'Home':
        return move(0);
      case 'End':
        return move(rows.length - 1);
      case 'ArrowRight':
        if (selected?.expandable && !selected.expanded) {
          e.preventDefault();
          toggle(selected.key);
        }
        return;
      case 'ArrowLeft':
        if (!selected) return;
        e.preventDefault();
        if (selected.expanded) toggle(selected.key);
        else if (selected.depth === 1) setSelectedKey(selected.key.slice(0, selected.key.lastIndexOf('/')));
        return;
      case 'Enter':
        if (selected?.expandable) {
          e.preventDefault();
          toggle(selected.key);
        }
        return;
      case 'Delete':
        if (!selected) return;
        e.preventDefault();
        if (e.shiftKey) setConfirming(selected);
        else void endRow(selected, false);
        return;
    }
  };

  if (!available) {
    return (
      <div className="grid h-full w-full place-items-center p-6">
        <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <Activity className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="text-sm text-muted-foreground">
            System Monitor needs the Electron shell to see the computer’s processes. Run{' '}
            <code className="rounded bg-foreground/10 px-1 py-0.5">npm run dev</code> or boot DinOS;
            the bridge is not available in a plain browser.
          </p>
        </div>
      </div>
    );
  }

  const showGpu = Boolean(snapshot?.gpu);
  const endLabel = selected ? `End ${selected.label}` : 'End';
  const canEnd = selected !== null && selected.blocked === null;
  const processCount = snapshot
    ? mineOnly
      ? snapshot.processes.filter((p) => p.mine).length
      : snapshot.processes.length
    : 0;

  return (
    <div className="@container flex h-full w-full flex-col bg-background text-foreground">
      <SystemHeader
        snapshot={snapshot}
        cpuHistory={cpuHistory}
        memoryHistory={memoryHistory}
        gpuHistory={gpuHistory}
        diskHistory={diskHistory}
      />

      <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
        <div className="relative min-w-40 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Search processes"
            aria-label="Search processes"
            className="h-8 pl-8 pr-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mineOnly ? 'mine' : 'all'}
          onValueChange={(value) => value && setMineOnly(value === 'mine')}
          aria-label="Which processes to show"
        >
          <ToggleGroupItem value="mine" className="px-3">
            My processes
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="px-3">
            All processes
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex">
          <Button
            size="sm"
            variant="outline"
            className="rounded-r-none border-r-0"
            disabled={!canEnd}
            title={selected?.blocked ?? undefined}
            aria-label={endLabel}
            onClick={() => selected && void endRow(selected, false)}
          >
            End
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                className="w-7 rounded-l-none"
                disabled={!canEnd}
                aria-label="More ways to end it"
              >
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => selected && setConfirming(selected)}>
                <OctagonX aria-hidden /> Force Quit…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        role="treegrid"
        aria-label="Processes"
        aria-rowcount={rows.length + 1}
        aria-multiselectable={false}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TableHeader sort={sort} onSort={onSort} showGpu={showGpu} />
        <ContextMenu>
          <ContextMenuTrigger asChild disabled={!selected}>
            <div
              ref={containerRef}
              onScroll={onScroll}
              // The treegrid's rows hold the keyboard here, beside its header,
              // so the right-click menu's trigger has it.
              // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
              tabIndex={0}
              aria-activedescendant={selected ? rowDomId(selected.key) : undefined}
              onKeyDown={onGridKeyDown}
              onFocus={() => {
                setGridFocused(true);
                if (!selected && rows.length > 0) setSelectedKey(rows[0].key);
              }}
              onBlur={() => setGridFocused(false)}
              onMouseDown={(e: MouseEvent<HTMLDivElement>) => {
                // A click on empty space below the rows clears the selection.
                if (e.target === e.currentTarget) setSelectedKey(null);
              }}
              className="relative min-h-0 flex-1 overflow-y-auto px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {!snapshot ? (
                <TableSkeleton />
              ) : rows.length === 0 ? (
                <div className="grid h-full place-items-center p-6">
                  <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-10 text-center">
                    <p className="text-sm text-muted-foreground">
                      {query ? `Nothing running matches “${query.trim()}”.` : 'No processes to show.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="relative" style={{ height: totalHeight }}>
                  {rows.slice(start, end).map((row, i) => (
                    <TableRow
                      key={row.key}
                      row={row}
                      index={start + i}
                      selected={row.key === selectedKey}
                      focused={gridFocused}
                      showGpu={showGpu}
                      onSelect={setSelectedKey}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          {selected && (
            <ContextMenuContent>
              <ContextMenuItem disabled={!canEnd} onSelect={() => void endRow(selected, false)}>
                End
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                disabled={!canEnd}
                onSelect={() => setConfirming(selected)}
              >
                Force Quit…
              </ContextMenuItem>
            </ContextMenuContent>
          )}
        </ContextMenu>
      </div>

      <p className="shrink-0 border-t border-border/60 px-4 py-1.5 text-xs text-muted-foreground" aria-live="off">
        {snapshot ? `${processCount} processes · ` : ''}
        CPU is a share of the whole computer: all cores busy is 100%.
      </p>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force quit {confirming?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops at once, without a chance to save. Anything it hasn’t saved will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirming && void endRow(confirming, true)}
            >
              Force Quit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

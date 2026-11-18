import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, UIEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Cog,
  Copy,
  Globe,
  Puzzle,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { WEB_APP_ICON } from '@/lib/appIcons';
import { formatBytes } from '@/lib/fs';
import {
  getNetworkMonitorBridge,
  type Connection,
  type ConnectionUser,
  type NetworkRequest,
  type RequestSource,
  type WebSocketFrame,
} from '@/lib/networkMonitor';
import { cn } from '@/lib/utils';
import { AppIcon } from '@/shared/AppIcon';
import { SegmentedControl, StatusBar, Toolbar, ToolButton } from '@/shared/appChrome';

const ROW_HEIGHT = 32;
const FRAME_ROW_HEIGHT = 28;
const DIN_ICON = '/din-logo.svg';
/** How often the connections are read again while they're showing. */
const CONNECTIONS_POLL_MS = 2000;

/** What something on the network is to the user: a name and an icon. */
export interface Identity {
  label: string;
  icon: LucideIcon | string;
}

type SortDirection = { descending: boolean };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A request's name in the list: the last part of its path, or its host for the root. */
function nameOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:') return 'data:';
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.length > 0 ? decodeURIComponent(parts[parts.length - 1]) : u.host || url;
    return u.search ? `${last}${u.search.length > 40 ? `${u.search.slice(0, 40)}…` : u.search}` : last;
  } catch {
    return url;
  }
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function formatClock(at: number): string {
  const ms = String(Math.floor(at % 1000)).padStart(3, '0');
  return `${TIME_FORMAT.format(at)}.${ms}`;
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// --- Requests ---------------------------------------------------------------

export type RequestFilter = 'all' | 'fetch' | 'document' | 'code' | 'media' | 'websocket' | 'other';

const FILTERS: readonly { value: RequestFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Everything' },
  { value: 'fetch', label: 'Fetch', title: 'Fetch and XHR: what pages ask servers for' },
  { value: 'document', label: 'Pages', title: 'Documents: pages and frames' },
  { value: 'code', label: 'Code', title: 'Scripts and style sheets' },
  { value: 'media', label: 'Media', title: 'Images, video, audio and fonts' },
  { value: 'websocket', label: 'Sockets', title: 'WebSockets, Nostr relays among them' },
  { value: 'other', label: 'Other', title: 'Everything else' },
];

function categoryOf(type: string): Exclude<RequestFilter, 'all'> {
  switch (type) {
    case 'Fetch':
    case 'XHR':
    case 'EventSource':
    case 'Preflight':
      return 'fetch';
    case 'Document':
      return 'document';
    case 'Script':
    case 'Stylesheet':
      return 'code';
    case 'Image':
    case 'Media':
    case 'Font':
      return 'media';
    case 'WebSocket':
      return 'websocket';
    default:
      return 'other';
  }
}

const TYPE_LABELS: Record<string, string> = {
  Document: 'Page',
  Stylesheet: 'Style',
  Image: 'Image',
  Media: 'Media',
  Font: 'Font',
  Script: 'Script',
  XHR: 'XHR',
  Fetch: 'Fetch',
  EventSource: 'Events',
  WebSocket: 'WebSocket',
  Manifest: 'Manifest',
  Preflight: 'Preflight',
  Ping: 'Ping',
  CSPViolationReport: 'Report',
  SignedExchange: 'Exchange',
  TextTrack: 'Captions',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Other';
}

/** Who a request came from, to the user. */
function useSourceIdentity(): (source: Omit<RequestSource, 'contentsId'>) => Identity {
  const { getApp, findAppIdForUrl } = useInstalledApps();
  return useCallback(
    (source: Omit<RequestSource, 'contentsId'>): Identity => {
      if (source.kind === 'desktop') return { label: 'Din', icon: DIN_ICON };
      let scheme = '';
      let host = '';
      try {
        const u = new URL(source.url);
        scheme = u.protocol;
        host = u.host;
      } catch {
        // No address yet.
      }
      if (source.kind === 'browser-tab') {
        const browser = getApp('web-browser');
        return { label: source.title.trim() || host || 'Browser tab', icon: browser?.icon ?? WEB_APP_ICON };
      }
      if (source.kind === 'web-app') {
        const id = findAppIdForUrl(source.url);
        const app = id ? getApp(id) : undefined;
        return { label: app?.name ?? (source.title.trim() || host), icon: app?.icon ?? WEB_APP_ICON };
      }
      if (scheme === 'din:') {
        const app = getApp(host);
        return { label: app?.name ?? host, icon: app?.icon ?? DIN_ICON };
      }
      if (scheme === 'widget:') return { label: `${source.title.trim() || host} widget`, icon: DIN_ICON };
      if (scheme === 'chrome-extension:') return { label: source.title.trim() || 'Extension', icon: Puzzle };
      return { label: source.title.trim() || host || 'Page', icon: Globe };
    },
    [getApp, findAppIdForUrl],
  );
}

type RequestSortKey = 'started' | 'name' | 'status' | 'type' | 'source' | 'size' | 'time';

interface RequestRow {
  request: NetworkRequest;
  name: string;
  host: string;
  source: Identity;
}

function durationOf(request: NetworkRequest, now: number): number {
  return (request.endedAt ?? now) - request.startedAt;
}

function compareRequests(a: RequestRow, b: RequestRow, key: RequestSortKey, now: number): number {
  switch (key) {
    case 'name':
      return NAME_COLLATOR.compare(a.name, b.name);
    case 'status':
      return (a.request.status ?? (a.request.state === 'failed' ? 1000 : -1)) - (b.request.status ?? (b.request.state === 'failed' ? 1000 : -1));
    case 'type':
      return NAME_COLLATOR.compare(typeLabel(a.request.type), typeLabel(b.request.type));
    case 'source':
      return NAME_COLLATOR.compare(a.source.label, b.source.label);
    case 'size':
      return a.request.size - b.request.size;
    case 'time':
      return durationOf(a.request, now) - durationOf(b.request, now);
    default:
      return a.request.startedAt - b.request.startedAt;
  }
}

function requestMatches(row: RequestRow, query: string): boolean {
  const { request } = row;
  return (
    request.url.toLowerCase().includes(query) ||
    row.source.label.toLowerCase().includes(query) ||
    request.method.toLowerCase() === query ||
    String(request.status ?? '') === query ||
    typeLabel(request.type).toLowerCase() === query ||
    request.remoteAddress.includes(query)
  );
}

/** What the Status column says, and in what tone. */
function statusOf(request: NetworkRequest): { text: string; tone: 'normal' | 'muted' | 'good' | 'bad' } {
  if (request.state === 'failed') return { text: request.error?.split(' ')[0] || 'Failed', tone: 'bad' };
  if (request.type === 'WebSocket') {
    if (request.state === 'open') return { text: 'Open', tone: 'good' };
    if (request.state === 'closed') return { text: 'Closed', tone: 'muted' };
    return { text: 'Connecting', tone: 'muted' };
  }
  if (request.status === null) return { text: 'Pending', tone: 'muted' };
  if (request.status >= 400) return { text: String(request.status), tone: 'bad' };
  if (request.status >= 300) return { text: String(request.status), tone: 'muted' };
  return { text: String(request.status), tone: 'normal' };
}

const TONE_CLASS = {
  normal: 'text-foreground',
  muted: 'text-muted-foreground',
  good: 'text-success',
  bad: 'text-destructive',
} as const;

function curlFor(request: NetworkRequest): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl ${quote(request.url)}`];
  if (request.method !== 'GET') parts.push(`-X ${request.method}`);
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    if (name.startsWith(':')) continue;
    parts.push(`-H ${quote(`${name}: ${value}`)}`);
  }
  return parts.join(' \\\n  ');
}

function copy(text: string, toast: ReturnType<typeof useToast>['toast'], what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast({ title: `${what} copied` }),
    () => toast({ title: `Couldn’t copy the ${what.toLowerCase()}`, variant: 'destructive' }),
  );
}

/** Column headers that sort. */
function SortHeader<K extends string>({
  columns,
  sort,
  onSort,
}: {
  columns: readonly { key: K; label: string; className: string; align?: 'right' }[];
  sort: { key: K } & SortDirection;
  onSort: (key: K) => void;
}) {
  return (
    <div
      role="row"
      className="flex h-8 shrink-0 items-stretch gap-3 border-b border-border/60 bg-background/95 pl-4 pr-5 text-xs text-muted-foreground"
    >
      {columns.map((col) => {
        const active = sort.key === col.key;
        return (
          <button
            key={col.key}
            type="button"
            role="columnheader"
            aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
            onClick={() => onSort(col.key)}
            className={cn(
              // Before the column's own, whose `hidden` has to win over `flex`.
              'flex items-center gap-1 rounded-sm font-medium hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              col.className,
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

const REQUEST_COLUMNS: readonly { key: RequestSortKey; label: string; className: string; align?: 'right' }[] = [
  { key: 'name', label: 'Name', className: 'min-w-0 flex-1' },
  { key: 'status', label: 'Status', className: 'w-20 shrink-0' },
  { key: 'type', label: 'Type', className: 'hidden w-20 shrink-0 @lg:flex' },
  { key: 'source', label: 'From', className: 'hidden w-40 shrink-0 @3xl:flex' },
  { key: 'size', label: 'Size', className: 'w-16 shrink-0', align: 'right' },
  { key: 'time', label: 'Time', className: 'hidden w-16 shrink-0 @md:flex', align: 'right' },
];

function iconClass(icon: LucideIcon | string): string {
  return cn('size-5 shrink-0 object-contain', typeof icon !== 'string' && 'p-0.5 text-muted-foreground');
}

const RequestRowView = memo(function RequestRowView({
  row,
  index,
  selected,
  focused,
  now,
  onSelect,
}: {
  row: RequestRow;
  index: number;
  selected: boolean;
  focused: boolean;
  now: number;
  onSelect: (id: string) => void;
}) {
  const { request } = row;
  const status = statusOf(request);
  const live = request.endedAt === null && request.state !== 'open';
  return (
    <div
      id={`network-request-${index}`}
      role="row"
      aria-selected={selected}
      aria-rowindex={index + 2}
      title={request.url}
      className={cn(
        'absolute inset-x-0 flex items-center gap-3 rounded-md pl-2 pr-3 text-sm',
        selected ? (focused ? 'bg-selected' : 'bg-foreground/10') : 'hover:bg-foreground/5',
      )}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      onMouseDown={(e) => {
        if (e.button === 0 || e.button === 2) onSelect(request.id);
      }}
    >
      <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-2">
        <AppIcon icon={row.source.icon} className={iconClass(row.source.icon)} />
        <span className="min-w-0 truncate">
          {request.method !== 'GET' && (
            <span className="mr-1.5 text-xs font-semibold text-muted-foreground">{request.method}</span>
          )}
          <span className={cn(request.state === 'failed' ? 'text-destructive' : 'text-foreground')}>{row.name}</span>
          {row.host && row.host !== row.name && <span className="ml-2 text-xs text-muted-foreground">{row.host}</span>}
        </span>
      </div>
      <span role="gridcell" className={cn('w-20 shrink-0 truncate text-xs tabular-nums', TONE_CLASS[status.tone])}>
        {status.tone === 'good' && <span aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" />}
        {status.text}
      </span>
      <span role="gridcell" className="hidden w-20 shrink-0 truncate text-xs text-muted-foreground @lg:block">
        {typeLabel(request.type)}
      </span>
      <span role="gridcell" className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground @3xl:block">
        {row.source.label}
      </span>
      <span role="gridcell" className="w-16 shrink-0 text-right text-xs tabular-nums">
        {request.fromCache && request.size === 0 ? (
          <span className="text-muted-foreground">Cache</span>
        ) : request.size > 0 ? (
          formatBytes(request.size)
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </span>
      <span
        role="gridcell"
        className={cn('hidden w-16 shrink-0 text-right text-xs tabular-nums @md:block', live && 'text-muted-foreground')}
      >
        {request.state === 'open' ? '' : formatDuration(durationOf(request, now))}
      </span>
    </div>
  );
});

function ListSkeleton() {
  return (
    <div className="space-y-1 px-2 py-1" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-7 items-center gap-3 px-2">
          <Skeleton className="size-5 rounded-md" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${40 + ((i * 37) % 45)}%` }} />
          <span className="flex-1" />
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** Arrow keys, Page Up and Down, Home and End over a list of ids. */
function moveSelection(
  e: KeyboardEvent<HTMLElement>,
  ids: string[],
  selectedIndex: number,
  page: number,
  select: (id: string) => void,
): boolean {
  if (ids.length === 0) return false;
  let index: number;
  switch (e.key) {
    case 'ArrowDown':
      index = selectedIndex + 1;
      break;
    case 'ArrowUp':
      index = selectedIndex < 0 ? 0 : selectedIndex - 1;
      break;
    case 'PageDown':
      index = selectedIndex + page;
      break;
    case 'PageUp':
      index = selectedIndex - page;
      break;
    case 'Home':
      index = 0;
      break;
    case 'End':
      index = ids.length - 1;
      break;
    default:
      return false;
  }
  e.preventDefault();
  select(ids[Math.min(ids.length - 1, Math.max(0, index))]);
  return true;
}

/** The ticking clock pending requests' times count up by. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/**
 * Every page's requests, as a browser's developer tools list them but for
 * the whole desktop: what each app, tab and Din itself fetched, how it went,
 * how big and how long, and, for a chosen one, its headers and (for a
 * WebSocket, a Nostr relay's among them) its messages.
 */
export function RequestsView({
  requests,
  frames,
  framesDropped,
  recording,
  query,
  onQueryChange,
  onClear,
}: {
  requests: Map<string, NetworkRequest>;
  frames: Map<string, WebSocketFrame[]>;
  framesDropped: number;
  recording: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClear: () => void;
}) {
  const identify = useSourceIdentity();
  const openUrl = useOpenUrl();
  const { toast } = useToast();
  const [filter, setFilter] = useState<RequestFilter>('all');
  const [sort, setSort] = useState<{ key: RequestSortKey } & SortDirection>({ key: 'started', descending: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const pending = useMemo(() => [...requests.values()].some((r) => r.endedAt === null && r.state !== 'open'), [requests]);
  const now = useNow(pending);

  const all = useMemo(
    () =>
      [...requests.values()].map((request): RequestRow => ({
        request,
        name: nameOf(request.url),
        host: hostOf(request.url),
        source: identify(request.source),
      })),
    [requests, identify],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter(
      (row) => (filter === 'all' || categoryOf(row.request.type) === filter) && (!q || requestMatches(row, q)),
    );
    if (sort.key !== 'started' || sort.descending) {
      list.sort((a, b) => {
        const order = compareRequests(a, b, sort.key, now) || a.request.startedAt - b.request.startedAt;
        return sort.descending ? -order : order;
      });
    }
    return list;
    // Durations move with `now`, but re-sorting on every tick would make rows jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filter, query, sort]);
  const ids = useMemo(() => rows.map((row) => row.request.id), [rows]);
  const selectedIndex = selectedId ? ids.indexOf(selectedId) : -1;
  const selected = selectedId ? (requests.get(selectedId) ?? null) : null;

  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({
    count: rows.length,
    rowHeight: ROW_HEIGHT,
    overscan: 10,
  });

  // Follow what comes in while scrolled to the end, as a log does.
  const following = useRef(true);
  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    onScroll(e);
    const el = e.currentTarget;
    following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT;
  };
  useEffect(() => {
    const el = containerRef.current;
    if (el && following.current && sort.key === 'started' && !sort.descending) el.scrollTop = el.scrollHeight;
  }, [rows.length, sort, containerRef]);

  // Keep the keyboard's row in view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    // Only when the selection moves, not as rows come in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const onSort = useCallback((key: RequestSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, descending: !prev.descending }
        : { key, descending: key === 'size' || key === 'time' },
    );
  }, []);

  const contextRow = selected;
  const canOpen = contextRow !== null && /^https?:/i.test(contextRow.url);
  const total = rows.reduce((sum, row) => sum + row.request.size, 0);

  return (
    // Beside the list in a wide window, under it otherwise; the list's
    // columns go by the list's own width.
    <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
      <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
        <Toolbar compact className="gap-2 border-t border-border/60 px-2">
          <SegmentedControl
            label="Which requests to show"
            value={filter}
            options={FILTERS}
            onValueChange={setFilter}
            className="min-w-0 overflow-x-auto"
          />
        </Toolbar>
        <div
          role="grid"
          aria-label="Requests"
          aria-rowcount={rows.length + 1}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SortHeader columns={REQUEST_COLUMNS} sort={sort} onSort={onSort} />
          <ContextMenu>
            <ContextMenuTrigger asChild disabled={!contextRow}>
              <div
                ref={containerRef}
                onScroll={handleScroll}
                // The grid's rows hold the keyboard here, beside its header,
                // so the right-click menu's trigger has it.
                // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
                tabIndex={0}
                aria-activedescendant={selectedIndex >= 0 ? `network-request-${selectedIndex}` : undefined}
                onKeyDown={(e) => {
                  const page = Math.max(1, Math.floor((containerRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
                  if (moveSelection(e, ids, selectedIndex, page, setSelectedId)) return;
                  if (e.key === 'Escape' && selectedId) {
                    e.preventDefault();
                    setSelectedId(null);
                  }
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setSelectedId(null);
                }}
                className="relative min-h-0 flex-1 overflow-y-auto px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
              >
                {rows.length === 0 ? (
                  <EmptyNote>
                    {query.trim() || filter !== 'all'
                      ? 'No requests match.'
                      : recording
                        ? 'Recording. Requests show up here as pages load; reload a page to see everything it loads.'
                        : 'Paused. Press Record to see what pages load.'}
                  </EmptyNote>
                ) : (
                  <div className="relative" style={{ height: totalHeight }}>
                    {rows.slice(start, end).map((row, i) => (
                      <RequestRowView
                        key={row.request.id}
                        row={row}
                        index={start + i}
                        selected={row.request.id === selectedId}
                        focused={focused}
                        now={now}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                )}
              </div>
            </ContextMenuTrigger>
            {contextRow && (
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => copy(contextRow.url, toast, 'Address')}>
                  <Copy aria-hidden /> Copy Address
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => copy(curlFor(contextRow), toast, 'Command')}>
                  <Terminal aria-hidden /> Copy as cURL
                </ContextMenuItem>
                <ContextMenuItem disabled={!canOpen} onSelect={() => openUrl(contextRow.url)}>
                  <Globe aria-hidden /> Open in Web Browser
                </ContextMenuItem>
                {hostOf(contextRow.url) && (
                  <ContextMenuItem onSelect={() => onQueryChange(hostOf(contextRow.url))}>
                    <Search aria-hidden /> Show Only {hostOf(contextRow.url)}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => {
                    setSelectedId(null);
                    onClear();
                  }}
                >
                  Clear All
                </ContextMenuItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
        </div>
        <StatusBar aria-live="off" className="px-4">
          <span className="truncate">
            {rows.length === all.length ? `${all.length} requests` : `${rows.length} of ${all.length} requests`}
            {total > 0 ? ` · ${formatBytes(total)}` : ''}
            {framesDropped > 0 ? ` · ${framesDropped} WebSocket messages came too fast to keep` : ''}
          </span>
          <span className="ml-auto hidden shrink-0 @2xl:inline">Private and Tor tabs aren’t recorded.</span>
        </StatusBar>
      </div>
      {selected && (
        <RequestInspector
          key={selected.id}
          request={selected}
          source={identify(selected.source)}
          frames={frames.get(selected.id) ?? []}
          now={now}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// --- The inspector ----------------------------------------------------------

type InspectorTab = 'overview' | 'headers' | 'messages';

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-1 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words select-text', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}

function HeaderList({ title, headers }: { title: string; headers: Record<string, string> }) {
  const entries = Object.entries(headers).sort(([a], [b]) => NAME_COLLATOR.compare(a, b));
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-semibold">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">None seen.</p>
      ) : (
        <dl className="space-y-0.5 font-mono text-xs select-text">
          {entries.map(([name, value]) => (
            <div key={name} className="break-all">
              <dt className="inline font-semibold text-muted-foreground">{name}: </dt>
              <dd className="inline">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** A Nostr message's verb (["EVENT", ...] is EVENT), or null for anything else. */
function nostrVerb(data: string): string | null {
  const match = /^\s*\[\s*"([A-Z]{2,12})"/.exec(data);
  return match ? match[1] : null;
}

function prettyPayload(frame: WebSocketFrame): string {
  if (frame.opcode !== 1) return frame.opcode === 2 ? `Binary, ${formatBytes(frame.length)} (base64):\n${frame.data}` : frame.data;
  if (frame.truncated) return `${frame.data}…`;
  try {
    return JSON.stringify(JSON.parse(frame.data), null, 2);
  } catch {
    return frame.data;
  }
}

const OPCODE_LABELS: Record<number, string> = { 8: 'Close', 9: 'Ping', 10: 'Pong' };

function MessagesTab({ frames }: { frames: WebSocketFrame[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({
    count: frames.length,
    rowHeight: FRAME_ROW_HEIGHT,
    overscan: 10,
  });
  const following = useRef(true);
  useEffect(() => {
    const el = containerRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [frames.length, containerRef]);
  const frame = selected !== null ? frames[selected] : null;

  if (frames.length === 0) {
    return <EmptyNote>No messages yet.</EmptyNote>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        role="listbox"
        aria-label="Messages"
        tabIndex={0}
        onScroll={(e) => {
          onScroll(e);
          const el = e.currentTarget;
          following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - FRAME_ROW_HEIGHT;
        }}
        onKeyDown={(e) => {
          const list = frames.map((_, i) => String(i));
          moveSelection(e, list, selected ?? -1, 8, (id) => setSelected(Number(id)));
        }}
        className={cn(
          'relative min-h-0 overflow-y-auto px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
          frame ? 'h-1/2 shrink-0' : 'flex-1',
        )}
      >
        <div className="relative" style={{ height: totalHeight }}>
          {frames.slice(start, end).map((f, i) => {
            const index = start + i;
            const verb = f.opcode === 1 ? nostrVerb(f.data) : null;
            const Arrow = f.direction === 'sent' ? ArrowUp : ArrowDown;
            return (
              <div
                key={index}
                role="option"
                aria-selected={index === selected}
                tabIndex={-1}
                onMouseDown={() => setSelected(index)}
                className={cn(
                  'absolute inset-x-0 flex items-center gap-2 rounded-md px-2 text-xs',
                  index === selected ? 'bg-selected' : 'hover:bg-foreground/5',
                )}
                style={{ top: index * FRAME_ROW_HEIGHT, height: FRAME_ROW_HEIGHT }}
              >
                <Arrow
                  className={cn('size-3.5 shrink-0', f.direction === 'sent' ? 'text-chart-1' : 'text-chart-2')}
                  aria-label={f.direction === 'sent' ? 'Sent' : 'Received'}
                />
                {verb && (
                  <span className="shrink-0 rounded bg-foreground/[0.07] px-1.5 font-mono text-[11px] font-semibold">
                    {verb}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono">
                  {OPCODE_LABELS[f.opcode] ?? (f.opcode === 2 ? 'Binary message' : f.data)}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(f.length)}</span>
              </div>
            );
          })}
        </div>
      </div>
      {frame && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
          <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
            <span>{frame.direction === 'sent' ? 'Sent' : 'Received'} {formatClock(frame.at)}</span>
            <span className="tabular-nums">· {formatBytes(frame.length)}</span>
            <span className="flex-1" />
            <ToolButton label="Copy message" size="sm" onClick={() => void navigator.clipboard.writeText(frame.data)}>
              <Copy className="size-3.5" aria-hidden />
            </ToolButton>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap break-all select-text">
            {prettyPayload(frame)}
          </pre>
        </div>
      )}
    </div>
  );
}

function RequestInspector({
  request,
  source,
  frames,
  now,
  onClose,
}: {
  request: NetworkRequest;
  source: Identity;
  frames: WebSocketFrame[];
  now: number;
  onClose: () => void;
}) {
  const socket = request.type === 'WebSocket';
  const [tab, setTab] = useState<InspectorTab>(socket ? 'messages' : 'overview');
  const status = statusOf(request);
  const tabs: { value: InspectorTab; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'headers', label: 'Headers' },
    ...(socket ? [{ value: 'messages' as const, label: `Messages${frames.length ? ` (${frames.length})` : ''}` }] : []),
  ];
  return (
    <aside
      aria-label="Request details"
      className="flex h-1/2 min-h-0 shrink-0 flex-col border-t border-border/60 @3xl:h-auto @3xl:w-96 @3xl:border-t-0 @3xl:border-l"
    >
      <div className="flex shrink-0 items-start gap-2 px-3 pt-2">
        <AppIcon icon={source.icon} className={cn(iconClass(source.icon), 'mt-0.5')} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{nameOf(request.url)}</p>
          <p className="truncate text-xs text-muted-foreground" title={request.url}>
            {request.method} {request.url}
          </p>
        </div>
        <ToolButton label="Close details" size="sm" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </ToolButton>
      </div>
      <div className="shrink-0 px-3 py-2">
        <SegmentedControl label="Details" value={tab} options={tabs} onValueChange={setTab} />
      </div>
      {tab === 'messages' ? (
        <MessagesTab frames={frames} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {tab === 'overview' ? (
            <dl>
              <Field label="Status">
                <span className={TONE_CLASS[status.tone]}>
                  {request.status !== null ? `${request.status} ${request.statusText}`.trim() : status.text}
                </span>
              </Field>
              {request.error && <Field label="Error">{request.error}</Field>}
              <Field label="From">{source.label}</Field>
              <Field label="Type">
                {typeLabel(request.type)}
                {request.mimeType ? <span className="text-muted-foreground"> · {request.mimeType}</span> : null}
              </Field>
              <Field label="Address" mono>
                {request.url}
              </Field>
              {request.remoteAddress && (
                <Field label="Server" mono>
                  {request.remoteAddress}
                </Field>
              )}
              {request.protocol && <Field label="Protocol">{request.protocol}</Field>}
              <Field label="Size">
                {request.fromCache && request.size === 0 ? 'From the cache' : formatBytes(request.size)}
                {request.fromCache && request.size > 0 ? ' · cached' : ''}
              </Field>
              {socket && (
                <Field label="Messages">
                  {request.framesSent} sent · {request.framesReceived} received
                </Field>
              )}
              <Field label="Started">{formatClock(request.startedAt)}</Field>
              <Field label={socket ? 'Open for' : 'Took'}>
                {formatDuration(durationOf(request, now))}
                {request.endedAt === null && !socket ? ' so far' : ''}
              </Field>
              {request.redirectedTo && (
                <Field label="Redirected to" mono>
                  {request.redirectedTo}
                </Field>
              )}
              {request.initiator && (
                <Field label="Asked for by" mono>
                  {request.initiator}
                </Field>
              )}
            </dl>
          ) : (
            <div className="space-y-4">
              <HeaderList title="Response" headers={request.responseHeaders} />
              <HeaderList title="Request" headers={request.requestHeaders} />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

// --- Connections ------------------------------------------------------------

const SERVICES: Record<number, string> = {
  22: 'SSH',
  53: 'DNS',
  80: 'HTTP',
  123: 'Time',
  143: 'IMAP',
  443: 'HTTPS',
  465: 'Mail',
  587: 'Mail',
  853: 'Private DNS',
  993: 'IMAP',
  995: 'POP',
  1900: 'SSDP',
  3478: 'STUN',
  5222: 'XMPP',
  5353: 'mDNS',
  8080: 'HTTP',
  8443: 'HTTPS',
  9001: 'Tor',
  19302: 'STUN',
  51820: 'WireGuard',
};

function serviceOf(c: Connection): string {
  const known = SERVICES[c.remotePort];
  if (c.protocol === 'udp' && c.remotePort === 443) return 'QUIC';
  return known ?? `Port ${c.remotePort}`;
}

interface ConnectionRow {
  key: string;
  connection: Connection;
  owner: Identity;
  receiveRate: number;
  sendRate: number;
}

type ConnectionSortKey = 'owner' | 'remote' | 'service' | 'down' | 'up' | 'total';

const CONNECTION_COLUMNS: readonly { key: ConnectionSortKey; label: string; className: string; align?: 'right' }[] = [
  { key: 'owner', label: 'Program', className: 'w-44 shrink-0 @3xl:w-56' },
  { key: 'remote', label: 'Connected to', className: 'min-w-0 flex-1' },
  { key: 'service', label: 'Service', className: 'hidden w-24 shrink-0 @lg:flex' },
  { key: 'down', label: 'Down', className: 'w-20 shrink-0', align: 'right' },
  { key: 'up', label: 'Up', className: 'w-20 shrink-0', align: 'right' },
  { key: 'total', label: 'Total', className: 'hidden w-20 shrink-0 @2xl:flex', align: 'right' },
];

function connectionKey(c: Connection): string {
  return `${c.protocol}|${c.inode}|${c.localAddress}:${c.localPort}|${c.remoteAddress}:${c.remotePort}`;
}

/** The name a connection's other end goes by: the one Din connected by, else its address. */
function remoteLabel(c: Connection): string {
  return c.hostFrom === 'din' && c.remoteHost ? c.remoteHost : c.remoteAddress;
}

/** What a connection is for, as one identity: the app's, or several apps' names under the first's icon. */
function usersIdentity(users: ConnectionUser[], identify: (source: Omit<RequestSource, 'contentsId'>) => Identity): Identity | null {
  const identities: Identity[] = [];
  // Din's own desktop last: an app's connection it shares is the app's.
  const ordered = [...users].sort((a, b) => Number(a.kind === 'desktop') - Number(b.kind === 'desktop'));
  for (const { kind, url, title } of ordered) {
    let identity: Identity;
    if (kind === 'background') {
      const app = identify({ kind: 'web-app', url, title });
      identity = { ...app, label: `${app.label} (background)` };
    } else {
      identity = identify({ kind, url, title });
    }
    if (!identities.some((i) => i.label === identity.label)) identities.push(identity);
  }
  if (identities.length === 0) return null;
  return { label: identities.map((i) => i.label).join(', '), icon: identities[0].icon };
}

function endpoint(address: string, port: number): string {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`;
}

/** A connection row's tooltip: who, to what by which names, from where. */
function connectionTitle(row: ConnectionRow): string {
  const c = row.connection;
  const lines = [
    `${row.owner.label}${c.program && c.program !== row.owner.label ? ` (${c.program}${c.pid !== null ? ` ${c.pid}` : ''})` : c.pid !== null ? ` (${c.pid})` : ''}`,
    `→ ${endpoint(c.remoteAddress, c.remotePort)} from ${endpoint(c.localAddress, c.localPort)}`,
  ];
  if (c.hostFrom === 'din' && c.remoteHost) {
    lines.push(c.otherHosts.length > 0 ? `Connected for one of: ${[c.remoteHost, ...c.otherHosts].join(', ')}` : `Connected for ${c.remoteHost}`);
  } else if (c.hostFrom === 'reverse' && c.remoteHost) {
    lines.push(`The address’s own name (reverse DNS), often its hosting company’s: ${c.remoteHost}`);
  }
  if (c.pid === null) lines.push('Another user’s program, which only root can see');
  return lines.join('\n');
}

function totalOf(c: Connection): number {
  return (c.sent ?? 0) + (c.received ?? 0);
}

function compareConnections(a: ConnectionRow, b: ConnectionRow, key: ConnectionSortKey): number {
  switch (key) {
    case 'owner':
      return NAME_COLLATOR.compare(a.owner.label, b.owner.label);
    case 'remote':
      return NAME_COLLATOR.compare(remoteLabel(a.connection), remoteLabel(b.connection));
    case 'service':
      return NAME_COLLATOR.compare(serviceOf(a.connection), serviceOf(b.connection));
    case 'down':
      return a.receiveRate - b.receiveRate;
    case 'up':
      return a.sendRate - b.sendRate;
    default:
      return totalOf(a.connection) - totalOf(b.connection);
  }
}

/**
 * Every program's open connections to other computers, with how fast each
 * is moving data: what's talking to whom, a step past what any one page
 * shows. `identify` names a process as the Processes view does.
 */
export function ConnectionsView({
  query,
  identify,
  onShowProcess,
}: {
  query: string;
  identify: (pid: number) => Identity | null;
  onShowProcess: (pid: number) => void;
}) {
  const { toast } = useToast();
  const identifySource = useSourceIdentity();
  const [state, setState] = useState<{
    available: boolean;
    at: number;
    connections: Connection[];
    rates: Map<string, { receive: number; send: number }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: ConnectionSortKey } & SortDirection>({ key: 'total', descending: true });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const bridge = getNetworkMonitorBridge();
    if (!bridge) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const result = await bridge.connections();
        if (cancelled) return;
        const at = Date.now();
        setError(null);
        setState((prev) => {
          const before = new Map((prev?.connections ?? []).map((c) => [connectionKey(c), c]));
          const seconds = prev ? (at - prev.at) / 1000 : 0;
          const rates = new Map<string, { receive: number; send: number }>();
          for (const c of result.connections) {
            const old = before.get(connectionKey(c));
            if (!old || seconds <= 0) continue;
            rates.set(connectionKey(c), {
              receive: Math.max(0, ((c.received ?? 0) - (old.received ?? 0)) / seconds),
              send: Math.max(0, ((c.sent ?? 0) - (old.sent ?? 0)) / seconds),
            });
          }
          return { available: result.available, at, connections: result.connections, rates };
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) timer = setTimeout(read, CONNECTIONS_POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const rows = useMemo(() => {
    if (!state) return [];
    const q = query.trim().toLowerCase();
    const list = state.connections.map((connection): ConnectionRow => {
      const key = connectionKey(connection);
      const rate = state.rates.get(key);
      const owner =
        usersIdentity(connection.users, identifySource) ??
        (connection.pid !== null ? identify(connection.pid) : null) ??
        (connection.program
          ? { label: connection.program, icon: Cog }
          : { label: 'System', icon: Cog });
      return { key, connection, owner, receiveRate: rate?.receive ?? 0, sendRate: rate?.send ?? 0 };
    });
    const matching = q
      ? list.filter(
          ({ connection: c, owner }) =>
            owner.label.toLowerCase().includes(q) ||
            (c.program ?? '').toLowerCase().includes(q) ||
            (c.remoteHost ?? '').toLowerCase().includes(q) ||
            c.otherHosts.some((h) => h.includes(q)) ||
            c.remoteAddress.includes(q) ||
            String(c.remotePort) === q ||
            String(c.pid ?? '') === q ||
            serviceOf(c).toLowerCase() === q,
        )
      : list;
    return matching.sort((a, b) => {
      const order = compareConnections(a, b, sort.key) || NAME_COLLATOR.compare(a.key, b.key);
      return sort.descending ? -order : order;
    });
  }, [state, query, sort, identify, identifySource]);
  const ids = useMemo(() => rows.map((row) => row.key), [rows]);
  const selectedIndex = selectedKey ? ids.indexOf(selectedKey) : -1;
  const selected = selectedIndex >= 0 ? rows[selectedIndex] : null;

  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({
    count: rows.length,
    rowHeight: ROW_HEIGHT,
    overscan: 10,
  });

  const onSort = useCallback((key: ConnectionSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, descending: !prev.descending }
        : { key, descending: key === 'down' || key === 'up' || key === 'total' },
    );
  }, []);

  const down = rows.reduce((sum, row) => sum + row.receiveRate, 0);
  const up = rows.reduce((sum, row) => sum + row.sendRate, 0);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col border-t border-border/60">
      <div role="grid" aria-label="Connections" aria-rowcount={rows.length + 1} className="flex min-h-0 flex-1 flex-col">
        <SortHeader columns={CONNECTION_COLUMNS} sort={sort} onSort={onSort} />
        <ContextMenu>
          <ContextMenuTrigger asChild disabled={!selected}>
            <div
              ref={containerRef}
              onScroll={onScroll}
              // The grid's rows hold the keyboard here, beside its header,
              // so the right-click menu's trigger has it.
              // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
              tabIndex={0}
              aria-activedescendant={selectedIndex >= 0 ? `network-connection-${selectedIndex}` : undefined}
              onKeyDown={(e) => {
                const page = Math.max(1, Math.floor((containerRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
                moveSelection(e, ids, selectedIndex, page, setSelectedKey);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setSelectedKey(null);
              }}
              className="relative min-h-0 flex-1 overflow-y-auto px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
            >
              {!state ? (
                error ? <EmptyNote>Couldn’t read the connections: {error}</EmptyNote> : <ListSkeleton />
              ) : !state.available ? (
                <EmptyNote>Connections need the ss command (iproute2), which isn’t installed.</EmptyNote>
              ) : rows.length === 0 ? (
                <EmptyNote>{query.trim() ? 'No connections match.' : 'Nothing is connected to another computer.'}</EmptyNote>
              ) : (
                <div className="relative" style={{ height: totalHeight }}>
                  {rows.slice(start, end).map((row, i) => {
                    const index = start + i;
                    const c = row.connection;
                    const isSelected = row.key === selectedKey;
                    return (
                      <div
                        key={row.key}
                        id={`network-connection-${index}`}
                        role="row"
                        aria-selected={isSelected}
                        aria-rowindex={index + 2}
                        title={connectionTitle(row)}
                        className={cn(
                          'absolute inset-x-0 flex items-center gap-3 rounded-md pl-2 pr-3 text-sm',
                          isSelected ? (focused ? 'bg-selected' : 'bg-foreground/10') : 'hover:bg-foreground/5',
                        )}
                        style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                        onMouseDown={(e) => {
                          if (e.button === 0 || e.button === 2) setSelectedKey(row.key);
                        }}
                      >
                        <div role="gridcell" className="flex w-44 shrink-0 items-center gap-2 @3xl:w-56">
                          <AppIcon icon={row.owner.icon} className={iconClass(row.owner.icon)} />
                          <span className="min-w-0 truncate">{row.owner.label}</span>
                        </div>
                        <span role="gridcell" className="min-w-0 flex-1 truncate">
                          {remoteLabel(c)}
                          {c.remoteHost && c.hostFrom === 'din' && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {c.otherHosts.length > 0 ? `or ${c.otherHosts.length} more · ` : ''}
                              {c.remoteAddress}
                            </span>
                          )}
                          {c.remoteHost && c.hostFrom === 'reverse' && (
                            <span className="ml-2 text-xs text-muted-foreground">{c.remoteHost}</span>
                          )}
                        </span>
                        <span role="gridcell" className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground @lg:block">
                          {serviceOf(c)}
                          <span className="ml-1 uppercase">{c.protocol}</span>
                        </span>
                        <span role="gridcell" className="w-20 shrink-0 text-right text-xs tabular-nums">
                          {c.received === null ? <span className="text-muted-foreground">–</span> : formatRate(row.receiveRate)}
                        </span>
                        <span role="gridcell" className="w-20 shrink-0 text-right text-xs tabular-nums">
                          {c.sent === null ? <span className="text-muted-foreground">–</span> : formatRate(row.sendRate)}
                        </span>
                        <span role="gridcell" className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground @2xl:block">
                          {c.sent === null ? '–' : formatBytes(totalOf(c))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          {selected && (
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={() =>
                  copy(endpoint(selected.connection.remoteAddress, selected.connection.remotePort), toast, 'Address')
                }
              >
                <Copy aria-hidden /> Copy Address
              </ContextMenuItem>
              {selected.connection.remoteHost && (
                <ContextMenuItem onSelect={() => copy(selected.connection.remoteHost ?? '', toast, 'Host name')}>
                  <Copy aria-hidden /> Copy Host Name
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={selected.connection.pid === null}
                onSelect={() => selected.connection.pid !== null && onShowProcess(selected.connection.pid)}
              >
                Show in Processes
              </ContextMenuItem>
            </ContextMenuContent>
          )}
        </ContextMenu>
      </div>
      <StatusBar aria-live="off" className="px-4">
        <span className="truncate">
          {state ? `${rows.length} connections · down ${formatRate(down)} · up ${formatRate(up)}` : ''}
        </span>
        <span className="ml-auto hidden shrink-0 @2xl:inline">
          A gray name is the address’s own, not the one it was reached by. Another user’s programs show as System.
        </span>
      </StatusBar>
    </div>
  );
}

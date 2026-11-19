import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, FileUp, Link, PanelLeft, PanelRight, Pause, Play, Plus, Settings2, Trash2, Turtle } from 'lucide-react';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cleanTorrentsError, isMagnetUrl, type Torrent, type TorrentSource } from '@/lib/torrents';
import { cn } from '@/lib/utils';
import type { Menu } from '@/sdk';
import { useDin, useMenuBar, useWindowFocused, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { EmptyState, PillButton, SearchField, StatusBar, ToolButton } from '@/shared/appChrome';
import { dropTargetClass, flushPane, titleSearch, toolIcon } from '@/shared/appChromeStyles';
import { droppedHandles, fileTypes, pickFiles, pickFolder, windowLaunchFile } from '@/shared/fileHandles';
import { FeatureInstallButton } from '@/shared/FeatureInstall';
import { bundledIconProps } from '@/shared/iconSizes';
import { appLink, useOnLaunch, windowLaunch, type Launch } from '@/shared/launch';
import { toast } from '@/shared/toast';
import { AddWindow } from './torrents/AddWindow';
import { useBridge, useTorrents, useTorrentsStatus } from './torrents/bridge';
import { formatRate, plural } from '@/shared/torrentFormat';
import { Inspector, type InspectorTab } from './torrents/Inspector';
import { SettingsWindow } from './torrents/SettingsWindow';
import { FILTERS, filterLabel, transferMenuItems, type Filter, type TransferAction } from './torrents/model';
import { Sidebar } from './torrents/Sidebar';
import { ListSkeleton, TransferList } from './torrents/TransferList';
import { ADD_WINDOW_SIZE, openTorrentsWindow, useTorrentsWindowMessages, type TorrentsWindow } from './torrents/windows';

const ICON = '/icons/apps/torrents.png';
const FILTER_KEY = 'torrents:filter';
const INSPECTOR_KEY = 'torrents:inspector';
const TAB_KEY = 'torrents:inspector-tab';

const isTorrentFile = (name: string) => /\.torrent$/i.test(name);

/** The window a launch asks for: Torrents itself, or one it opened (Add, Settings). */
function windowKind({ params }: Launch): TorrentsWindow | null {
  if (params.window === 'add') return { window: 'add', magnet: typeof params.magnet === 'string' ? params.magnet : undefined };
  if (params.window === 'settings') return { window: 'settings' };
  return null;
}

function TitleBar({ children }: { children?: React.ReactNode }) {
  return (
    <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 px-3">
      {children ?? <div className="flex-1" />}
      <WindowControls />
    </WindowDragRegion>
  );
}

/**
 * Torrents: Din's BitTorrent client, as if Apple had shipped Transmission.
 * Transfers by what they're doing down the side; the list, with a bar
 * each; the inspector beside it; speeds and the turtle along the foot.
 *
 * The transfers are Din's own Transmission daemon's, run by main
 * (din.system.torrents, the `torrents` permission; electron/torrents.mts),
 * so they go on with the window closed. Magnet links opened anywhere and
 * .torrent files opened in Files come here, and open the Add window.
 */
export function Torrents() {
  const bridge = useBridge();
  const { data: status, refetch } = useTorrentsStatus();
  const [kind] = useState(() => windowKind(windowLaunch()));

  if (kind?.window === 'add') {
    const file = windowLaunchFile();
    return <AddWindowFor magnet={kind.magnet} file={file} />;
  }
  if (kind?.window === 'settings') return <SettingsWindow />;

  let body: React.ReactNode;
  if (!bridge) {
    body = <p className="m-auto max-w-sm p-8 text-center text-sm text-muted-foreground">Torrents works in Din’s desktop app.</p>;
  } else if (!status) {
    body = <Skeleton className="m-auto h-24 w-72 rounded-xl" />;
  } else if (!status.available) {
    body = (
      <div className="m-auto max-w-md space-y-3 p-8 text-center">
        {status.optionalFeature ? (
          <img {...bundledIconProps(ICON)} alt="" aria-hidden className="mx-auto size-16" />
        ) : (
          <AlertTriangle className="mx-auto size-10 text-warning" aria-hidden />
        )}
        <h1 className="text-lg font-semibold">{status.optionalFeature ? 'Torrents needs Transmission' : 'Torrents can’t run here'}</h1>
        <p className="text-sm text-muted-foreground">{status.optionalFeature ? 'It downloads and shares with Transmission’s engine, which this computer doesn’t have yet.' : status.reason}</p>
        {status.optionalFeature && <FeatureInstallButton feature="torrents" onInstalled={() => void refetch()} />}
      </div>
    );
  } else {
    return <Transfers />;
  }
  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1 border-t border-border/60 bg-background">{body}</div>
    </div>
  );
}

function AddWindowFor({ magnet, file }: { magnet: string | undefined; file: FileSystemFileHandle | null }) {
  const din = useDin();
  const source = useMemo<TorrentSource | null>(() => {
    if (magnet && isMagnetUrl(magnet)) return { magnet };
    if (file) return { path: din.files.path(file) };
    return null;
  }, [magnet, file, din]);
  return <AddWindow source={source} />;
}

/** Add a magnet link: a quick question, so a dialog. Filled in from the clipboard when it holds one. */
function MagnetDialog({ onOpenChange, onAdd }: { onOpenChange: (open: boolean) => void; onAdd: (magnet: string) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    navigator.clipboard
      ?.readText()
      .then((text) => {
        if (isMagnetUrl(text)) setValue((v) => v || text.trim());
      })
      .catch(() => {});
  }, []);
  const valid = isMagnetUrl(value);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onOpenChange(false);
    onAdd(value.trim());
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add Magnet Link</DialogTitle>
            <DialogDescription>Paste a magnet link to download what it names.</DialogDescription>
          </DialogHeader>
          <Input autoFocus aria-label="Magnet link" placeholder="magnet:?xt=urn:btih:…" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={value.length > 0 && !valid} />
          {value.length > 0 && !valid && <p className="text-xs text-destructive">That isn’t a magnet link for a torrent.</p>}
          <DialogFooter>
            <PillButton onClick={() => onOpenChange(false)}>Cancel</PillButton>
            <PillButton type="submit" variant="primary" disabled={!valid}>
              Continue
            </PillButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Transfers() {
  const din = useDin();
  const bridge = useBridge()!;
  const { data: status } = useTorrentsStatus();
  const { data: torrents, isLoading } = useTorrents(true);
  const focused = useWindowFocused();
  useWindowTitle('Torrents');

  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem(FILTER_KEY) as Filter | null) ?? 'all');
  const [search, setSearch] = useState('');
  const [picked, setSelected] = useState<Set<number>>(new Set());
  const [inspector, setInspector] = useState(() => localStorage.getItem(INSPECTOR_KEY) !== 'false');
  const [tab, setTab] = useState<InspectorTab>(() => (localStorage.getItem(TAB_KEY) as InspectorTab | null) ?? 'info');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [magnetOpen, setMagnetOpen] = useState(false);
  const [removing, setRemoving] = useState<{ targets: Torrent[]; trash: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => localStorage.setItem(FILTER_KEY, filter), [filter]);
  useEffect(() => localStorage.setItem(INSPECTOR_KEY, String(inspector)), [inspector]);
  useEffect(() => localStorage.setItem(TAB_KEY, tab), [tab]);

  const all = useMemo(() => torrents ?? [], [torrents]);
  const shown = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .filter((t) => test(t) && words.every((w) => t.name.toLowerCase().includes(w)))
      .sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
  }, [all, filter, search]);
  // What's chosen and gone (removed, or filtered out of sight) isn't chosen.
  const selected = useMemo(() => new Set(shown.filter((t) => picked.has(t.id)).map((t) => t.id)), [shown, picked]);
  const chosen = useMemo(() => shown.filter((t) => selected.has(t.id)), [shown, selected]);

  const fail = useCallback((err: unknown) => toast('Torrents couldn’t do that', { body: cleanTorrentsError(err), destructive: true }), []);

  // ---- adding ----

  const addMagnet = useCallback((magnet: string) => openTorrentsWindow({ window: 'add', magnet }), []);
  const addFiles = useCallback(
    (handles: readonly FileSystemHandle[]) => {
      const files = handles.filter((h): h is FileSystemFileHandle => h.kind === 'file' && isTorrentFile(h.name));
      if (handles.length && files.length === 0) toast('That isn’t a torrent file', { body: 'Torrents opens .torrent files and magnet links.' });
      for (const file of files) {
        void din.app.launch(appLink(null, { window: 'add', floating: true, ...ADD_WINDOW_SIZE }), [file]).catch(fail);
      }
    },
    [din, fail],
  );
  const openFile = useCallback(async () => {
    const files = await pickFiles({
      title: 'Open Torrent File',
      types: fileTypes([{ description: 'Torrent files', extensions: ['.torrent'] }]),
      multiple: true,
      mode: 'read',
      startIn: 'downloads',
    });
    addFiles(files);
  }, [addFiles]);

  // How Torrents was opened: with a magnet link, or .torrent files.
  const handleLaunch = useCallback(
    (launch: Launch) => {
      if (typeof launch.params.magnet === 'string' && isMagnetUrl(launch.params.magnet)) addMagnet(launch.params.magnet);
      if (launch.files.length) addFiles(launch.files);
    },
    [addMagnet, addFiles],
  );
  const launchedOnce = useRef(false);
  useEffect(() => {
    if (launchedOnce.current) return;
    launchedOnce.current = true;
    handleLaunch(windowLaunch());
  }, [handleLaunch]);
  useOnLaunch(handleLaunch);

  // A magnet link pasted anywhere but a field.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (isMagnetUrl(text)) {
        e.preventDefault();
        addMagnet(text.trim());
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [addMagnet]);

  // What the Add window added: show it.
  useTorrentsWindowMessages(
    useCallback((message) => {
      if (message.type !== 'added') return;
      setSearch('');
      setFilter((f) => (f === 'all' || f === 'downloading' ? f : 'all'));
      setSelected(new Set([message.id]));
    }, []),
  );

  // ---- acting ----

  const chooseFolder = useCallback(async () => {
    const folder = await pickFolder({ title: 'Move Data To', startIn: 'downloads', confirmLabel: 'Move Here' });
    return folder ? din.files.path(folder) : null;
  }, [din]);

  const act = useCallback(
    (action: TransferAction, targets: Torrent[]) => {
      if (targets.length === 0) return;
      const ids = targets.map((t) => t.id);
      switch (action) {
        case 'resume':
          return void bridge.start(ids).catch(fail);
        case 'resumeNow':
          return void bridge.start(ids, true).catch(fail);
        case 'pause':
          return void bridge.stop(ids).catch(fail);
        case 'open':
          return void bridge.open(ids[0]).catch(fail);
        case 'reveal':
          return void bridge.reveal(ids[0]).catch(fail);
        case 'copyMagnet':
          return void bridge
            .detail(ids[0])
            .then((d) => navigator.clipboard.writeText(d.magnet))
            .then(() => toast('Copied the magnet link'), fail);
        case 'verify':
          return void bridge.verify(ids).catch(fail);
        case 'reannounce':
          return void bridge.reannounce(ids).catch(fail);
        case 'move':
          return void (async () => {
            const folder = await chooseFolder();
            if (folder) await bridge.setLocation(ids, folder, true);
          })().catch(fail);
        case 'remove':
          // Removing what's still downloading asks first; what's done goes at once.
          if (targets.every((t) => t.finished || t.haveBytes === 0)) return void bridge.remove(ids, { trash: false }).catch(fail);
          return setRemoving({ targets, trash: false });
        case 'trash':
          return setRemoving({ targets, trash: true });
      }
    },
    [bridge, fail, chooseFolder],
  );

  const openTransfer = (t: Torrent) => {
    if (t.finished && t.haveBytes > 0) act('open', [t]);
    else setInspector(true);
  };

  const anyRunning = all.some((t) => t.state !== 'stopped');
  const anyPaused = all.some((t) => t.state === 'stopped');
  const settings = status?.settings;
  const turtle = settings?.altSpeed.enabled ?? false;
  const setTurtle = (on: boolean) => {
    if (!settings) return;
    void bridge.setSettings({ altSpeed: { ...settings.altSpeed, enabled: on } }).catch(fail);
  };

  // ---- the menu bar ----

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { id: 'open-file', label: 'Open Torrent File…', accelerator: 'Ctrl+O' },
        { id: 'add-magnet', label: 'Add Magnet Link…', accelerator: 'Ctrl+U' },
        { type: 'separator' },
        { id: 'settings', label: 'Settings…', accelerator: 'Ctrl+,' },
      ],
    },
    {
      label: 'Transfers',
      items: [
        ...transferMenuItems(chosen),
        { type: 'separator' },
        { id: 'resume-all', label: 'Resume All', enabled: anyPaused, accelerator: 'Ctrl+Alt+R' },
        { id: 'pause-all', label: 'Pause All', enabled: anyRunning, accelerator: 'Ctrl+Alt+P' },
        { type: 'separator' },
        { id: 'select-all', label: 'Select All', accelerator: 'Ctrl+A', notInFields: true, enabled: shown.length > 0 },
      ],
    },
    {
      label: 'View',
      items: [
        ...FILTERS.map((f, i) => ({ id: `filter:${f.id}`, label: f.label, type: 'radio' as const, group: 'filter', checked: filter === f.id, accelerator: `Ctrl+${i + 1}` })),
        { type: 'separator' },
        { id: 'inspector', label: 'Inspector', type: 'checkbox', checked: inspector, accelerator: 'Ctrl+I' },
        { id: 'find', label: 'Find', accelerator: 'Ctrl+F' },
        { type: 'separator' },
        { id: 'turtle', label: 'Turtle Speed', type: 'checkbox', checked: turtle, enabled: !!settings, accelerator: 'Ctrl+Shift+T' },
      ],
    },
  ];
  useMenuBar(menus, (id) => {
    if (id === 'open-file') void openFile();
    else if (id === 'add-magnet') setMagnetOpen(true);
    else if (id === 'settings') openTorrentsWindow({ window: 'settings' });
    else if (id.startsWith('transfer:')) act(id.slice('transfer:'.length) as TransferAction, chosen);
    else if (id === 'resume-all') void bridge.start(all.map((t) => t.id)).catch(fail);
    else if (id === 'pause-all') void bridge.stop(all.map((t) => t.id)).catch(fail);
    else if (id === 'select-all') setSelected(new Set(shown.map((t) => t.id)));
    else if (id.startsWith('filter:')) setFilter(id.slice('filter:'.length) as Filter);
    else if (id === 'inspector') setInspector((v) => !v);
    else if (id === 'find') searchRef.current?.focus();
    else if (id === 'turtle') setTurtle(!turtle);
  });

  // ---- dropping .torrent files ----

  const onDragOver = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(await droppedHandles(e.nativeEvent));
  };

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton label="Add a torrent">
          <Plus {...toolIcon} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onSelect={() => void openFile()}>
          <FileUp className="size-4.5" aria-hidden />
          Open Torrent File…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setMagnetOpen(true)}>
          <Link className="size-4.5" aria-hidden />
          Add Magnet Link…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openTorrentsWindow({ window: 'settings' })}>
          <Settings2 className="size-4.5" aria-hidden />
          Settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const one = chosen.length === 1 ? chosen[0] : null;
  const label = filterLabel(filter);
  const downloading = all.filter((t) => t.state === 'downloading' && !t.waiting).length;
  const seeding = all.filter((t) => t.state === 'seeding' && !t.waiting).length;

  return (
    <div className="@container/torrents relative flex h-full w-full text-foreground">
      {/* The strip above the inset content still drags the window. */}
      <WindowDragRegion className="absolute inset-x-0 top-0 h-2" />
      <Sidebar
        torrents={all}
        filter={filter}
        onFilter={(f) => {
          setFilter(f);
          setSidebarOpen(false);
        }}
        actions={addMenu}
        className={cn(
          sidebarOpen ? 'absolute inset-y-0 left-0 z-30 flex bg-background shadow-xl' : 'hidden',
          '@3xl/torrents:static @3xl/torrents:flex @3xl/torrents:bg-transparent @3xl/torrents:shadow-none',
        )}
      />
      {sidebarOpen && (
        <button type="button" aria-label="Close the sidebar" className="absolute inset-0 z-20 bg-background/40 @3xl/torrents:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <WindowDragRegion className="flex h-12 shrink-0 items-center gap-1 pr-3 pl-3">
          <ToolButton label="Show the sidebar" className="@3xl/torrents:hidden" onClick={() => setSidebarOpen(true)}>
            <PanelLeft {...toolIcon} />
          </ToolButton>
          <SearchField
            ref={searchRef}
            aria-label={`Search ${label}`}
            placeholder={`Search ${label}`}
            value={search}
            onValueChange={setSearch}
            className={cn(titleSearch, 'mr-1')}
          />
          {/* With the sidebar hidden, Add is here. */}
          <div className="flex @3xl/torrents:hidden">{addMenu}</div>
          <ToolButton label={chosen.length > 1 ? `Resume ${chosen.length} Transfers` : 'Resume'} disabled={!chosen.some((t) => t.state === 'stopped')} onClick={() => act('resume', chosen)}>
            <Play {...toolIcon} />
          </ToolButton>
          <ToolButton label={chosen.length > 1 ? `Pause ${chosen.length} Transfers` : 'Pause'} disabled={!chosen.some((t) => t.state !== 'stopped')} onClick={() => act('pause', chosen)}>
            <Pause {...toolIcon} />
          </ToolButton>
          <ToolButton label="Remove" disabled={chosen.length === 0} onClick={() => act('remove', chosen)}>
            <Trash2 {...toolIcon} />
          </ToolButton>
          <ToolButton label={inspector ? 'Hide the inspector' : 'Show the inspector'} pressed={inspector} onClick={() => setInspector((v) => !v)}>
            <PanelRight {...toolIcon} />
          </ToolButton>
          <div className="min-w-2 flex-1" />
          <WindowControls />
        </WindowDragRegion>

        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 overflow-hidden border-t border-border/60 bg-background',
            '@3xl/torrents:mr-2 @3xl/torrents:mb-2 @3xl/torrents:rounded-2xl @3xl/torrents:border-t-0 @3xl/torrents:clay',
            flushPane,
          )}
        >
          <section
            aria-label={label}
            className={cn('relative flex min-w-0 flex-1 flex-col transition-colors', dragging && dropTargetClass)}
            onDragOver={onDragOver}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => void onDrop(e)}
          >
            <div className="min-h-0 flex-1 overflow-y-auto" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
              {isLoading ? (
                <ListSkeleton />
              ) : all.length === 0 ? (
                <Welcome onOpenFile={() => void openFile()} onAddMagnet={() => setMagnetOpen(true)} />
              ) : shown.length === 0 ? (
                <EmptyState title={search ? 'No transfers match' : `Nothing in ${label}`}>{search ? `None of ${label} is named “${search.trim()}”.` : undefined}</EmptyState>
              ) : (
                <TransferList
                  torrents={shown}
                  selected={selected}
                  inactive={!focused}
                  onSelectionChange={setSelected}
                  onOpen={openTransfer}
                  onAction={act}
                  label={label}
                />
              )}
            </div>
            <StatusBar className="h-9 gap-2 pl-1.5">
              <ToolButton size="sm" label={turtle ? 'Turtle speed is on: turn it off' : 'Turtle speed: slow down to the limits in Settings'} pressed={turtle} onClick={() => setTurtle(!turtle)} disabled={!settings}>
                <Turtle className={cn('size-4.5', turtle && 'text-ink-accent')} strokeWidth={1.75} />
              </ToolButton>
              <span className="min-w-0 flex-1 truncate">
                {all.length === 0
                  ? 'No transfers'
                  : [plural(all.length, 'transfer'), downloading && `${downloading} downloading`, seeding && `${seeding} seeding`].filter(Boolean).join(' · ')}
              </span>
              <span className="flex shrink-0 items-center gap-3 pr-1.5 tabular-nums">
                <span className="inline-flex items-center gap-1" title="Downloading, all together">
                  <ArrowDown className="size-3.5" aria-label="Download speed" />
                  {formatRate(status?.rateDown ?? 0)}
                </span>
                <span className="inline-flex items-center gap-1" title="Uploading, all together">
                  <ArrowUp className="size-3.5" aria-label="Upload speed" />
                  {formatRate(status?.rateUp ?? 0)}
                </span>
              </span>
            </StatusBar>
          </section>

          {inspector && all.length > 0 && (
            <div className="relative hidden w-80 shrink-0 @2xl/torrents:flex before:absolute before:inset-y-3 before:left-0 before:w-px before:bg-border/70">
              <Inspector
                torrent={one}
                count={chosen.length}
                tab={tab}
                onTab={setTab}
                onClose={() => setInspector(false)}
                onReveal={(t, file) => void bridge.reveal(t.id, file).catch(fail)}
                onMove={(t) => act('move', [t])}
              />
            </div>
          )}
        </div>
      </div>

      {magnetOpen && <MagnetDialog onOpenChange={setMagnetOpen} onAdd={addMagnet} />}
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing?.targets.length === 1 ? `Remove “${removing.targets[0].name}”?` : `Remove ${removing?.targets.length ?? 0} transfers?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.trash
                ? 'What they downloaded goes to the Trash, and they stop sharing it.'
                : 'They stop downloading. What they’ve downloaded stays where it is, and adding them again picks up from there.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={removing?.trash ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
              onClick={() => removing && void bridge.remove(removing.targets.map((t) => t.id), { trash: removing.trash }).catch(fail)}
            >
              {removing?.trash ? 'Move to Trash' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** No transfers yet: what Torrents does, and the two ways in. */
function Welcome({ onOpenFile, onAddMagnet }: { onOpenFile: () => void; onAddMagnet: () => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-8 py-12 text-center">
      <img {...bundledIconProps(ICON)} alt="" aria-hidden draggable={false} className="size-20 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95" />
      <h2 className="mt-4 font-[family-name:var(--font-title)] text-2xl font-semibold tracking-tight">No transfers yet</h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Click a magnet link anywhere, open a torrent file, or drop one here. Downloads go on with the window closed.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <PillButton variant="primary" onClick={onOpenFile}>
          <FileUp aria-hidden />
          Open Torrent File…
        </PillButton>
        <PillButton onClick={onAddMagnet}>
          <Link aria-hidden />
          Add Magnet Link…
        </PillButton>
      </div>
    </div>
  );
}

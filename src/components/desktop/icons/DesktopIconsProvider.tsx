import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DesktopIconsContext, type DesktopIcon, type DesktopIconsContextValue } from '@/contexts/DesktopIconsContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useWidgets } from '@/contexts/WidgetsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { openDropped } from '@/lib/dockDrop';
import {
  cellRect,
  iconGrid,
  isDesktopEntryName,
  layoutIcons,
  nearestFree,
  parseDesktopEntry,
  rectsOverlap,
  shortcutEntry,
  shortcutFileName,
  sortIcons,
  uniqueName,
  xdgDesktopDir,
  type DesktopEntry,
  type IconPlace,
  type PlacedIcon,
  type Rect,
} from '@/lib/desktopIcons';
import { cleanFsError, getFsBridge, isHiddenEntry, isValidEntryName, joinPath } from '@/lib/fs';
import type { WorkArea } from '@/lib/monitors';
import { openPath } from '@/lib/openPath';
import { areaGrid, cellsRect, placedCells } from '@/lib/widgetGrid';
import { toastWithFeature } from '@/lib/featureNotifications';
import { featureForFile } from '@/lib/features';

type Places = Record<string, IconPlace>;

function parsePlaces(value: unknown): Places {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const places: Places = {};
  for (const [name, place] of Object.entries(value as Record<string, unknown>)) {
    const p = place as Partial<IconPlace> | null;
    if (p && typeof p.monitor === 'string' && Number.isInteger(p.col) && Number.isInteger(p.row)) {
      places[name] = { monitor: p.monitor, col: p.col as number, row: p.row as number };
    }
  }
  return places;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const EMPTY = new Set<string>();

/**
 * What's in ~/Desktop, read and followed as it changes, with where each icon
 * sits (kept on this computer, by name, like the widgets' layout).
 */
export function DesktopIconsProvider({ children }: { children: ReactNode }) {
  const { config } = useAppContext();
  const areas = useWorkAreas();
  const { widgets } = useWidgets();
  const { open: openApp } = useWindowActions();
  const { getApp } = useInstalledApps();
  const openUrl = useOpenUrl();
  const { toast } = useToast();
  const fs = getFsBridge();

  const [dir, setDir] = useState<string | null>(null);
  const [icons, setIcons] = useState<DesktopIcon[]>([]);
  const [stored, setStored] = useLocalStorage<unknown>('din:desktop-icons', {});
  const places0 = useMemo(() => parsePlaces(stored), [stored]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Bumped once the folder exists, to watch it.
  const [watchKey, setWatchKey] = useState(0);

  useEffect(() => {
    if (!fs) return;
    let alive = true;
    void (async () => {
      const home = await fs.homedir();
      const userDirs = await fs.readFile(joinPath(home, '.config/user-dirs.dirs'), 16 * 1024)
        .then((r) => new TextDecoder().decode(r.data), () => '');
      if (alive) setDir(xdgDesktopDir(userDirs, home) ?? joinPath(home, 'Desktop'));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [fs]);

  // Launchers are read for their names and apps; kept by mtime so a change
  // elsewhere in the folder doesn't read them all again.
  const entries = useRef(new Map<string, { mtimeMs: number | null; entry: DesktopEntry }>());
  const readIcons = useCallback(async (): Promise<DesktopIcon[]> => {
    if (!fs || !dir) return [];
    const listing = await fs.readdir(dir).catch(() => null);
    if (!listing) return [];
    const next: DesktopIcon[] = [];
    for (const e of listing.entries) {
      if (isHiddenEntry(e)) continue;
      const path = joinPath(dir, e.name);
      let entry: DesktopEntry | undefined;
      if (e.kind === 'file' && isDesktopEntryName(e.name)) {
        const cached = entries.current.get(e.name);
        entry = cached && cached.mtimeMs === e.mtimeMs
          ? cached.entry
          : await fs.readFile(path, 64 * 1024).then((r) => parseDesktopEntry(new TextDecoder().decode(r.data)), () => undefined);
        if (entry) entries.current.set(e.name, { mtimeMs: e.mtimeMs, entry });
        if (entry?.hidden) continue;
      }
      next.push({ ...e, path, label: entry?.name ?? e.name, entry });
    }
    return next;
  }, [fs, dir]);
  const reload = useCallback(async () => {
    setIcons(await readIcons());
  }, [readIcons]);

  useEffect(() => {
    if (!fs || !dir) return;
    void readIcons().then(setIcons);
    let id: number | null = null;
    let alive = true;
    void fs.watch(dir).then((watchId) => {
      if (alive) id = watchId;
      else if (watchId !== null) void fs.unwatch(watchId);
    }, () => {});
    const off = fs.onChange((changed) => {
      if (changed === dir) void readIcons().then(setIcons);
    });
    return () => {
      alive = false;
      off();
      if (id !== null) void fs.unwatch(id);
    };
  }, [fs, dir, readIcons, watchKey]);

  /** The folder, made if it isn't there yet (and watched once it is). */
  const ensureDir = useCallback(async (): Promise<string> => {
    if (!fs || !dir) throw new Error('There’s no desktop folder here');
    const exists = await fs.stat(dir).then((s) => s.kind === 'directory', () => false);
    if (!exists) {
      await fs.mkdir(dir);
      setWatchKey((k) => k + 1);
    }
    return dir;
  }, [fs, dir]);

  // The Dock overlays the primary monitor's foot; icons stay above it.
  const dockInset = config.desktopLayout === 'dock' ? config.dockSize + 16 : 0;
  const size = config.desktopIconSize;
  const gridFor = useCallback(
    (area: WorkArea) => iconGrid(area, size, area.primary ? dockInset : 0),
    [size, dockInset],
  );
  const widgetRects = useMemo(() => {
    const rects = new Map<string, Rect[]>();
    for (const w of widgets) {
      const placed = placedCells(areas, w);
      if (!placed) continue;
      const list = rects.get(placed.area.id) ?? [];
      list.push(cellsRect(areaGrid(placed.area), placed.cells));
      rects.set(placed.area.id, list);
    }
    return rects;
  }, [widgets, areas]);
  const blocked = useCallback(
    (area: WorkArea, rect: Rect) => (widgetRects.get(area.id) ?? []).some((w) => rectsOverlap(w, rect)),
    [widgetRects],
  );

  const names = useMemo(() => icons.map((i) => i.name), [icons]);
  const layout = useMemo(
    () => layoutIcons(names, places0, areas, gridFor, blocked),
    [names, places0, areas, gridFor, blocked],
  );

  // New icons keep the cell they were first given, so others coming and
  // going don't shuffle them.
  useEffect(() => {
    const fresh = names.filter((n) => !places0[n]);
    if (fresh.length === 0) return;
    setStored((prev: unknown) => {
      const next = parsePlaces(prev);
      for (const name of fresh) {
        const p = layout.places.get(name);
        if (p && !next[name]) next[name] = { monitor: p.area.id, col: p.col, row: p.row };
      }
      return next;
    });
  }, [names, places0, layout, setStored]);

  const taken = useCallback((area: WorkArea, col: number, row: number, except: ReadonlySet<string> = EMPTY) => {
    for (const [name, p] of layout.places) {
      if (!except.has(name) && p.area.id === area.id && p.col === col && p.row === row) return true;
    }
    return blocked(area, cellRect(gridFor(area), col, row));
  }, [layout, blocked, gridFor]);

  const resolve = useCallback<DesktopIconsContextValue['resolve']>((moves) => {
    const primary = areas.find((a) => a.primary) ?? areas[0];
    if (!primary) return [];
    const moving = new Set(moves.map((m) => m.name));
    const claimed = new Set<string>();
    const resolved: (PlacedIcon & { name: string })[] = [];
    for (const m of moves) {
      const area = areas.find((a) => a.id === m.monitor) ?? primary;
      const g = gridFor(area);
      const isTaken = (c: number, r: number) => claimed.has(`${area.id}\0${c}\0${r}`) || taken(area, c, r, moving);
      const col = Math.max(0, Math.min(g.cols - 1, m.col));
      const row = Math.max(0, Math.min(g.rows - 1, m.row));
      const cell = isTaken(col, row) ? nearestFree(g, col, row, isTaken) : { col, row };
      if (!cell) continue;
      claimed.add(`${area.id}\0${cell.col}\0${cell.row}`);
      resolved.push({ name: m.name, area, ...cell, rect: cellRect(g, cell.col, cell.row) });
    }
    return resolved;
  }, [areas, gridFor, taken]);

  const place = useCallback<DesktopIconsContextValue['place']>((moves) => {
    const updates: Places = {};
    for (const p of resolve(moves)) updates[p.name] = { monitor: p.area.id, col: p.col, row: p.row };
    setStored((prev: unknown) => ({ ...parsePlaces(prev), ...updates }));
  }, [resolve, setStored]);

  const arrange = useCallback<DesktopIconsContextValue['arrange']>((by) => {
    const areaOrder = (id: string | undefined) => {
      const i = areas.findIndex((a) => a.id === id);
      return areas[i]?.primary ? -1 : i;
    };
    const sorted = by
      ? sortIcons(icons, by).map((i) => i.name)
      : [...layout.places].sort(([, a], [, b]) => areaOrder(a.area.id) - areaOrder(b.area.id) || a.col - b.col || a.row - b.row).map(([name]) => name);
    const fresh = layoutIcons(sorted, {}, areas, gridFor, blocked);
    setStored((prev: unknown) => {
      const next = parsePlaces(prev);
      for (const [name, p] of fresh.places) next[name] = { monitor: p.area.id, col: p.col, row: p.row };
      return next;
    });
  }, [icons, layout, areas, gridFor, blocked, setStored]);

  /** `feature`: the optional feature what failed needs, whose Install button goes on the toast. */
  const fail = useCallback((title: string, error: unknown, feature: string | null = null) => {
    void toastWithFeature(toast, { title, description: cleanFsError(error), variant: 'destructive' }, feature);
  }, [toast]);

  const byName = useCallback((name: string) => icons.find((i) => i.name === name), [icons]);

  const open = useCallback<DesktopIconsContextValue['open']>(async (list) => {
    for (const name of list) {
      const icon = byName(name);
      if (!icon) continue;
      await openPath(icon.path, icon.kind, { open: openApp, openUrl, getApp }).catch((error: unknown) => fail(`Couldn’t open ${icon.label}`, error, featureForFile(icon.path)));
    }
  }, [byName, openApp, openUrl, getApp, fail]);

  const openWith = useCallback<DesktopIconsContextValue['openWith']>((appId, list) => {
    const items = list.flatMap((name) => {
      const icon = byName(name);
      return icon ? [{ path: icon.path, folder: icon.kind === 'directory' }] : [];
    });
    if (items.length > 0) openDropped(openApp, appId, items);
  }, [byName, openApp]);

  const showInFiles = useCallback<DesktopIconsContextValue['showInFiles']>((list) => {
    const paths = (list ?? []).flatMap((name) => byName(name)?.path ?? []);
    if (paths.length === 0) {
      if (dir) void ensureDir().then((d) => openApp('file-browser', { path: d }), (error: unknown) => fail('Couldn’t open the desktop folder', error));
      return;
    }
    openDropped(openApp, 'file-browser', paths.map((path) => ({ path, folder: false })));
  }, [byName, dir, ensureDir, openApp, fail]);

  /** Put a name that's about to appear in a cell, if one's given. */
  const reserve = useCallback((name: string, at?: { monitor: string; col: number; row: number }) => {
    if (at) place([{ name, ...at }]);
  }, [place]);

  const takenNames = useCallback(async (d: string) => {
    const listing = await fs?.readdir(d).catch(() => null);
    return new Set(listing?.entries.map((e) => e.name) ?? names);
  }, [fs, names]);

  const newFolder = useCallback(async () => {
    if (!fs) throw new Error('There’s no filesystem here');
    const d = await ensureDir();
    const name = uniqueName(await takenNames(d), 'New Folder');
    await fs.mkdir(joinPath(d, name));
    await reload();
    setSelected(new Set([name]));
    setRenaming(name);
    return name;
  }, [fs, ensureDir, takenNames, reload]);

  const newTextFile = useCallback(async () => {
    if (!fs) throw new Error('There’s no filesystem here');
    const d = await ensureDir();
    const name = uniqueName(await takenNames(d), 'New Document', '.txt');
    await fs.writeFile(joinPath(d, name), '');
    await reload();
    setSelected(new Set([name]));
    setRenaming(name);
    return name;
  }, [fs, ensureDir, takenNames, reload]);

  const rename = useCallback<DesktopIconsContextValue['rename']>(async (name, to) => {
    if (!fs || !dir) throw new Error('There’s no filesystem here');
    const target = to.trim();
    if (target === name) return;
    if (!isValidEntryName(target)) throw new Error(`“${target}” can’t be a file’s name`);
    if (byName(target)) throw new Error(`There’s already something called “${target}” on the desktop`);
    await fs.move(joinPath(dir, name), joinPath(dir, target));
    setStored((prev: unknown) => {
      const next = parsePlaces(prev);
      if (next[name]) next[target] = next[name];
      delete next[name];
      return next;
    });
    setSelected(new Set([target]));
    await reload();
  }, [fs, dir, byName, setStored, reload]);

  const trash = useCallback<DesktopIconsContextValue['trash']>(async (list) => {
    if (!fs) throw new Error('There’s no filesystem here');
    for (const name of list) {
      const icon = byName(name);
      if (icon) await fs.trash(icon.path);
    }
    setStored((prev: unknown) => {
      const next = parsePlaces(prev);
      for (const name of list) delete next[name];
      return next;
    });
    setSelected(EMPTY);
    await reload();
  }, [fs, byName, setStored, reload]);

  const addApp = useCallback<DesktopIconsContextValue['addApp']>(async (appId, at) => {
    if (!fs) throw new Error('There’s no filesystem here');
    const app = getApp(appId);
    if (!app) throw new Error(`No app ${appId}`);
    const d = await ensureDir();
    const file = shortcutFileName(app.name);
    const name = uniqueName(await takenNames(d), file.slice(0, -'.desktop'.length), '.desktop');
    reserve(name, at);
    await fs.writeFile(joinPath(d, name), shortcutEntry(app));
    await reload();
    return name;
  }, [fs, getApp, ensureDir, takenNames, reserve, reload]);

  const addPaths = useCallback<DesktopIconsContextValue['addPaths']>(async (paths, options = {}) => {
    if (!fs) throw new Error('There’s no filesystem here');
    const d = await ensureDir();
    const added: string[] = [];
    let at = options.at;
    for (const path of paths) {
      let name = basename(path);
      if (path !== joinPath(d, name)) {
        const to = options.move ? await fs.moveInto(path, d) : await fs.copyInto(path, d);
        name = basename(to);
      }
      added.push(name);
      if (at) {
        reserve(name, at);
        at = { ...at, row: at.row + 1 };
      }
    }
    await reload();
    return added;
  }, [fs, ensureDir, reserve, reload]);

  // A selection or rename of something that's gone goes with it.
  const present = useMemo(() => new Set(names), [names]);
  const liveSelected = useMemo(
    () => ([...selected].every((n) => present.has(n)) ? selected : new Set([...selected].filter((n) => present.has(n)))),
    [selected, present],
  );
  const liveRenaming = renaming && present.has(renaming) ? renaming : null;

  const shown = config.desktopIcons && !!fs;
  const value = useMemo<DesktopIconsContextValue>(() => ({
    shown,
    dir,
    icons,
    places: layout.places,
    grid: gridFor,
    taken,
    selected: liveSelected,
    setSelected,
    renaming: liveRenaming,
    setRenaming,
    open,
    openWith,
    showInFiles,
    resolve,
    place,
    arrange,
    newFolder,
    newTextFile,
    rename,
    trash,
    addApp,
    addPaths,
    reload,
  }), [shown, dir, icons, layout, gridFor, taken, liveSelected, liveRenaming, open, openWith, showInFiles, resolve, place, arrange, newFolder, newTextFile, rename, trash, addApp, addPaths, reload]);

  return <DesktopIconsContext.Provider value={value}>{children}</DesktopIconsContext.Provider>;
}

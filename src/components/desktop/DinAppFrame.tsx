import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Hourglass, RotateCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/desktop/AppIcon';
import { DataMenuBar, PointMenu } from '@/components/desktop/dinHost/DataMenus';
import { onThemeChange, themeSnapshot } from '@/components/desktop/dinHost/theme';
import { sanitizeImageUrl } from '@/components/desktop/dinHost/urls';
import { WindowMenuItems } from '@/components/desktop/WindowContextMenu';
import { useQueryClient } from '@tanstack/react-query';
import { useWindowFrame, useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowChrome } from '@/contexts/WindowChromeContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { useWindowVisible } from '@/contexts/WindowVisibleContext';
import { WindowTitleContext } from '@/contexts/WindowTitleContext';
import { WindowIconContext } from '@/contexts/WindowIconContext';
import { WindowAccentContext } from '@/contexts/WindowAccentContext';
import { FilePickerContext } from '@/contexts/FilePickerContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import { setCloseGuard } from '@/lib/closeGuards';
import { appForFile } from '@/lib/fileTypes';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { getFsBridge } from '@/lib/fs';
import { notify } from '@/lib/notificationCenter';
import { printFile, printHtml } from '@/lib/printing';
import { areaFor } from '@/lib/monitors';
import { isDarkThemeColor } from '@/lib/themeColor';
import { getFileClipboard, setFileClipboard, subscribeFileClipboard } from '@/lib/fileClipboard';
import { registerMediaSource, type MediaSource } from '@/lib/nowPlaying';
import {
  cancelDictation,
  finishDictation,
  focusedDictationTarget,
  getDictationState,
  hasDictationBridge,
  startDictation,
  subscribeDictation,
} from '@/lib/dictation';
import { DesktopBackgroundContext } from '@/contexts/DesktopBackgroundContext';
import { InstalledAppsContext } from '@/contexts/InstalledAppsContext';
import { getNativeAppsBridge, isWindowsProgram } from '@/lib/nativeApps';
import { getAssistantBridge } from '@/lib/assistant';
import { getPrintingBridge } from '@/lib/printing';
import {
  appUrl,
  DIN_APPS_PARTITION,
  SYSTEM_PERMISSIONS,
  forgetMigratedStorage,
  getAppsBridge,
  manifestIcon,
  manifestPermissions,
  onAppPort,
  storageToMigrate,
} from '@/lib/dinApps';
import { acceptDrag, dragInfo, finishDrag, registerDrag, setDragPoint, subscribeDrag, currentDrag } from '@/lib/dinDrag';
import { guestsAvailable } from '@/platform/guest';
import { GuestSurface, type GuestSurfaceHandle } from '@/platform/GuestSurface';
import type { AppComponentProps } from '@/lib/apps';
import type { DinManifest, FrameStyle, MediaSession, MenuItem, Menu, Permission, Rect, WindowChrome, WindowState } from '@/sdk/din';
import type { AccountSnapshot, FromApp, HandleData, Hello, Method, Push, Requests } from '@/sdk/protocol';
import type { WindowState as DesktopWindow } from '@/hooks/useWindows';

/** How long an app may take to answer a close request before it's offered for force quitting. */
const CLOSE_ANSWER_MS = 5000;

interface Props extends AppComponentProps {
  appId: string;
  manifest: DinManifest;
}

/** A file an app was granted, by the id its port knows it as. */
interface Grant {
  path: string;
  kind: 'file' | 'directory';
  writable: boolean;
}

/** A launch param naming files (Files' `{ path }`, Media Player's `{ paths }`), as paths. */
function launchPaths(params: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  if (typeof params?.path === 'string') out.push(params.path);
  if (Array.isArray(params?.paths)) out.push(...params.paths.filter((p): p is string => typeof p === 'string'));
  return out;
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function dirname(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** A stable, opaque key for a path, per app. */
function keyOf(appId: string, path: string): string {
  let h = 5381;
  for (const c of `${appId}\u0000${path}`) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36) + path.length.toString(36);
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', txt: 'text/plain', md: 'text/markdown',
  html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', pdf: 'application/pdf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
};

function mimeOf(name: string): string {
  return MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

const PERSIST_KEY = 'din:app-file-tokens';

/** `startIn`'s named folders, under home. */
const NAMED_FOLDERS: Record<string, string> = {
  documents: 'Documents',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
  downloads: 'Downloads',
};

function persisted(): Record<string, { appId: string; path: string; kind: 'file' | 'directory'; writable: boolean }> {
  try {
    return JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * The window body of a built-in app: its din:// page in a guest of its own
 * (an iframe outside Electron), and the desktop's end of its port. Every
 * window.din call lands here and is answered with the window's own powers
 * (docs/din/README.md, docs/security-model.md).
 */
export function DinAppFrame({ appId, manifest, windowId, params }: Props) {
  const frame = useWindowFrame();
  const chrome = useWindowChrome();
  const actions = useWindowActions();
  const isTop = useWindowIsTop();
  const visible = useWindowVisible();
  const publishTitle = useContext(WindowTitleContext);
  const publishIcon = useContext(WindowIconContext);
  const publishAccent = useContext(WindowAccentContext);
  const picker = useContext(FilePickerContext);
  const background = useContext(DesktopBackgroundContext);
  const installed = useContext(InstalledAppsContext);
  const areas = useWorkAreas();
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const zoom = config.zoomLevel / 100;
  const permissions = manifestPermissions(manifest);
  const appName = manifest.short_name ?? manifest.name;

  const surface = useRef<GuestSurfaceHandle>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [guestId, setGuestId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState(false);
  const [hung, setHung] = useState(false);
  const [menus, setMenus] = useState<Menu[] | null>(null);
  const [popup, setPopup] = useState<{ at: { x: number; y: number }; items?: MenuItem[]; resolve?: (id: string | null) => void; windowMenu?: boolean } | null>(null);
  const [frameMode, setFrameMode] = useState<WindowChrome['frame']>(manifest.din.window?.frame ?? 'standard');
  const [moving, setMoving] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = document.fullscreenElement;
      setFullscreen(el !== null && container.current?.contains(el) === true);
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useOwnWindowHeader(frameMode === 'custom');

  /** The port of the document now loaded, and what it holds. */
  const session = useRef<{
    port: MessagePort;
    grants: Map<string, Grant>;
    nextHandle: number;
    nextRequest: number;
    closeRequests: Map<number, ReturnType<typeof setTimeout>>;
    watches: Map<string, { dir: string; id: number | null }>;
  } | null>(null);

  /** What the app is playing, among the desktop's media sources (registered below). */
  const media = useRef<{ session: MediaSession | null; since: number; notify: () => void }>({
    session: null,
    since: 0,
    notify: () => {},
  });

  // ---- what the app sees of its window ----
  const win = frame?.win;
  const windowState = useCallback((w: DesktopWindow | undefined): WindowState => {
    const bounds: Rect = w ? { x: w.x, y: w.y, width: w.width, height: w.height } : { x: 0, y: 0, width: 0, height: 0 };
    const area = areas.length > 0 ? areaFor(areas, bounds) : null;
    return {
      id: windowId,
      focused: isTop,
      visible,
      minimized: w?.minimized ?? false,
      maximized: w?.maximized ?? false,
      snapped: w?.snapped ?? null,
      fullscreen,
      bounds,
      workArea: area ? { x: area.x, y: area.y, width: area.width, height: area.height } : bounds,
    };
  }, [areas, isTop, visible, windowId, fullscreen]);
  const frameStyle = (accent: string | null): FrameStyle => ({ accent, dark: accent !== null && isDarkThemeColor(accent) });
  const account = (): AccountSnapshot =>
    permissions.includes('account')
      ? {
          pubkey: user?.pubkey ?? null,
          relays: config.relayMetadata.relays.map((r) => ({ url: r.url, read: r.read, write: r.write })),
          blossom: getEffectiveBlossomServers(config.blossomServerMetadata, config.useAppBlossomServers),
        }
      : { pubkey: null, relays: [], blossom: [] };

  // Everything a request handler reads, current as of the last render.
  const live = useRef({ win, actions, chrome, frame, user, config, zoom, picker, windowState, publishTitle, publishIcon, publishAccent, account });
  useLayoutEffect(() => {
    live.current = { win, actions, chrome, frame, user, config, zoom, picker, windowState, publishTitle, publishIcon, publishAccent, account };
  });

  const push = useCallback((message: Push) => session.current?.port.postMessage(message), []);

  /** Grant the app a file it was handed, as a handle for its port. */
  const grantFile = useCallback((path: string, kind: 'file' | 'directory', writable: boolean): HandleData | null => {
    const s = session.current;
    if (!s) return null;
    const id = `h${s.nextHandle++}`;
    s.grants.set(id, { path, kind, writable });
    return { id, kind, name: basename(path), key: keyOf(appId, path), path: permissions.includes('fs') ? path : null, writable };
  }, [appId, permissions]);

  const grantPaths = useCallback(async (paths: string[], writable = true): Promise<HandleData[]> => {
    const fs = getFsBridge();
    const out: HandleData[] = [];
    for (const path of paths) {
      let kind: 'file' | 'directory' = 'file';
      try {
        if (fs) kind = (await fs.stat(path)).kind === 'directory' ? 'directory' : 'file';
      } catch {
        continue; // Gone already.
      }
      const handle = grantFile(path, kind, writable);
      if (handle) out.push(handle);
    }
    return out;
  }, [grantFile]);

  const launchOf = useCallback(async (p: Record<string, unknown> | undefined, reason: 'new' | 'relaunch'): Promise<Hello['launch']> => {
    const { path: _path, paths: _paths, actionAt: _actionAt, shortcut, ...rest } = (p ?? {}) as Record<string, unknown>;
    return {
      reason,
      params: rest,
      files: await grantPaths(launchPaths(p)),
      shortcut: typeof shortcut === 'string' ? shortcut : null,
    };
  }, [grantPaths]);

  // ---- requests ----
  const handlers = useRef<{ [M in Method]?: (params: Requests[M][0]) => Promise<Requests[M][1]> | Requests[M][1] }>({});
  const need = (permission: Permission) => {
    if (!permissions.includes(permission)) {
      const error = new Error(`${appName} doesn't have the ${permission} permission`);
      error.name = 'DinPermissionError';
      throw error;
    }
  };
  const grantOf = (id: string): Grant => {
    const g = session.current?.grants.get(id);
    if (!g) {
      const error = new Error('No such file handle');
      error.name = 'NotFoundError';
      throw error;
    }
    return g;
  };
  /** Where the picker starts: in a folder handle, beside a file's, or a named folder of home. */
  const startFolder = async (handle: string | undefined, named: string | undefined): Promise<string | undefined> => {
    const g = handle ? session.current?.grants.get(handle) : undefined;
    if (g) return g.kind === 'directory' ? g.path : dirname(g.path);
    const folder = named ? NAMED_FOLDERS[named] : undefined;
    const fs = getFsBridge();
    if (!folder || !fs) return undefined;
    return `${(await fs.homedir()).replace(/\/$/, '')}/${folder}`;
  };
  const guestRect = () =>
    (guestsAvailable() ? surface.current?.element() : iframe.current)?.getBoundingClientRect() ?? container.current?.getBoundingClientRect();
  const toDesktop = (at: { x: number; y: number }) => {
    const r = guestRect();
    return { clientX: (r?.left ?? 0) + at.x, clientY: (r?.top ?? 0) + at.y };
  };
  const sectionOf = () => container.current?.closest<HTMLElement>('[data-window-id]') ?? null;

  useLayoutEffect(() => {
    handlers.current = {
      'app.ready': () => setReady(true),
      'app.open': ({ appId: target, params: p, handles }) => {
        // The Installer is the desktop's alone to open.
        if (typeof target !== 'string' || target === 'installer') return;
        // Paths in params grant nothing; files travel as handles, which the
        // window manager hands on as paths (and the new window's frame
        // turns back into handles).
        const { path: _path, paths: _paths, ...clean } = (p ?? {}) as Record<string, unknown>;
        const paths = (handles ?? []).map((id) => grantOf(id).path);
        const files = paths.length === 0 ? {} : paths.length === 1 ? { path: paths[0] } : { paths };
        live.current.actions.open(target, { ...clean, ...files });
      },
      'app.openFiles': async ({ handles }) => {
        for (const id of handles) {
          const g = grantOf(id);
          const name = basename(g.path);
          // A Windows program runs, through Wine, instead of opening.
          const native = getNativeAppsBridge();
          if (native && g.kind === 'file' && isWindowsProgram(name)) await native.runWindowsProgram(g.path);
          else live.current.actions.open(appForFile(name), { path: g.path });
        }
      },
      'app.canOpen': ({ appId: target }) => {
        if (typeof target !== 'string' || !installed?.getApp(target)) return false;
        if (target === 'assistant') return getAssistantBridge() !== undefined && live.current.config.assistantEnabled !== false;
        return true;
      },
      'app.openUrl': ({ url }) => {
        if (typeof url !== 'string' || !/^(https?|nsite):\/\//i.test(url)) return;
        // A tab in the open browser, else a new browser window (the bus
        // keeps the command until it's up).
        if (!hasTabConsumer()) live.current.actions.open('web-browser');
        publishTabCommand({ type: 'open', url });
      },
      'storage.migrated': () => {
        const entries = storageToMigrate(manifest);
        if (entries) forgetMigratedStorage(entries);
      },

      'window.setTitle': ({ title }) => live.current.publishTitle?.(typeof title === 'string' ? title.slice(0, 300) : null),
      'window.setIcon': ({ url }) => live.current.publishIcon?.(typeof url === 'string' ? sanitizeImageUrl(url) : null),
      'window.setAccent': ({ color }) => live.current.publishAccent?.(typeof color === 'string' ? color : null),
      'window.setChrome': (c) => {
        const mode = c.frame === 'custom' || c.frame === 'none' ? c.frame : 'standard';
        setFrameMode(mode);
        const w = live.current.win;
        if (w) live.current.actions.setFrameless(windowId, mode === 'none', { x: w.x, y: w.y, width: w.width, height: w.height });
      },
      'window.setShape': ({ shape }) => {
        const section = sectionOf();
        if (!section) return;
        if (!Array.isArray(shape) || shape.length === 0) {
          section.style.clipPath = '';
          return;
        }
        // On the window's outermost element: clipped there, clicks outside
        // the shape reach whatever's behind (on the guest alone, the window
        // around it would still take them).
        const r = guestRect();
        const s = section.getBoundingClientRect();
        const dx = (r?.left ?? s.left) - s.left;
        const dy = (r?.top ?? s.top) - s.top;
        const d = shape
          .filter((q) => [q.x, q.y, q.width, q.height].every(Number.isFinite))
          .map((q) => `M${q.x + dx} ${q.y + dy}h${q.width}v${q.height}h${-q.width}Z`)
          .join('');
        section.style.clipPath = `path('${d}')`;
      },
      'window.beginMove': ({ at }) => {
        if (live.current.chrome.beginMove(toDesktop(at))) setMoving(true);
      },
      'window.beginResize': ({ edge, at }) => {
        if (live.current.chrome.beginResize(edge, toDesktop(at))) setMoving(true);
      },
      'window.setBounds': (b) => {
        const w = live.current.win;
        if (!w || w.maximized || w.snapped || w.tiled) return;
        const next = { x: b.x ?? w.x, y: b.y ?? w.y, width: b.width ?? w.width, height: b.height ?? w.height };
        if (![next.x, next.y, next.width, next.height].every(Number.isFinite)) return;
        // Kept on its monitor's work area, as far as it fits.
        const area = live.current.windowState(w).workArea;
        next.width = Math.min(next.width, area.width);
        next.height = Math.min(next.height, area.height);
        next.x = Math.max(area.x, Math.min(next.x, area.x + area.width - next.width));
        next.y = Math.max(area.y, Math.min(next.y, area.y + area.height - next.height));
        live.current.actions.resize(windowId, next);
      },
      'window.minimize': () => live.current.frame?.minimize(),
      'window.maximize': () => {
        if (!live.current.win?.maximized) live.current.frame?.toggleMaximize();
      },
      'window.restore': () => {
        const w = live.current.win;
        if (w && (w.maximized || w.snapped)) {
          live.current.actions.unmaximize(windowId, w.restore ?? { x: w.x, y: w.y, width: w.width, height: w.height });
        }
      },
      'window.toggleMaximize': () => live.current.frame?.toggleMaximize(),
      'window.focus': () => live.current.actions.focus(windowId),
      'window.close': () => {
        setCloseGuard(windowId, null);
        live.current.actions.close(windowId);
      },
      'window.requestClose': () => live.current.actions.close(windowId),
      'window.setCloseGuard': ({ on }) => {
        setCloseGuard(
          windowId,
          on
            ? () => {
                const s = session.current;
                if (!s) return false;
                const request = s.nextRequest++;
                push({ type: 'closeRequest', request });
                // No answer in time: the app is stuck.
                s.closeRequests.set(request, setTimeout(() => setHung(true), CLOSE_ANSWER_MS));
                return true;
              }
            : null,
        );
      },
      'window.closeAnswer': ({ request, keep }) => {
        const s = session.current;
        const timer = s?.closeRequests.get(request);
        if (timer === undefined) return;
        clearTimeout(timer);
        s!.closeRequests.delete(request);
        setHung(false);
        if (!keep) {
          setCloseGuard(windowId, null);
          live.current.actions.close(windowId);
        }
      },
      'window.menu': ({ at }) => {
        const p = toDesktop(at);
        setPopup({ at: { x: p.clientX, y: p.clientY }, windowMenu: true });
      },

      'menus.setMenuBar': ({ menus: list }) => setMenus(Array.isArray(list) && list.length > 0 ? list : null),
      'menus.popup': ({ items, at }) =>
        new Promise<string | null>((resolve) => {
          const p = toDesktop(at);
          setPopup({ at: { x: p.clientX, y: p.clientY }, items, resolve });
        }),

      'files.open': async (o) => {
        const pick = live.current.picker;
        if (!pick) return [];
        const start = await startFolder(o.startInHandle, typeof o.startIn === 'string' ? o.startIn : undefined);
        const result = await pick.pickFiles({
          title: o.title,
          multiple: o.multiple,
          directory: o.directory,
          filters: o.types?.map((t) => ({ name: t.description, patterns: t.extensions.map((e) => `*${e.startsWith('.') ? e : `.${e}`}`), mimeTypes: [] })),
          initialPath: start,
        });
        return result ? grantPaths(result.paths, o.writable !== false) : [];
      },
      'files.save': async (o) => {
        const pick = live.current.picker;
        if (!pick) return null;
        const start = await startFolder(o.startInHandle, typeof o.startIn === 'string' ? o.startIn : undefined);
        const result = await pick.pickFiles({
          title: o.title,
          mode: 'save',
          currentName: o.suggestedName,
          filters: o.types?.map((t) => ({ name: t.description, patterns: t.extensions.map((e) => `*${e.startsWith('.') ? e : `.${e}`}`), mimeTypes: [] })),
          initialPath: start,
        });
        let path = result?.paths[0];
        if (!path) return null;
        // A name typed without the chosen type's extension (or any offered
        // type's) gets the chosen one.
        const dotted = (list: string[] | undefined) => (list ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
        const chosen = dotted(o.types?.[result?.filter ?? 0]?.extensions);
        const offered = (o.types ?? []).flatMap((t) => dotted(t.extensions));
        if (chosen.length > 0 && !offered.some((e) => path!.toLowerCase().endsWith(e))) path += chosen[0];
        return grantFile(path, 'file', true);
      },
      'files.read': async ({ handle }) => {
        const g = grantOf(handle);
        const fs = getFsBridge();
        if (!fs) throw new Error('Files are only available inside Din');
        const [read, stat] = await Promise.all([fs.readFile(g.path, 1024 * 1024 * 1024), fs.stat(g.path)]);
        const bytes = read.data.buffer.slice(read.data.byteOffset, read.data.byteOffset + read.data.byteLength) as ArrayBuffer;
        return { name: basename(g.path), type: mimeOf(g.path), lastModified: stat.mtimeMs ?? Date.now(), bytes };
      },
      'files.write': async ({ handle, data }) => {
        const g = grantOf(handle);
        if (!g.writable || g.kind !== 'file') throw new Error('This file was opened read-only');
        const fs = getFsBridge();
        if (!fs) throw new Error('Files are only available inside Din');
        await fs.writeFile(g.path, typeof data === 'string' ? data : new Uint8Array(data));
        // Files windows showing the folder (and anything cached of the file) catch up.
        void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', g.path] });
        void invalidateListings(queryClient, g.path);
      },
      'files.entries': async ({ handle }) => {
        const g = grantOf(handle);
        if (g.kind !== 'directory') return [];
        const fs = getFsBridge();
        if (!fs) return [];
        const listing = await fs.readdir(g.path);
        const out: HandleData[] = [];
        for (const e of listing.entries) {
          if (e.kind === 'other') continue;
          const h = grantFile(`${listing.path.replace(/\/$/, '')}/${e.name}`, e.kind, g.writable);
          if (h) out.push(h);
        }
        return out;
      },
      'files.watch': async ({ handle }) => {
        const s = session.current;
        const g = grantOf(handle);
        const fs = getFsBridge();
        if (!s || !fs || s.watches.has(handle)) return;
        const dir = g.kind === 'directory' ? g.path : dirname(g.path);
        const entry = { dir, id: null as number | null };
        s.watches.set(handle, entry);
        entry.id = await fs.watch(dir);
      },
      'files.unwatch': ({ handle }) => {
        const w = session.current?.watches.get(handle);
        if (!w) return;
        session.current!.watches.delete(handle);
        if (w.id !== null) void getFsBridge()?.unwatch(w.id);
      },
      'files.persist': ({ handle }) => {
        const g = grantOf(handle);
        const token = crypto.randomUUID();
        const all = persisted();
        all[token] = { appId, ...g };
        localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
        return token;
      },
      'files.restore': async ({ token }) => {
        const entry = persisted()[token];
        if (!entry || entry.appId !== appId) return null;
        try {
          await getFsBridge()?.stat(entry.path);
        } catch {
          return null;
        }
        return grantFile(entry.path, entry.kind, entry.writable);
      },
      'files.url': async ({ handle }) => {
        const g = grantOf(handle);
        const apps = getAppsBridge();
        if (!apps || guestId === null) throw new Error('File URLs are only available inside Din');
        return apps.fileUrl(guestId, g.path);
      },
      'files.fromPath': async ({ path }) => {
        need('fs');
        if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('An absolute path is required');
        const [handle] = await grantPaths([path]);
        if (!handle) throw new Error(`${path} doesn’t exist`);
        return handle;
      },

      'media.setSession': ({ session: next }) => {
        need('media-session');
        media.current.session = next;
        media.current.notify();
      },
      'desktop.setWallpaper': async ({ handle }) => {
        need('wallpaper');
        if (!background) throw new Error('No desktop to set');
        await background.setBackground({ path: grantOf(handle).path });
      },
      'dictation.start': async ({ held }) => {
        // Into the field focused in the app: the guest is what's focused here.
        const target = focusedDictationTarget();
        const el = surface.current?.element();
        if (!target || !el || target.owner !== el) throw new Error('Nothing in the app is focused');
        await startDictation(target, { held });
      },
      'dictation.finish': () => finishDictation(),
      'dictation.cancel': () => cancelDictation(),

      'drag.startFiles': ({ token, handles, label }) => {
        const grants = handles.map(grantOf);
        const ok = registerDrag({
          token,
          kind: 'files',
          source: appId,
          label: typeof label === 'string' ? label.slice(0, 200) : '',
          paths: grants.map((g) => g.path),
          folders: grants.length > 0 && grants.every((g) => g.kind === 'directory'),
          onEnd: ({ dropped, operation }) => push({ type: 'dragEnd', token, dropped, operation }),
        });
        if (!ok) throw new Error('That drag token is taken');
      },
      'drag.startPaths': async ({ token, paths, label }) => {
        need('fs');
        const fs = getFsBridge();
        const clean = paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
        const kinds = await Promise.all(clean.map((p) => fs?.stat(p).then((st) => st.kind, () => 'file') ?? 'file'));
        const ok = registerDrag({
          token,
          kind: 'files',
          source: appId,
          label: typeof label === 'string' ? label.slice(0, 200) : '',
          paths: clean,
          folders: clean.length > 0 && kinds.every((k) => k === 'directory'),
          onEnd: ({ dropped, operation }) => push({ type: 'dragEnd', token, dropped, operation }),
        });
        if (!ok) throw new Error('That drag token is taken');
      },
      'drag.startTab': ({ token, tabType, state, label }) => {
        const ok = registerDrag({
          token,
          kind: 'tab',
          source: appId,
          label: typeof label === 'string' ? label.slice(0, 200) : '',
          paths: [],
          folders: false,
          tabType,
          tabState: state,
          onEnd: ({ dropped, operation }) => push({ type: 'dragEnd', token, dropped, operation }),
        });
        if (!ok) throw new Error('That drag token is taken');
      },
      'drag.accept': async ({ token, operation }) => {
        const entry = acceptDrag(token, operation);
        if (!entry) return null;
        if (entry.kind === 'tab') {
          // Tabs move only between windows of the same app.
          if (entry.source !== appId) return null;
          return { kind: 'tab', tabType: entry.tabType ?? '', state: entry.tabState };
        }
        // Without fs an app can only receive copies: it can't delete the originals.
        const op = permissions.includes('fs') ? operation : 'copy';
        return { kind: 'files', files: await grantPaths(entry.paths), operation: op };
      },
      'drag.over': ({ at }) => {
        const p = toDesktop(at);
        if (currentDrag()) setDragPoint({ x: p.clientX, y: p.clientY });
      },
      'drag.finish': ({ token, dropEffect, at }) => {
        const entry = finishDrag(token, dropEffect);
        if (entry?.kind === 'tab' && !entry.accepted && dropEffect === 'none') {
          const p = toDesktop(at);
          push({ type: 'tabDetached', tabType: entry.tabType ?? '', state: entry.tabState, at: { x: p.clientX, y: p.clientY } });
        }
      },

      'clipboard.readFiles': async () => {
        const clip = getFileClipboard();
        if (!clip) return null;
        return { files: await grantPaths(clip.paths), cut: clip.op === 'cut' };
      },
      'clipboard.writeFiles': ({ handles, cut }) => {
        // Nothing to hold clears it, and leaves the text clipboard alone.
        setFileClipboard(handles.length === 0 ? null : { op: cut ? 'cut' : 'copy', paths: handles.map((id) => grantOf(id).path) });
      },

      'notifications.show': ({ title, options }) => {
        if (!options.transient) need('notifications');
        notify({
          source: { appId, name: appName, icon: manifestIcon(manifest) },
          title: String(title).slice(0, 200),
          body: typeof options.body === 'string' ? options.body.slice(0, 2000) : '',
          image: options.icon ? sanitizeImageUrl(options.icon) : null,
          actions: (options.actions ?? []).slice(0, 3).map((a) => ({ id: String(a.id), label: String(a.label) })),
          history: !options.transient,
          replaceKey: options.tag ? `${appId}:${options.tag}` : undefined,
          onActivate: (action) => {
            live.current.actions.focus(windowId);
            push({ type: 'notificationAction', tag: options.tag ?? null, action });
          },
        });
      },
      'notifications.setBadge': () => {
        need('notifications');
      },

      'print.html': async ({ title, html }) => {
        need('printing');
        await printHtml(String(title), String(html));
      },
      'print.file': async ({ handle }) => {
        need('printing');
        await printFile(grantOf(handle).path);
      },

      'nostr.getPublicKey': async () => {
        need('nostr');
        const signer = live.current.user?.signer;
        if (!signer) throw new Error('Nobody is signed in');
        return signer.getPublicKey();
      },
      'nostr.signEvent': async ({ event }) => {
        need('nostr');
        const signer = live.current.user?.signer;
        if (!signer) throw new Error('Nobody is signed in');
        return signer.signEvent(event as Parameters<typeof signer.signEvent>[0]);
      },
      'nostr.encrypt': async ({ version, pubkey, text }) => {
        need('nostr');
        const cipher = live.current.user?.signer[version];
        if (!cipher) throw new Error(`The signer can't do ${version}`);
        return cipher.encrypt(pubkey, text);
      },
      'nostr.decrypt': async ({ version, pubkey, text }) => {
        need('nostr');
        const cipher = live.current.user?.signer[version];
        if (!cipher) throw new Error(`The signer can't do ${version}`);
        return cipher.decrypt(pubkey, text);
      },
    };
  });

  /** Start serving a newly connected document's port. */
  const serve = useCallback(async (port: MessagePort, webContentsId: number | null) => {
    session.current?.port.close();
    const s = { port, grants: new Map<string, Grant>(), nextHandle: 1, nextRequest: 1, closeRequests: new Map(), watches: new Map() };
    session.current = s;
    setReady(false);
    setGone(false);
    setHung(false);
    setMenus(null);
    setCloseGuard(windowId, null);
    port.onmessage = (e) => {
      const message = e.data as FromApp;
      if (message?.type !== 'request' || typeof message.id !== 'number') return;
      const handler = handlers.current[message.method] as ((p: unknown) => unknown) | undefined;
      const reply = (body: { result?: unknown; error?: { name: string; message: string } }) => {
        if (session.current === s) port.postMessage({ type: 'reply', id: message.id, ...body });
      };
      if (!handler) {
        reply({ error: { name: 'NotSupportedError', message: `Unknown method ${String(message.method)}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.params))
        .then((result) => reply({ result }))
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          reply({ error: { name: err.name, message: err.message } });
        });
    };

    // The bridges it's granted get their own ports to main, before hello.
    const apps = getAppsBridge();
    let fsUrlBase: string | null = null;
    if (apps && webContentsId !== null) {
      for (const p of SYSTEM_PERMISSIONS) {
        if (!permissions.includes(p)) continue;
        const granted = await apps.grant(webContentsId, p).catch((e: unknown) => {
          console.error(`din: granting ${p}:`, e);
          return null;
        });
        if (p === 'fs') fsUrlBase = granted;
      }
    }

    const l = live.current;
    const hello: Hello = {
      type: 'hello',
      version: 1,
      appId,
      launch: await launchOf(params, 'new'),
      state: l.windowState(l.win),
      frameStyle: frameStyle(l.win?.accent ?? null),
      theme: themeSnapshot(l.zoom),
      account: l.account(),
      permissions,
      storage: storageToMigrate(manifest),
      drag: dragInfo(currentDrag()),
      dictation: { available: hasDictationBridge(), status: getDictationState().status },
      fsUrlBase,
      printAvailable: getPrintingBridge() !== undefined,
    };
    if (session.current === s) port.postMessage(hello);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, windowId]);

  // ---- connecting ----
  // Electron: main hands over the port once the guest's preload asks.
  useEffect(() => {
    if (guestId === null) return;
    return onAppPort(guestId, ({ appId: connected, port }) => {
      if (connected !== appId) {
        port.close();
        return;
      }
      void serve(port, guestId);
    });
  }, [guestId, appId, serve]);

  // Elsewhere: the framed page says hello, and gets a port posted to its origin.
  useEffect(() => {
    if (guestsAvailable()) return;
    const onMessage = (e: MessageEvent) => {
      const frameWindow = iframe.current?.contentWindow;
      if (!frameWindow || e.source !== frameWindow || (e.data as { type?: string } | null)?.type !== 'din:hello') return;
      const origin = new URL(appUrl(appId, manifest)).origin;
      if (e.origin !== origin) return;
      const channel = new MessageChannel();
      frameWindow.postMessage({ type: 'din:port' }, origin, [channel.port2]);
      void serve(channel.port1, null);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appId, manifest, serve]);

  // What the app is playing, among the desktop's media sources.
  useEffect(() => {
    if (!permissions.includes('media-session')) return;
    const listeners = new Set<() => void>();
    const current = (): MediaSource | null => {
      const { session, since } = media.current;
      return session
        ? {
            id: `app:${windowId}`,
            kind: 'app',
            title: session.title,
            subtitle: session.subtitle,
            artwork: session.artwork ? sanitizeImageUrl(session.artwork) : null,
            playing: session.playing,
            canPlay: session.canPlay,
            canPrevious: session.canPrevious,
            canNext: session.canNext,
            since: since || Date.now(),
          }
        : null;
    };
    media.current.notify = () => {
      const m = media.current;
      if (m.session?.playing && !m.since) m.since = Date.now();
      if (!m.session) m.since = 0;
      for (const l of listeners) l();
    };
    return registerMediaSource({
      current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      control: (action) => push({ type: 'mediaAction', action }),
      playIdle: () => {
        if (!media.current.session?.canPlay) return false;
        push({ type: 'mediaAction', action: 'play' });
        return true;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, push]);

  // Dictation's status, for the app's mic buttons.
  useEffect(() => {
    let last = getDictationState().status;
    return subscribeDictation(() => {
      const status = getDictationState().status;
      if (status === last) return;
      last = status;
      push({ type: 'dictation', status });
    });
  }, [push]);

  // The manifest's theme color tints the title bar until the app says otherwise.
  useEffect(() => {
    if (manifest.theme_color) publishAccent?.(manifest.theme_color);
  }, [manifest.theme_color, publishAccent]);

  // ---- pushes ----
  const stateJson = JSON.stringify(windowState(win));
  useEffect(() => {
    push({ type: 'state', state: JSON.parse(stateJson) as WindowState });
  }, [stateJson, push]);
  const accent = win?.accent ?? null;
  useEffect(() => {
    push({ type: 'frameStyle', style: frameStyle(accent) });
  }, [accent, push]);
  useEffect(() => {
    let last = '';
    const send = () => {
      const theme = themeSnapshot(live.current.zoom);
      const json = JSON.stringify(theme);
      if (json === last) return;
      last = json;
      push({ type: 'theme', theme });
    };
    send();
    return onThemeChange(send);
  }, [push, zoom]);
  const accountJson = JSON.stringify(account());
  useEffect(() => {
    push({ type: 'account', account: JSON.parse(accountJson) as AccountSnapshot });
  }, [accountJson, push]);
  useEffect(() => subscribeDrag(() => push({ type: 'drag', drag: dragInfo(currentDrag()) })), [push]);
  useEffect(() => subscribeFileClipboard(() => {
    const clip = getFileClipboard();
    push({ type: 'clipboardFiles', has: clip ? { count: clip.paths.length, cut: clip.op === 'cut' } : null });
  }), [push]);
  // A watched file changed or went away.
  useEffect(() => {
    const fs = getFsBridge();
    if (!fs) return;
    return fs.onChange((dir) => {
      const s = session.current;
      if (!s) return;
      for (const [handle, w] of s.watches) {
        if (w.dir !== dir) continue;
        const g = s.grants.get(handle);
        if (!g) continue;
        fs.stat(g.path).then(
          () => push({ type: 'fileChange', handle, change: 'modified' }),
          () => push({ type: 'fileChange', handle, change: 'removed' }),
        );
      }
    });
  }, [push]);

  // A single-instance app launched again, or a Dock shortcut chosen.
  const paramsJson = JSON.stringify(params ?? {});
  const firstParams = useRef(paramsJson);
  useEffect(() => {
    if (paramsJson === firstParams.current) return;
    firstParams.current = paramsJson;
    void launchOf(JSON.parse(paramsJson) as Record<string, unknown>, 'relaunch').then((launch) => push({ type: 'launch', launch }));
  }, [paramsJson, launchOf, push]);

  // Main's word that the app stopped answering (it can take a while to notice).
  useEffect(() => {
    const apps = getAppsBridge();
    if (!apps || guestId === null) return;
    return apps.onResponsive(({ webContentsId, responsive }) => {
      if (webContentsId === guestId) setHung(!responsive);
    });
  }, [guestId]);

  // Leaving: the window's guard and the session go with it.
  useEffect(() => () => {
    setCloseGuard(windowId, null);
    session.current?.port.close();
    session.current = null;
  }, [windowId]);

  // ---- moving from inside the app ----
  // Main forwards the guest's pointer moves to its element (GuestInputHost),
  // so the window follows at once; those stop when the pointer leaves the
  // guest, so a cover over the desktop takes the pointer over a frame or two
  // later and follows it anywhere. The app never sees the release: it's told.
  useEffect(() => {
    if (!moving) return;
    const el = surface.current?.element() ?? iframe.current;
    const forwarded = (e: Event) => live.current.chrome.gestureMove(e as PointerEvent);
    el?.addEventListener('pointermove', forwarded);
    return () => el?.removeEventListener('pointermove', forwarded);
  }, [moving]);
  const endMove = () => {
    if (!moving) return;
    setMoving(false);
    live.current.chrome.gestureEnd();
    push({ type: 'moveEnd' });
  };

  const forceQuit = () => {
    if (guestId !== null) void getAppsBridge()?.kill(guestId);
  };
  const reopen = () => {
    setGone(false);
    setHung(false);
    if (guestsAvailable()) surface.current?.reload();
    else setLoadKey((k) => k + 1);
  };

  const icon = manifestIcon(manifest);
  const src = appUrl(appId, manifest);
  let overlay: ReactNode = null;
  if (gone) {
    overlay = (
      <Stopped icon={<Unplug className="size-7" aria-hidden />} title={`${appName} stopped`} body="It crashed, ran out of memory, or was ended.">
        <Button onClick={reopen} className="min-w-32">
          <RotateCw className="mr-2 size-4" aria-hidden />
          Reopen
        </Button>
      </Stopped>
    );
  } else if (hung) {
    overlay = (
      <Stopped icon={<Hourglass className="size-7" aria-hidden />} title={`${appName} isn’t responding`} body="You can wait for it, or force it to quit and lose what it hasn’t saved.">
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => setHung(false)}>
            Wait
          </Button>
          <Button variant="destructive" onClick={forceQuit}>
            Force Quit
          </Button>
        </div>
      </Stopped>
    );
  }

  return (
    <div ref={container} className="relative flex size-full" data-din-app={appId}>
      {guestsAvailable() ? (
        <GuestSurface
          ref={surface}
          src={src}
          partition={DIN_APPS_PARTITION}
          className="relative flex size-full"
          onAttach={setGuestId}
          onLoadStart={() => setGone(false)}
          onGone={() => {
            setGone(true);
            session.current = null;
            setCloseGuard(windowId, null);
            setMenus(null);
          }}
        />
      ) : (
        <iframe
          key={loadKey}
          ref={iframe}
          src={src}
          title={appName}
          className="size-full border-0 bg-transparent"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      )}
      {!ready && !gone && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid place-items-center motion-safe:animate-in motion-safe:fade-in-0"
          style={{ backgroundColor: manifest.background_color }}
        >
          <AppIcon icon={icon} className="size-16 opacity-80" />
        </div>
      )}
      {overlay}
      {menus && <DataMenuBar menus={menus} onAction={(id) => push({ type: 'menuAction', id })} />}
      {popup && (
        <PointMenu
          at={popup.at}
          items={popup.items}
          onAction={(id) => {
            popup.resolve?.(id);
            setPopup(null);
          }}
          onClose={() => {
            popup.resolve?.(null);
            setPopup(null);
          }}
        >
          {popup.windowMenu && frame ? (
            <WindowMenuItems win={frame.win} onMinimize={frame.minimize} onToggleMaximize={frame.toggleMaximize} />
          ) : undefined}
        </PointMenu>
      )}
      {moving &&
        createPortal(
          <div
            aria-hidden
            className="fixed inset-0 z-[10000] cursor-grabbing"
            onPointerMove={(e) => {
              if (e.buttons === 0) endMove();
              else live.current.chrome.gestureMove(e);
            }}
            onPointerUp={endMove}
            onPointerCancel={endMove}
          />,
          document.getElementById('shell') ?? document.body,
        )}
    </div>
  );
}

function Stopped({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-background p-6">
      <div className="w-full max-w-md space-y-5 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold leading-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

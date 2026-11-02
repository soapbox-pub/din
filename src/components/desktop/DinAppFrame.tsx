import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Hourglass, RotateCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { AppIcon } from '@/components/desktop/AppIcon';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { DataMenuBar, PointMenu } from '@/components/desktop/dinHost/DataMenus';
import { onThemeChange, themeSnapshot } from '@/components/desktop/dinHost/theme';
import { sanitizeImageUrl } from '@/components/desktop/dinHost/urls';
import { WindowMenuItems } from '@/components/desktop/WindowContextMenu';
import { useQueryClient } from '@tanstack/react-query';
import { useWindowFrame, useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowChrome, type ChromePoint } from '@/contexts/WindowChromeContext';
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
import { useSlowLaunch } from '@/hooks/useSlowLaunch';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import { setCloseGuard } from '@/lib/closeGuards';
import { appForFile } from '@/lib/fileTypes';
import { getFsBridge } from '@/lib/fs';
import { unreadAssistantSessions } from '@/lib/assistantNotifications';
import { closeNotification, getNotificationState, notify, subscribeNotifications } from '@/lib/notificationCenter';
import { setWindowBadge } from '@/lib/appBadges';
import { printFile, printHtml } from '@/lib/printing';
import { powerModeOn, subscribePowerMode, typed } from '@/lib/powerMode';
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
import { cleanCursorError, getSystemCursorBridge } from '@/lib/systemCursor';
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
  appKeyOf,
  appSessionState,
  appWindowIds,
  appWindows,
  persistedGrant,
  persistGrant,
  recentFilesToMigrate,
  releaseGrant,
  windowIdAt,
  hoverTab,
} from '@/lib/dinApps';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { readStoredModel, setStoredModel, setViewedSession, subscribeStoredModel, followDinSession } from '@/hooks/useAssistant';
import { setTabDragLabel } from '@/lib/dinDrag';
import { acceptDrag, dragInfo, finishDrag, registerDrag, setDragPoint, subscribeDrag, currentDrag } from '@/lib/dinDrag';
import { guestElements, guestsAvailable, isGuestFullscreen } from '@/platform/guest';
import { GuestSurface, type GuestSurfaceHandle } from '@/platform/GuestSurface';
import type { AppComponentProps } from '@/lib/apps';
import { saveWindowState, wasRestored, windowStateOf } from '@/lib/windowSession';
import type { AssistantSettings, DinManifest, FrameStyle, MediaSession, MenuItem, Menu, Permission, Rect, WindowChrome, WindowState } from '@/sdk/din';
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
  /**
   * The path with its links followed when it was granted, which it must
   * still resolve to when it's used: a file swapped for a link since reaches
   * nothing. Null outside Electron.
   */
  real: string | null;
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

/** An absolute path with `.`, `..` and repeated slashes resolved, or null if it isn't one. */
function normalizePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/**
 * Every string an app's saved state holds, as a whole value: JSON is looked
 * into (and JSON within its strings), `~/` read as home. What requestAccess
 * grants unasked must be named exactly, never just a prefix of something.
 */
function savedStrings(values: string[], home: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => out.add(s.startsWith('~/') ? `${home}/${s.slice(2)}` : s);
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === 'string') {
      add(value);
      if (/^\s*[[{"]/.test(value)) {
        try {
          walk(JSON.parse(value), depth + 1);
        } catch {
          // Just a string.
        }
      }
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        add(k);
        walk(v, depth + 1);
      }
    }
  };
  for (const value of values) walk(value, 0);
  return out;
}

/** How recently the user must have pressed a key or clicked in the app (or picked from its menus) for it to read the file clipboard. */
const GESTURE_MS = 3000;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', txt: 'text/plain', md: 'text/markdown',
  html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', pdf: 'application/pdf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
};

function mimeOf(name: string): string {
  return MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}


/** `startIn`'s named folders, under home. */
const NAMED_FOLDERS: Record<string, string> = {
  documents: 'Documents',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
  downloads: 'Downloads',
};

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
  const openUrl = useOpenUrl();
  const { updateConfig } = useAppContext();
  const zoom = config.zoomLevel / 100;
  const permissions = manifestPermissions(manifest);
  const appName = manifest.short_name ?? manifest.name;
  // fs scoped to some folders: those of files the user hands it, or fixed ones.
  const fileFolders = permissions.includes('file-folders');
  const fixedFolders = manifest.din.folders ?? [];
  const scopedFs = !permissions.includes('fs') && (fileFolders || fixedFolders.length > 0);

  const surface = useRef<GuestSurfaceHandle>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [guestId, setGuestId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const slowLaunch = useSlowLaunch();
  const [gone, setGone] = useState(false);
  const [hung, setHung] = useState(false);
  const [menus, setMenus] = useState<Menu[] | null>(null);
  const [popup, setPopup] = useState<{ at: { x: number; y: number }; items?: MenuItem[]; resolve?: (id: string | null) => void; windowMenu?: boolean } | null>(null);
  const [frameMode, setFrameMode] = useState<WindowChrome['frame']>(manifest.din.window?.frame ?? 'standard');
  const [moving, setMoving] = useState(false);
  const [accessRequest, setAccessRequest] = useState<{ paths: string[]; reason: string; resolve: (allowed: boolean) => void } | null>(null);
  /** Apps waiting on the move or resize they began to end. */
  const moveEnded = useRef<(() => void)[]>([]);
  /** Where the move or resize under way began, in the desktop's coordinates. */
  const gestureFrom = useRef<ChromePoint | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => {
      const root = container.current;
      setFullscreen(!!root && guestElements().some((el) => root.contains(el) && isGuestFullscreen(el)));
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
    webContentsId: number | null;
    /** A scoped fs grant's folders and whether each is writable, as granted so far; null when not scoped. */
    fsRoots: Map<string, boolean> | null;
    /** Whether main has the fs grant yet (later roots are added to it). */
    fsGranted: boolean;
    /** Roots on their way to main: replies wait for them. */
    scoping: Promise<unknown>;
    /**
     * On the launch that moved the app's state out of the desktop: that
     * state (and files migrated with it), whose paths requestAccess grants
     * without asking. Empty otherwise.
     */
    carryOver: string[];
    /** When the user last picked from the app's menus (a gesture main doesn't see). */
    menuPickedAt: number;
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
  const live = useRef({ win, actions, chrome, frame, user, config, zoom, picker, windowState, publishTitle, publishIcon, publishAccent, account, openUrl, updateConfig, isTop });
  useLayoutEffect(() => {
    live.current = { win, actions, chrome, frame, user, config, zoom, picker, windowState, publishTitle, publishIcon, publishAccent, account, openUrl, updateConfig, isTop };
  });

  const push = useCallback((message: Push) => session.current?.port.postMessage(message), []);
  /** The end of a move or resize the app began. */
  const endMove = useCallback(() => {
    if (!gestureFrom.current) return;
    gestureFrom.current = null;
    setMoving(false);
    live.current.chrome.gestureEnd();
    push({ type: 'moveEnd' });
    for (const resolve of moveEnded.current.splice(0)) resolve();
  }, [push]);
  /** Whether what's being dictated goes into this window. */
  const dictationHere = () => {
    const owner = getDictationState().owner;
    const el = surface.current?.element() ?? iframe.current;
    return getDictationState().status !== 'idle' && !!el && owner === el;
  };
  const assistantSettings = (): AssistantSettings => ({
    enabled: live.current.config.assistantEnabled !== false,
    directory: live.current.config.assistantDirectory ?? '',
    colorfulReplies: live.current.config.assistantColorfulReplies !== false,
    model: readStoredModel(),
  });

  /**
   * Grant the app a file it was handed, as a handle for its port. Never one
   * of Din's own files (its profile, nostrd's keys), which no app may reach
   * however it's handed them.
   */
  const grantFile = useCallback(async (path: string, kind: 'file' | 'directory', writable: boolean): Promise<HandleData | null> => {
    const apps = getAppsBridge();
    const [resolved] = apps ? await apps.resolve([path]) : [null];
    if (resolved?.protected) return null;
    const s = session.current;
    if (!s) return null;
    const id = `h${s.nextHandle++}`;
    s.grants.set(id, { path, kind, writable, real: resolved?.real ?? null });
    // With file-folders, the folder of a file the user handed it comes
    // along, writable only if the file is (main refuses home and above).
    if (fileFolders && s.fsRoots) {
      const root = kind === 'directory' ? path : dirname(path);
      const had = s.fsRoots.get(root);
      if (had === undefined || (writable && !had)) {
        s.fsRoots.set(root, writable);
        const apps = getAppsBridge();
        if (s.fsGranted && apps && s.webContentsId !== null) {
          const wc = s.webContentsId;
          s.scoping = s.scoping.then(() => apps.addFsRoot(wc, root, writable)).catch(() => {});
        }
      }
    }
    return { id, kind, name: basename(path), key: appKeyOf(appId, path), path, writable };
  }, [appId, fileFolders]);

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
      const handle = await grantFile(path, kind, writable);
      if (handle) out.push(handle);
    }
    return out;
  }, [grantFile]);

  const launchOf = useCallback(async (p: Record<string, unknown> | undefined, reason: Hello['launch']['reason']): Promise<Hello['launch']> => {
    const { path: _path, paths: _paths, actionAt: _actionAt, shortcut, opener, ...rest } = (p ?? {}) as Record<string, unknown>;
    return {
      reason,
      params: rest,
      files: await grantPaths(launchPaths(p)),
      shortcut: typeof shortcut === 'string' ? shortcut : null,
      state: reason === 'relaunch' ? null : windowStateOf(windowId),
      opener: typeof opener === 'string' ? opener : null,
    };
  }, [grantPaths, windowId]);

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
  /**
   * A handle's grant, checked as it's used: its path must resolve where it
   * did when it was granted and not into Din's own files, so an app can't
   * swap the file for a link and reach whatever it points at.
   */
  const usableGrant = async (id: string): Promise<Grant> => {
    const g = grantOf(id);
    const apps = getAppsBridge();
    if (!apps || g.real === null) return g;
    const [now] = await apps.resolve([g.path]);
    if (!now || now.protected || now.real !== g.real) {
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
  /**
   * Which of these paths the app's own fs grant reaches (to write, with
   * `write`), as main checks its calls: symlinks resolved, Din's own files
   * refused. Paths should be normalized first.
   */
  const reaches = async (paths: string[], write: boolean): Promise<boolean[]> => {
    const s = session.current;
    const apps = getAppsBridge();
    if (!s || !apps || s.webContentsId === null || !s.fsGranted || paths.length === 0) return paths.map(() => false);
    await s.scoping;
    return apps.reaches(s.webContentsId, paths, write).catch(() => paths.map(() => false));
  };
  /** The frontmost window of this app at a point of the desktop, with the point in it. */
  const tabTarget = (x: number, y: number): { windowId: string; at: { x: number; y: number } } | null => {
    const id = windowIdAt(x, y);
    const target = id ? appWindows.get(id) : undefined;
    const r = target?.guestRect();
    if (!id || !target || target.appId !== appId || !r) {
      hoverTab(null, null);
      return null;
    }
    const at = { x: x - r.left, y: y - r.top };
    hoverTab(id === windowId ? null : id, at);
    return { windowId: id, at };
  };

  useLayoutEffect(() => {
    handlers.current = {
      'app.ready': () => setReady(true),
      'app.open': async ({ appId: target, params: p, handles }) => {
        // The Installer is the desktop's alone to open.
        if (typeof target !== 'string' || target === 'installer') return;
        // Paths in params grant nothing; files travel as handles, which the
        // window manager hands on as paths (and the new window's frame
        // turns back into handles).
        const { path: _path, paths: _paths, ...clean } = (p ?? {}) as Record<string, unknown>;
        const paths = (await Promise.all((handles ?? []).map(usableGrant))).map((g) => g.path);
        const files = paths.length === 0 ? {} : paths.length === 1 ? { path: paths[0] } : { paths };
        // Who asked, which the opened app reads as `launch.opener`.
        live.current.actions.open(target, { ...clean, ...files, opener: appId });
      },
      'app.openFiles': async ({ handles }) => {
        for (const id of handles) {
          const g = await usableGrant(id);
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
      // As links open anywhere on the desktop: into an installed app that
      // owns the site, nostr: links to their viewer, else the Web Browser.
      'app.openUrl': ({ url }) => {
        if (typeof url === 'string') live.current.openUrl(url);
      },
      'storage.migrated': () => {
        const entries = storageToMigrate(manifest);
        if (entries) forgetMigratedStorage(entries);
        for (const key of manifest.din.migrateRecentFiles ?? []) localStorage.removeItem(key);
      },
      'app.windows': () =>
        appWindowIds(appId)
          .filter((id) => id !== windowId)
          .map((id) => ({ id, title: appWindows.get(id)?.title() ?? appName })),
      'app.postToWindow': ({ windowId: to, data }) => {
        const target = typeof to === 'string' ? appWindows.get(to) : undefined;
        if (target?.appId === appId) target.push({ type: 'windowMessage', from: windowId, data });
      },
      'app.sessionGet': ({ key }) => appSessionState(appId).get(String(key)),
      'app.sessionSet': ({ key, value }) => {
        appSessionState(appId).set(String(key), value);
      },
      'app.saveState': ({ state }) => {
        if (!saveWindowState(windowId, state)) console.warn(`din: ${appName}'s saved state is too big or isn't JSON; not kept`);
      },
      'window.tabDragMove': ({ at, label }) => {
        setTabDragLabel(typeof label === 'string' ? label.slice(0, 200) : '');
        const p = toDesktop(at);
        setDragPoint({ x: p.clientX, y: p.clientY });
        return tabTarget(p.clientX, p.clientY);
      },
      'window.tabDragEnd': ({ at }) => {
        const p = toDesktop(at);
        const target = tabTarget(p.clientX, p.clientY);
        setTabDragLabel(null);
        setDragPoint(null);
        hoverTab(null, null);
        return target;
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
      // Answered when the gesture ends, which the app never sees itself.
      'window.beginMove': ({ at }) => {
        const from = toDesktop(at);
        if (!live.current.chrome.beginMove(from)) return;
        gestureFrom.current = from;
        setMoving(true);
        return new Promise<void>((resolve) => moveEnded.current.push(resolve));
      },
      'window.beginResize': ({ edge, at }) => {
        const from = toDesktop(at);
        if (!live.current.chrome.beginResize(edge, from)) return;
        gestureFrom.current = from;
        setMoving(true);
        return new Promise<void>((resolve) => moveEnded.current.push(resolve));
      },
      'window.gesturePointer': ({ delta, done }) => {
        const from = gestureFrom.current;
        if (!from) return;
        if (done) endMove();
        else live.current.chrome.gestureMove({ clientX: from.clientX + delta.x, clientY: from.clientY + delta.y });
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
          confirmLabel: typeof o.confirmLabel === 'string' ? o.confirmLabel.slice(0, 40) : undefined,
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
        const g = await usableGrant(handle);
        const fs = getFsBridge();
        if (!fs) throw new Error('Files are only available inside Din');
        const [read, stat] = await Promise.all([fs.readFile(g.path, 1024 * 1024 * 1024), fs.stat(g.path)]);
        const bytes = read.data.buffer.slice(read.data.byteOffset, read.data.byteOffset + read.data.byteLength) as ArrayBuffer;
        return { name: basename(g.path), type: mimeOf(g.path), lastModified: stat.mtimeMs ?? Date.now(), bytes };
      },
      'files.write': async ({ handle, data }) => {
        const g = await usableGrant(handle);
        if (!g.writable || g.kind !== 'file') throw new Error('This file was opened read-only');
        const fs = getFsBridge();
        if (!fs) throw new Error('Files are only available inside Din');
        await fs.writeFile(g.path, typeof data === 'string' ? data : new Uint8Array(data));
        // Files windows showing the folder (and anything cached of the file) catch up.
        void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', g.path] });
        void invalidateListings(queryClient, g.path);
      },
      'files.entries': async ({ handle }) => {
        const g = await usableGrant(handle);
        if (g.kind !== 'directory') return [];
        const fs = getFsBridge();
        if (!fs) return [];
        const listing = await fs.readdir(g.path);
        const out: HandleData[] = [];
        for (const e of listing.entries) {
          if (e.kind === 'other') continue;
          const h = await grantFile(`${listing.path.replace(/\/$/, '')}/${e.name}`, e.kind, g.writable);
          if (h) out.push(h);
        }
        return out;
      },
      'files.watch': async ({ handle }) => {
        const s = session.current;
        const g = await usableGrant(handle);
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
        const { path, kind, writable } = grantOf(handle);
        return persistGrant({ appId, path, kind, writable });
      },
      'files.release': ({ token }) => releaseGrant(appId, String(token)),
      'files.requestAccess': async ({ paths, reason }) => {
        const s = session.current;
        const wanted = [...new Set((Array.isArray(paths) ? paths : []).map(normalizePath).filter((p): p is string => p !== null))].slice(0, 5000);
        if (!s || wanted.length === 0) return [];
        const fs = getFsBridge();
        // Named exactly by its own saved state from before it moved, or
        // within reach already: no need to ask.
        const saved = s.carryOver.length > 0 && fs ? savedStrings(s.carryOver, (await fs.homedir()).replace(/\/$/, '')) : new Set<string>();
        const reached = await reaches(wanted, true);
        // Only what's there is worth asking about.
        const there = await Promise.all(wanted.map((p) => (fs ? fs.stat(p).then(() => true, () => false) : Promise.resolve(true))));
        const ask = wanted.filter((p, i) => there[i] && !saved.has(p) && !reached[i]);
        if (ask.length > 0) {
          const allowed = await new Promise<boolean>((resolve) =>
            setAccessRequest({ paths: ask, reason: typeof reason === 'string' ? reason.slice(0, 300) : '', resolve }),
          );
          setAccessRequest(null);
          if (!allowed) return grantPaths(wanted.filter((p) => !ask.includes(p)));
        }
        return grantPaths(wanted);
      },
      'files.parent': async ({ handle }) => {
        if (!fileFolders && !permissions.includes('fs')) return null;
        // A file's folder only: a folder's parent would let file-folders
        // climb to the root a step at a time. Nor home or a folder holding
        // Din's own files: a file handed over from there brings only itself,
        // as main's addRoot has it.
        const g = await usableGrant(handle);
        if (g.kind !== 'file') return null;
        const parent = dirname(g.path);
        const apps = getAppsBridge();
        const [resolved] = apps ? await apps.resolve([parent]) : [null];
        if (resolved?.holds && !permissions.includes('fs')) return null;
        return grantFile(parent, 'directory', false);
      },
      'files.restore': async ({ token }) => {
        const entry = persistedGrant(appId, String(token));
        if (!entry) return null;
        try {
          await getFsBridge()?.stat(entry.path);
        } catch {
          return null;
        }
        return grantFile(entry.path, entry.kind, entry.writable);
      },
      'files.url': async ({ handle }) => {
        const g = await usableGrant(handle);
        const apps = getAppsBridge();
        if (!apps || guestId === null) throw new Error('File URLs are only available inside Din');
        return apps.fileUrl(guestId, g.path);
      },
      'files.fromPath': async ({ path: raw }) => {
        const path = normalizePath(raw);
        if (!path) throw new Error('An absolute path is required');
        // Within a scoped grant, writable only where the grant writes.
        let writable = true;
        if (!permissions.includes('fs')) {
          const [[canWrite], [canRead]] = await Promise.all([reaches([path], true), reaches([path], false)]);
          if (!canRead) need('fs');
          writable = canWrite;
        }
        const [handle] = await grantPaths([path], writable);
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
        await background.setBackground({ path: (await usableGrant(handle)).path });
      },
      'desktop.setCursor': async ({ handle }) => {
        need('cursor');
        const cursor = getSystemCursorBridge();
        if (!cursor) throw new Error('Din can’t change the cursor here');
        try {
          await cursor.importTheme((await usableGrant(handle)).path);
        } catch (error) {
          throw new Error(cleanCursorError(error), { cause: error });
        } finally {
          // Settings lists the new theme and shows it chosen.
          void queryClient.invalidateQueries({ queryKey: ['cursor'] });
        }
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

      'drag.startFiles': async ({ token, handles, label }) => {
        const grants = await Promise.all(handles.map(usableGrant));
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
        const fs = getFsBridge();
        const clean = paths.map(normalizePath).filter((p): p is string => p !== null);
        // Within a scoped grant: what it can't write, a target only copies.
        let copyOnly = false;
        if (!permissions.includes('fs')) {
          if (!(await reaches(clean, false)).every(Boolean)) need('fs');
          copyOnly = !(await reaches(clean, true)).every(Boolean);
        }
        const kinds = await Promise.all(clean.map((p) => fs?.stat(p).then((st) => st.kind, () => 'file') ?? 'file'));
        const ok = registerDrag({
          token,
          kind: 'files',
          source: appId,
          label: typeof label === 'string' ? label.slice(0, 200) : '',
          paths: clean,
          folders: clean.length > 0 && kinds.every((k) => k === 'directory'),
          copyOnly,
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
        // Without fs an app can only receive copies: it can't delete the
        // originals. Nor can it move what its source could only read.
        const op = permissions.includes('fs') ? (entry.accepted?.operation ?? operation) : 'copy';
        return { kind: 'files', files: await grantPaths(entry.paths), operation: op };
      },
      'window.typed': ({ x, y, color }) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const p = toDesktop({ x, y });
        typed({ x: p.clientX, y: p.clientY, color: typeof color === 'string' ? color.slice(0, 100) : '' }, sectionOf());
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
        // Files on the clipboard are the user's to hand over: an app without
        // fs (which reaches them anyway) gets them only on a paste, just
        // after a key or click in it or a pick from its menus.
        if (!permissions.includes('fs')) {
          const s = session.current;
          const apps = getAppsBridge();
          const since = apps && s?.webContentsId != null ? await apps.sinceInput(s.webContentsId).catch(() => null) : null;
          const menu = s ? Date.now() - s.menuPickedAt : Infinity;
          if (!live.current.isTop || ((since === null || since > GESTURE_MS) && menu > GESTURE_MS)) {
            const error = new Error('The file clipboard is read on a paste');
            error.name = 'NotAllowedError';
            throw error;
          }
        }
        return { files: await grantPaths(clip.paths), cut: clip.op === 'cut' };
      },
      'clipboard.writeFiles': async ({ handles, cut }) => {
        const grants = await Promise.all(handles.map(usableGrant));
        // Nothing to hold clears it, and leaves the text clipboard alone.
        setFileClipboard(grants.length === 0 ? null : { op: cut ? 'cut' : 'copy', paths: grants.map((g) => g.path) });
      },

      // The page's `new Notification()`: its id is the page's own, so a
      // window can only reach its own notifications.
      'notifications.show': ({ id, title, options }) => {
        need('notifications');
        notify({
          id: `${windowId}:${Number(id)}`,
          source: { appId, name: appName, icon: manifestIcon(manifest) },
          title: String(title).slice(0, 200),
          body: typeof options.body === 'string' ? options.body.slice(0, 2000) : '',
          image: options.icon ? sanitizeImageUrl(options.icon) : null,
          actions: (options.actions ?? []).slice(0, 3).map((a) => ({ id: String(a.id), label: String(a.label) })),
          replaceKey: options.tag ? `${appId}:${String(options.tag)}` : undefined,
          ...(options.requireInteraction ? { timeout: 0 } : {}),
          onActivate: (action) => {
            live.current.actions.focus(windowId);
            push({ type: 'notification', id, event: 'click', action: action === 'default' ? null : action });
          },
          onClose: () => push({ type: 'notification', id, event: 'close', action: null }),
        });
      },
      'notifications.close': ({ id }) => {
        closeNotification(`${windowId}:${Number(id)}`, 'closed');
      },
      'notifications.setBadge': ({ badge }) => {
        need('notifications');
        setWindowBadge(windowId, appId, badge === 'flag' ? 'flag' : typeof badge === 'number' && badge > 0 ? Math.floor(badge) : null);
      },
      'toast': ({ title, body }) => {
        notify({
          source: { appId, name: appName, icon: manifestIcon(manifest) },
          title: String(title).slice(0, 200),
          body: typeof body === 'string' ? body.slice(0, 2000) : '',
          history: false,
        });
      },

      'print.html': async ({ title, html }) => {
        need('printing');
        await printHtml(String(title), String(html));
      },
      'print.file': async ({ handle }) => {
        need('printing');
        await printFile((await usableGrant(handle)).path);
      },

      'assistant.setSettings': (patch) => {
        need('assistant');
        if (typeof patch.enabled === 'boolean') live.current.updateConfig((c) => ({ ...c, assistantEnabled: patch.enabled }));
        const m = patch.model;
        if (m && typeof m.id === 'string' && typeof m.providerID === 'string') setStoredModel({ id: m.id, providerID: m.providerID });
      },
      'assistant.follow': ({ sessionID }) => {
        need('assistant');
        if (typeof sessionID === 'string') followDinSession(sessionID);
      },
      'assistant.viewing': ({ sessionID }) => {
        need('assistant');
        setViewedSession(windowId, typeof sessionID === 'string' ? sessionID : null);
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
    const s = {
      port,
      grants: new Map<string, Grant>(),
      nextHandle: 1,
      nextRequest: 1,
      closeRequests: new Map(),
      watches: new Map(),
      webContentsId,
      fsRoots: scopedFs ? new Map<string, boolean>() : null,
      fsGranted: false,
      scoping: Promise.resolve() as Promise<unknown>,
      carryOver: Object.values(storageToMigrate(manifest) ?? {}),
      menuPickedAt: 0,
    };
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
        // Folders a reply grants reach main's scoped fs before the app hears of them.
        .then(async (result) => {
          await s.scoping;
          return result;
        })
        .then((result) => reply({ result }))
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          reply({ error: { name: err.name, message: err.message } });
        });
    };

    // Launch files first: with file-folders, their folders are what fs reaches.
    const launch = await launchOf(params, wasRestored(windowId) ? 'restore' : 'new');

    // The bridges it's granted get their own ports to main, before hello.
    const apps = getAppsBridge();
    const fs = getFsBridge();
    let fsUrlBase: string | null = null;
    // Files it kept elsewhere before it moved, copied in once.
    if (fs && manifest.din.migrateFiles) {
      const home = (await fs.homedir()).replace(/\/$/, '');
      const expand = (p: string) => (p.startsWith('~/') ? `${home}/${p.slice(2)}` : p);
      for (const [from, to] of Object.entries(manifest.din.migrateFiles)) {
        const [src, dst] = [expand(from), expand(to)];
        if (!src.startsWith('/') || !dst.startsWith('/')) continue;
        const exists = (p: string) => fs.stat(p).then(() => true, () => false);
        if ((await exists(dst)) || !(await exists(src))) continue;
        try {
          const { data } = await fs.readFile(src, 256 * 1024 * 1024);
          await fs.mkdir(dirname(dst)).catch(() => {});
          await fs.writeFile(dst, data);
          s.carryOver.push(new TextDecoder().decode(data));
        } catch (error) {
          console.error(`din: migrating ${src} for ${appId}:`, error);
        }
      }
    }
    if (scopedFs && s.fsRoots && fs) {
      const home = (await fs.homedir()).replace(/\/$/, '');
      for (const folder of fixedFolders) {
        const dir = folder.startsWith('~/') ? `${home}/${folder.slice(2)}` : folder;
        if (!dir.startsWith('/')) continue;
        await fs.mkdir(dir).catch(() => {});
        s.fsRoots.set(dir.replace(/\/$/, ''), true);
      }
    }
    if (apps && webContentsId !== null) {
      for (const p of SYSTEM_PERMISSIONS) {
        const scoped = p === 'fs' && scopedFs;
        if (!permissions.includes(p) && !scoped) continue;
        const roots = scoped ? [...(s.fsRoots ?? [])].map(([path, writable]) => ({ path, writable })) : undefined;
        const granted = await apps.grant(webContentsId, p, roots).catch((e: unknown) => {
          console.error(`din: granting ${p}:`, e);
          return null;
        });
        if (p === 'fs') {
          fsUrlBase = granted;
          s.fsGranted = true;
        }
      }
    }

    // Recent files it kept here before it moved, as persisted handles.
    const recent = await recentFilesToMigrate(appId, manifest, (path) =>
      fs ? fs.stat(path).then((st) => (st.kind === 'directory' ? 'directory' : 'file'), () => null) : Promise.resolve(null),
    );

    const l = live.current;
    const hello: Hello = {
      type: 'hello',
      version: 1,
      appId,
      launch,
      state: l.windowState(l.win),
      frameStyle: frameStyle(l.win?.accent ?? null),
      theme: themeSnapshot(l.zoom),
      account: l.account(),
      permissions,
      storage: storageToMigrate(manifest),
      recentFiles: recent,
      drag: dragInfo(currentDrag()),
      dictation: { available: hasDictationBridge(), status: getDictationState().status, here: dictationHere() },
      powerMode: powerModeOn(),
      fsUrlBase,
      printAvailable: getPrintingBridge() !== undefined,
      scopedFs,
      assistant: permissions.includes('assistant') ? assistantSettings() : null,
      assistantUnread: permissions.includes('assistant') ? unreadAssistantSessions(getNotificationState().notifications) : [],
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
      // An idle session isn't listed; a play key with nothing else playing starts it.
      return session && !session.idle
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
    let last = '';
    return subscribeDictation(() => {
      const status = getDictationState().status;
      const here = dictationHere();
      if (`${status}:${here}` === last) return;
      last = `${status}:${here}`;
      push({ type: 'dictation', status, here });
    });
  }, [push]);

  // Din's assistant settings, for apps that show the assistant.
  const assistantJson = permissions.includes('assistant')
    ? JSON.stringify({ enabled: config.assistantEnabled, directory: config.assistantDirectory, colorfulReplies: config.assistantColorfulReplies })
    : '';
  useEffect(() => {
    if (!assistantJson) return;
    push({ type: 'assistantSettings', settings: assistantSettings() });
    return subscribeStoredModel(() => push({ type: 'assistantSettings', settings: assistantSettings() }));
  }, [assistantJson, push]);

  // The conversations with unread notifications, for the Assistant to mark.
  const hasAssistant = permissions.includes('assistant');
  useEffect(() => {
    if (!hasAssistant) return;
    let last = '';
    const update = () => {
      const sessionIDs = unreadAssistantSessions(getNotificationState().notifications);
      if (sessionIDs.join(' ') === last) return;
      last = sessionIDs.join(' ');
      push({ type: 'assistantUnread', sessionIDs });
    };
    update();
    return subscribeNotifications(update);
  }, [hasAssistant, push]);

  // Reachable by the app's other windows (din.app.postToWindow, tab drags).
  useEffect(() => {
    appWindows.set(windowId, {
      appId,
      push,
      title: () => live.current.win?.title ?? appName,
      guestRect: () => guestRect(),
    });
    return () => {
      appWindows.delete(windowId);
      setViewedSession(windowId, null);
      setWindowBadge(windowId, appId, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, appId, push]);

  // The manifest's theme color tints the title bar until the app says otherwise.
  useEffect(() => {
    if (manifest.theme_color) publishAccent?.(manifest.theme_color);
  }, [manifest.theme_color, publishAccent]);

  // ---- pushes ----
  const powerMode = useSyncExternalStore(subscribePowerMode, powerModeOn);
  useEffect(() => {
    push({ type: 'powerMode', on: powerMode });
  }, [powerMode, push]);
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
          // A window that opens on top takes the keyboard, the way a native
          // one does, unless something in it already has it.
          onDomReady={() => {
            if (live.current.isTop && !sectionOf()?.contains(document.activeElement)) surface.current?.focus();
          }}
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
          data-din-app-splash
          className="pointer-events-none absolute inset-0 grid place-items-center motion-safe:animate-in motion-safe:fade-in-0"
          style={{ backgroundColor: manifest.background_color }}
        >
          {slowLaunch && <AppIcon icon={icon} className="size-16 opacity-80 motion-safe:animate-in motion-safe:fade-in-0" />}
        </div>
      )}
      {overlay}
      {accessRequest && (
        <AlertDialog open onOpenChange={(open) => !open && accessRequest.resolve(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Let {appName} open {accessRequest.paths.length === 1 ? basename(accessRequest.paths[0]) : `${accessRequest.paths.length} files and folders`}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {accessRequest.reason || `${appName} asks for files you haven’t given it.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="max-h-40 overflow-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
              {accessRequest.paths.slice(0, 50).map((p) => (
                <li key={p} className="truncate">{p}</li>
              ))}
              {accessRequest.paths.length > 50 && <li>…and {accessRequest.paths.length - 50} more</li>}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => accessRequest.resolve(false)}>Don’t Allow</AlertDialogCancel>
              <AlertDialogAction onClick={() => accessRequest.resolve(true)}>Allow</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {menus && <DataMenuBar menus={menus} onAction={(id) => {
        if (session.current) session.current.menuPickedAt = Date.now();
        push({ type: 'menuAction', id });
      }} />}
      {popup && (
        <PointMenu
          at={popup.at}
          items={popup.items}
          onAction={(id) => {
            if (session.current) session.current.menuPickedAt = Date.now();
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
          // Over every monitor: <body> is only the primary one, and a move
          // carries the window wherever the pointer goes.
          <ScreenLayer
            aria-hidden
            className="z-[10000] cursor-grabbing"
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

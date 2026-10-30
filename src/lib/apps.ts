import { createElement, lazy } from 'react';
import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import { NATIVE_APP_ICON } from '@/lib/appIcons';
import { WEB_POPUP_APP_ID } from '@/lib/webPopup';
import { dinManifest, dinManifests, manifestIcon, manifestSize } from '@/lib/dinApps';

const DinAppFrame = lazy(() =>
  import('@/components/desktop/DinAppFrame').then((m) => ({ default: m.DinAppFrame })),
);

// Built-in apps are code-split: each is its own chunk, loaded the first time
// it's launched (windows render app content inside <Suspense>). Statically
// importing them shipped every app - including xterm + its WebGL addon -
// in the main bundle, which slowed boot and first paint of the desktop.
const WebBrowser = lazy(() =>
  import('@/components/desktop/apps/WebBrowser').then((m) => ({ default: m.WebBrowser })),
);
const WebPopup = lazy(() =>
  import('@/components/desktop/apps/WebPopup').then((m) => ({ default: m.WebPopup })),
);
const Settings = lazy(() =>
  import('@/components/desktop/apps/Settings').then((m) => ({ default: m.Settings })),
);
const Screenshot = lazy(() =>
  import('@/components/desktop/apps/Screenshot').then((m) => ({ default: m.Screenshot })),
);
const DevTools = lazy(() =>
  import('@/components/desktop/apps/DevTools').then((m) => ({ default: m.DevTools })),
);
const AppStore = lazy(() =>
  import('@/components/desktop/apps/AppStore').then((m) => ({ default: m.AppStore })),
);
const SystemMonitor = lazy(() =>
  import('@/components/desktop/apps/SystemMonitor').then((m) => ({ default: m.SystemMonitor })),
);
const Installer = lazy(() =>
  import('@/components/desktop/apps/Installer').then((m) => ({ default: m.Installer })),
);
/** The window body of every native Linux app (see src/lib/nativeDisplay.ts). */
export const NativeWindowView = lazy(() =>
  import('@/components/desktop/apps/NativeWindowView').then((m) => ({
    default: m.NativeWindowView,
  })),
);

/** Props every windowed app receives from the window manager. */
export interface AppComponentProps {
  /** The id of the window instance this app is rendered inside. */
  windowId: string;
  /** Launch parameters passed to open(), or undefined. App-defined shape. */
  params?: Record<string, unknown>;
}

/** A launchable desktop application. */
export interface AppDefinition {
  /** Stable unique identifier, used as a registry key. */
  id: string;
  /** Human-readable name shown in the launcher and window title bar. */
  name: string;
  /**
   * Icon shown in the launcher and taskbar: a root-relative image path
   * (built-in apps, served from public/), an https image URL (installed
   * web apps), or a Lucide component. Render through <AppIcon>, never
   * directly.
   */
  icon: LucideIcon | string;
  /** The component rendered inside the app's window. */
  component: ComponentType<AppComponentProps>;
  /**
   * True for an installed Linux app. Launching one starts a real process on
   * Din's embedded display instead of opening a window; each X window it
   * maps then opens a Din window of its own, with an `xid` launch param
   * (see src/lib/nativeDisplay.ts).
   */
  native?: boolean;
  /**
   * A native app that runs in a terminal (Terminal=true, e.g. htop).
   * Launching one opens a Terminal window running it in place of a shell.
   */
  terminal?: boolean;
  /** Default window size when the app is launched. */
  defaultSize?: { width: number; height: number };
  /**
   * The app's windows float above the tiling layout instead of taking a
   * tile, as small tools and pop-ups do (Super+T tiles one anyway).
   */
  floating?: boolean;
  /**
   * Extra terms the launcher search matches besides the name — a native
   * app's desktop-entry Keywords and Categories, so "browser" finds Firefox.
   */
  keywords?: string[];
  /**
   * Hidden apps are resolvable by id (so a window can host them) but never
   * shown in the launcher or taskbar; they're opened programmatically with
   * launch params. E.g. the browser's undocked DevTools window.
   */
  hidden?: boolean;
  /**
   * Single-instance apps only ever have one window. Launching one while it's
   * already open just focuses (and un-minimizes) the existing window instead
   * of spawning a duplicate. E.g. Settings.
   */
  singleInstance?: boolean;
  /**
   * Another app whose Dock tile this app's windows go under, rather than a
   * tile of their own. E.g. the browser's pop-up windows, under Web Browser.
   */
  dockAs?: string;
  /**
   * Shortcuts in the app's Dock and launcher menus, as a jump list: each
   * opens the app (or, single-instance, its window) with these launch
   * params plus `actionAt` (a timestamp, so choosing one twice is two
   * requests). An app can be steered from here whatever state its window is in.
   */
  actions?: { label: string; params: Record<string, unknown> }[];
  /**
   * An http(s) website installed as an app (a PWA, in effect). Its icon wears
   * a small globe in the corner, the way Android badges a Chrome-installed
   * web app, so it reads as a page from the web rather than an app Din keeps;
   * installed nsites, whose files Din holds, wear none.
   */
  web?: boolean;
  /**
   * The `nostr:` links the app opens (src/lib/nostrUri.ts): from its web app
   * manifest's `protocol_handlers` for an installed web app or nsite, whose
   * `url` (with `%s` for the URI) the app's window opens at, or from its
   * desktop entry's `x-scheme-handler/nostr` for a native app, which is
   * started with the URI and has no `url`.
   */
  nostr?: { url?: string; kinds: number[] | null };
}

/** Window bodies of din:// apps, one per app so windows keep their component. */
const dinAppComponents = new Map<string, ComponentType<AppComponentProps>>();

/**
 * A built-in app at din://<id>/ (src/apps/<id>/, docs/din/README.md), as the
 * window manager sees it: from its manifest, with DinAppFrame for a body.
 */
function dinApp(id: string): AppDefinition {
  const manifest = dinManifest(id);
  if (!manifest) throw new Error(`No manifest for the built-in app ${id}`);
  let component = dinAppComponents.get(id);
  if (!component) {
    component = function DinApp(props: AppComponentProps) {
      return createElement(DinAppFrame, { ...props, appId: id, manifest });
    };
    dinAppComponents.set(id, component);
  }
  return {
    id,
    name: manifest.short_name ?? manifest.name,
    icon: manifestIcon(manifest),
    component,
    defaultSize: manifestSize(manifest),
    floating: manifest.din.window?.floating,
    keywords: manifest.din.keywords,
    hidden: manifest.din.hidden,
    singleInstance: manifest.launch_handler?.client_mode === 'focus-existing',
    dockAs: manifest.din.dockAs,
    actions: manifest.shortcuts?.map((s) => ({
      label: s.name,
      params: { ...s.din?.params, ...(s.din?.id ? { shortcut: s.din.id } : {}) },
    })),
  };
}

/** All apps installed on the desktop, in launcher order. */
export const APPS: readonly AppDefinition[] = [
  {
    id: 'web-browser',
    name: 'Web Browser',
    icon: '/icons/apps/web-browser.png',
    component: WebBrowser,
    defaultSize: { width: 960, height: 640 },
  },
  // Email, Apple Mail style: IMAP and SMTP accounts, Favorites across
  // them, a reader that holds remote content back. Launch params
  // `{ compose: ComposeSeed }` or `{ mailto }` open a new message.
  dinApp('mail'),
  dinApp('file-browser'),
  dinApp('terminal'),
  // Plain text and code, VS Code style: a folder, tabs, quick open and
  // search across files. Files opens text files here; launch params
  // `{ path }` open one, `{ folder }` a folder, `{ blank: true }` nothing;
  // none reopens the last folder.
  dinApp('text-editor'),
  // Pictures and pixel art, MS Paint style with Kid Pix's toys. Launch
  // params `{ path }` open a picture; `{ width, height, transparent, zoom }`
  // start a new one.
  dinApp('paint'),
  // Layered pictures, Photoshop style: opens and saves PSDs and OpenRaster
  // (.ora). Files opens both here. Launch params `{ path }` open one;
  // `{ width, height, background, name }` start a new document (File > New
  // from another window).
  dinApp('photo-editor'),
  // Documents, Microsoft Word style: opens and saves .docx and .odt. Files
  // opens Word and OpenDocument text documents here. Launch params
  // `{ path }` open one.
  dinApp('word-processor'),
  // Workbooks, Microsoft Excel style: opens and saves .xlsx, .ods and CSV.
  // Files opens Excel and OpenDocument spreadsheets here. Launch params
  // `{ path }` open one.
  dinApp('spreadsheet'),
  // Presentations, Microsoft PowerPoint style: opens and saves .pptx and
  // .odp and plays slide shows. Files opens PowerPoint and OpenDocument
  // decks here. Launch params `{ path }` open one.
  dinApp('slides'),
  // A basic calculator and a graphing one (src/apps/calculator/).
  dinApp('calculator'),
  // Vector art, Illustrator style: opens and saves .ai files (and PDF and
  // SVG). Files opens Illustrator files here. Launch params `{ path }` open
  // one; `{ width, height, units, mode, artboards, name }` start a new
  // document (File > New from another window).
  dinApp('vector-editor'),
  // Desktop publishing, InDesign style: opens Microsoft Publisher
  // documents (.pub), InDesign documents (.indd, .indt) and IDML, and saves
  // IDML. Files opens them here. Launch params `{ path }` open one.
  dinApp('publisher'),
  // 2D drafting, AutoCAD style: opens DWGs (R14 to 2018) and saves
  // AutoCAD 2000 DWGs. Files opens .dwg files here. Launch params
  // `{ path }` open one; `{ new: 'imperial' | 'metric' }` start one.
  dinApp('cad'),
  // Music and video, Windows Media Player style with Winamp's soul: the
  // Now Playing list, a library of the Music and Videos folders, internet
  // radio, the equalizer and visualizations, and Winamp (.wsz) and Windows
  // Media Player (.wmz) skins. Files opens songs, playlists and skins here.
  // Launch params `{ paths, how: 'play' | 'enqueue' }` (or `{ path }`).
  dinApp('media-player'),
  // Conversations with OpenCode, the coding agent. One window, which
  // notifications and the menu bar's robot point at a conversation by
  // its `sessionID` launch param.
  dinApp('assistant'),
  // The password vault, which the Web Browser fills logins from. One
  // window, which the browser points at an item by its `item` launch param.
  dinApp('passwords'),
  // Virtual machines in ~/VMs, run with QEMU and KVM by electron/vms.mts,
  // with their screens in the window.
  dinApp('virtual-machines'),
  {
    id: 'settings',
    name: 'Settings',
    icon: '/icons/apps/settings.png',
    component: Settings,
    defaultSize: { width: 960, height: 680 },
    keywords: ['preferences', 'control panel', 'system settings', 'options'],
    singleInstance: true,
  },
  {
    // What's running and what it costs, and ending what won't quit.
    // Ctrl+Shift+Escape opens it from anywhere (DesktopHotkeys).
    id: 'system-monitor',
    name: 'System Monitor',
    icon: '/icons/apps/system-monitor.png',
    component: SystemMonitor,
    defaultSize: { width: 760, height: 560 },
    keywords: ['task manager', 'activity monitor', 'processes', 'CPU', 'memory', 'force quit', 'kill'],
    singleInstance: true,
  },
  {
    id: 'app-store',
    name: 'App Store',
    icon: '/icons/apps/app-store.png',
    component: AppStore,
    defaultSize: { width: 900, height: 640 },
  },
  {
    id: 'screenshot',
    name: 'Screenshot',
    icon: '/icons/apps/screenshot.png',
    component: Screenshot,
    defaultSize: { width: 440, height: 400 },
    floating: true,
    // One shot at a time.
    singleInstance: true,
  },
  {
    // The Web Browser's "undock into separate window" inspector. Hidden from
    // the launcher; opened by the browser with the tab's WebContents id in
    // its launch params.
    id: 'devtools',
    name: 'Developer Tools',
    icon: '/icons/apps/devtools.png',
    component: DevTools,
    defaultSize: { width: 720, height: 560 },
    hidden: true,
  },
  {
    // A pop-up window a page opened (window.open with a size, like a sign-in
    // window). Hidden from the launcher; BrowserExtensionHost opens it with
    // the page's URL and opener in its launch params, at the size it asked.
    id: WEB_POPUP_APP_ID,
    name: 'Web Browser',
    icon: '/icons/apps/web-browser.png',
    component: WebPopup,
    defaultSize: { width: 500, height: 640 },
    floating: true,
    hidden: true,
    dockAs: 'web-browser',
  },
  // One file opened from Files (a picture, a video, some text). Hidden
  // from the launcher; Files opens it with the file's path in its launch
  // params. Pictures and videos give their windows icons of their own.
  dinApp('preview'),
  {
    // Puts DinOS on the computer's disk. Hidden except on a live USB boot,
    // where InstalledAppsProvider shows it and the desktop opens it.
    id: 'installer',
    name: 'Install DinOS',
    icon: '/icons/apps/installer.png',
    component: Installer,
    defaultSize: { width: 640, height: 560 },
    hidden: true,
    singleInstance: true,
  },
  {
    // Hosts native windows that no installed app claims (a helper process,
    // an app started from a terminal). Opened only by the embedded display.
    id: 'native-window',
    name: 'Application',
    icon: NATIVE_APP_ICON,
    component: NativeWindowView,
    native: true,
    hidden: true,
  },
];

// Apps with a folder in src/apps/ but no place in the list above come last.
const listed = new Set(APPS.map((app) => app.id));
for (const id of dinManifests().keys()) {
  if (!listed.has(id)) (APPS as AppDefinition[]).push(dinApp(id));
}

/** The built-in apps whose windows go under this app's Dock tile. */
export function appsDockedAs(id: string): string[] {
  return APPS.filter((app) => app.dockAs === id).map((app) => app.id);
}

/** Look up an app definition by id. */
export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((app) => app.id === id);
}

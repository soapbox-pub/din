import { lazy } from 'react';
import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import { NATIVE_APP_ICON } from '@/lib/appIcons';
import { WEB_POPUP_APP_ID } from '@/lib/webPopup';

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
const FileBrowser = lazy(() =>
  import('@/components/desktop/apps/FileBrowser').then((m) => ({ default: m.FileBrowser })),
);
const FileViewer = lazy(() =>
  import('@/components/desktop/apps/FileViewer').then((m) => ({ default: m.FileViewer })),
);
const TextEditor = lazy(() =>
  import('@/components/desktop/apps/TextEditor').then((m) => ({ default: m.TextEditor })),
);
const Paint = lazy(() =>
  import('@/components/desktop/apps/Paint').then((m) => ({ default: m.Paint })),
);
const PhotoEditor = lazy(() =>
  import('@/components/desktop/apps/PhotoEditor').then((m) => ({ default: m.PhotoEditor })),
);
const WordProcessor = lazy(() =>
  import('@/components/desktop/apps/WordProcessor').then((m) => ({ default: m.WordProcessor })),
);
const Spreadsheet = lazy(() =>
  import('@/components/desktop/apps/Spreadsheet').then((m) => ({ default: m.Spreadsheet })),
);
const Slides = lazy(() =>
  import('@/components/desktop/apps/Slides').then((m) => ({ default: m.Slides })),
);
const Calculator = lazy(() =>
  import('@/components/desktop/apps/Calculator').then((m) => ({ default: m.Calculator })),
);
const VectorEditor = lazy(() =>
  import('@/components/desktop/apps/VectorEditor').then((m) => ({ default: m.VectorEditor })),
);
const Publisher = lazy(() =>
  import('@/components/desktop/apps/Publisher').then((m) => ({ default: m.Publisher })),
);
const CAD = lazy(() =>
  import('@/components/desktop/apps/CAD').then((m) => ({ default: m.CAD })),
);
const Terminal = lazy(() =>
  import('@/components/desktop/apps/Terminal').then((m) => ({ default: m.Terminal })),
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
const Assistant = lazy(() =>
  import('@/components/desktop/apps/Assistant').then((m) => ({ default: m.Assistant })),
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
  {
    id: 'file-browser',
    name: 'Files',
    icon: '/icons/apps/file-browser.png',
    component: FileBrowser,
    defaultSize: { width: 880, height: 600 },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    icon: '/icons/apps/terminal.png',
    component: Terminal,
    defaultSize: { width: 760, height: 480 },
  },
  {
    // Plain text and code, VS Code style: a folder, tabs, quick open and
    // search across files. Files opens text files here; launch params
    // `{ path }` open one, `{ folder }` a folder, `{ blank: true }` nothing;
    // none reopens the last folder.
    id: 'text-editor',
    name: 'Text Editor',
    icon: '/icons/apps/text-editor.png',
    component: TextEditor,
    defaultSize: { width: 1120, height: 720 },
    keywords: ['notepad', 'gedit', 'editor', 'text', 'code', 'notes', 'write', 'ide', 'vscode', 'vs code', 'programming', 'develop'],
  },
  {
    // Pictures and pixel art, MS Paint style with Kid Pix's toys. Launch
    // params `{ path }` open a picture; `{ width, height, transparent, zoom }`
    // start a new one.
    id: 'paint',
    name: 'Paint',
    icon: '/icons/apps/paint.png',
    component: Paint,
    defaultSize: { width: 960, height: 700 },
    keywords: ['mspaint', 'kid pix', 'draw', 'drawing', 'pixel art', 'sprite', 'image', 'picture', 'art'],
  },
  {
    // Layered pictures, Photoshop style: opens and saves PSDs and OpenRaster
    // (.ora). Files opens both here. Launch params `{ path }` open one;
    // `{ width, height, background, name }` start a new document (File > New
    // from another window).
    id: 'photo-editor',
    name: 'Photo Editor',
    icon: '/icons/apps/photo-editor.png',
    component: PhotoEditor,
    defaultSize: { width: 1280, height: 800 },
    keywords: ['photoshop', 'psd', 'openraster', 'ora', 'krita', 'gimp', 'photopea', 'layers', 'photo', 'retouch', 'image', 'picture', 'editor'],
  },
  {
    // Documents, Microsoft Word style: opens and saves .docx and .odt. Files
    // opens Word and OpenDocument text documents here. Launch params
    // `{ path }` open one.
    id: 'word-processor',
    name: 'Word Processor',
    icon: '/icons/apps/word-processor.png',
    component: WordProcessor,
    defaultSize: { width: 1200, height: 840 },
    keywords: ['word', 'microsoft word', 'office', 'docx', 'doc', 'odt', 'opendocument', 'writer', 'libreoffice', 'document', 'letter', 'write'],
  },
  {
    // Workbooks, Microsoft Excel style: opens and saves .xlsx, .ods and CSV.
    // Files opens Excel and OpenDocument spreadsheets here. Launch params
    // `{ path }` open one.
    id: 'spreadsheet',
    name: 'Spreadsheet',
    icon: '/icons/apps/spreadsheet.png',
    component: Spreadsheet,
    defaultSize: { width: 1200, height: 800 },
    keywords: ['excel', 'microsoft excel', 'office', 'xlsx', 'xls', 'ods', 'opendocument', 'csv', 'calc', 'libreoffice', 'sheets', 'workbook', 'formulas', 'budget'],
  },
  {
    // Presentations, Microsoft PowerPoint style: opens and saves .pptx and
    // .odp and plays slide shows. Files opens PowerPoint and OpenDocument
    // decks here. Launch params `{ path }` open one.
    id: 'slides',
    name: 'Slides',
    icon: '/icons/apps/slides.png',
    component: Slides,
    defaultSize: { width: 1280, height: 800 },
    keywords: ['powerpoint', 'microsoft powerpoint', 'office', 'pptx', 'ppt', 'odp', 'opendocument', 'keynote', 'impress', 'libreoffice', 'presentation', 'slideshow', 'deck'],
  },
  {
    // A basic calculator, and behind its Advanced switch a graphing
    // calculator with computer algebra, in place of a TI-89: exact answers,
    // solve, d, ∫, limits, matrices, graphs and tables. The window resizes
    // itself to whichever is showing.
    id: 'calculator',
    name: 'Calculator',
    icon: '/icons/apps/calculator.png',
    component: Calculator,
    defaultSize: { width: 380, height: 620 },
    keywords: ['arithmetic', 'TI-89', 'TI-84', 'graphing calculator', 'CAS', 'algebra', 'calculus', 'derivative', 'integral', 'solve', 'math', 'graph', 'homework'],
  },
  {
    // Vector art, Illustrator style: opens and saves .ai files (and PDF and
    // SVG). Files opens Illustrator files here. Launch params `{ path }` open
    // one; `{ width, height, units, mode, artboards, name }` start a new
    // document (File > New from another window).
    id: 'vector-editor',
    name: 'Vector Editor',
    icon: '/icons/apps/vector-editor.png',
    component: VectorEditor,
    defaultSize: { width: 1280, height: 820 },
    keywords: ['illustrator', 'adobe illustrator', 'ai', 'inkscape', 'vector', 'svg', 'logo', 'illustration', 'drawing', 'pen tool', 'bezier'],
  },
  {
    // Desktop publishing, InDesign style: opens Microsoft Publisher
    // documents (.pub), InDesign documents (.indd, .indt) and IDML, and saves
    // IDML. Files opens them here. Launch params `{ path }` open one.
    id: 'publisher',
    name: 'Publisher',
    icon: '/icons/apps/publisher.png',
    component: Publisher,
    defaultSize: { width: 1280, height: 840 },
    keywords: ['indesign', 'adobe indesign', 'indd', 'idml', 'microsoft publisher', 'pub', 'scribus', 'publisher', 'desktop publishing', 'layout', 'magazine', 'brochure', 'flyer'],
  },
  {
    // 2D drafting, AutoCAD style: opens DWGs (R14 to 2018) and saves
    // AutoCAD 2000 DWGs. Files opens .dwg files here. Launch params
    // `{ path }` open one; `{ new: 'imperial' | 'metric' }` start one.
    id: 'cad',
    name: 'CAD',
    icon: '/icons/apps/cad.png',
    component: CAD,
    defaultSize: { width: 1360, height: 860 },
    keywords: ['autocad', 'dwg', 'dxf', 'drafting', 'drawing', 'cad', 'draftsight', 'librecad', 'blueprint', 'floor plan', 'technical drawing'],
  },
  {
    // Conversations with OpenCode, the coding agent. One window, which
    // notifications and the menu bar's robot point at a conversation by
    // its `sessionID` launch param.
    id: 'assistant',
    name: 'Assistant',
    icon: '/icons/apps/assistant.png',
    component: Assistant,
    defaultSize: { width: 920, height: 640 },
    keywords: ['AI', 'agent', 'OpenCode', 'chat', 'robot'],
    singleInstance: true,
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: '/icons/apps/settings.png',
    component: Settings,
    defaultSize: { width: 720, height: 520 },
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
    hidden: true,
    dockAs: 'web-browser',
  },
  {
    // One file opened from Files (a picture, a video, some text). Hidden
    // from the launcher; Files opens it with the file's path in its launch
    // params. Pictures and videos give their windows icons of their own.
    id: 'preview',
    name: 'Preview',
    icon: '/icons/apps/preview.png',
    component: FileViewer,
    defaultSize: { width: 820, height: 600 },
    hidden: true,
  },
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

/** The built-in apps whose windows go under this app's Dock tile. */
export function appsDockedAs(id: string): string[] {
  return APPS.filter((app) => app.dockAs === id).map((app) => app.id);
}

/** Look up an app definition by id. */
export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((app) => app.id === id);
}

/**
 * The messages between an app (src/sdk/) and the desktop (DinAppFrame) on
 * the app's port. Internal: apps use window.din, never these. Versioned by
 * `Din.version`. Everything is structured-cloneable.
 */
import type {
  DragInfo,
  FrameStyle,
  Menu,
  MenuItem,
  Permission,
  Point,
  Rect,
  ThemeSnapshot,
  Snap,
  WindowChrome,
  AssistantSettings,
  DictationStatus,
  Edge,
} from '@/sdk/din';

/**
 * What an app's page is playing, for Din's media controls and the media
 * keys, from its `navigator.mediaSession` (src/sdk/standards.ts).
 */
export interface MediaReport {
  title: string;
  /** The artist, or what it's playing from. */
  subtitle: string;
  /** Cover art: a data: or https URL. */
  artwork: string | null;
  playing: boolean;
  canPlay: boolean;
  canPrevious: boolean;
  canNext: boolean;
  /**
   * Stopped, with something ready to play: not shown in Din's media
   * controls, but a play key pressed with nothing else playing starts it.
   */
  idle?: boolean;
}

export type MediaAction = 'play' | 'pause' | 'nexttrack' | 'previoustrack';

export interface FileTypeFilter {
  /** "Pictures", "PNG image". */
  description: string;
  /** Extensions with the dot: `['.png', '.jpg']`. */
  extensions: string[];
}

type NamedFolder = 'documents' | 'pictures' | 'music' | 'videos' | 'downloads';

/** Din's file picker, as the web's pickers ask the desktop for it. */
export interface OpenFileOptions {
  title?: string;
  types?: FileTypeFilter[];
  multiple?: boolean;
  directory?: boolean;
  /** Ask to write back to what's chosen. Default true for files. */
  writable?: boolean;
  /** A named folder of home; `startInHandle` starts beside a handle. */
  startIn?: NamedFolder;
  /** The button that picks ("Add"); Open or Select by default. */
  confirmLabel?: string;
}

/** Din's save dialog, as `showSaveFilePicker` asks the desktop for it. */
export interface SaveFileOptions {
  title?: string;
  /**
   * The types to save as. A name typed without any of these types'
   * extensions gets the chosen type's first one.
   */
  types?: FileTypeFilter[];
  suggestedName?: string;
  startIn?: NamedFolder;
}

/** A file handle as it crosses the port; the SDK wraps it in a FileSystemHandle. */
export interface HandleData {
  /** The desktop's id for this grant, unique to the app's port. */
  id: string;
  kind: 'file' | 'directory';
  name: string;
  /** Stable for the same file within the app. */
  key: string;
  path: string;
  writable: boolean;
}

/** A file's contents, read through a handle. */
export interface FileData {
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
}

/** The window as the desktop sees it, which the runtime gives the page as the web's own state. */
export interface WindowState {
  id: string;
  /** The window is the one keyboard input goes to. */
  focused: boolean;
  /** Some of the window can be seen (not minimized, not on another workspace). */
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  snapped: Snap | null;
  /** The page went fullscreen (requestFullscreen). */
  fullscreen: boolean;
  /** Where the window is on the desktop and its size, frame included, in CSS pixels. */
  bounds: Rect;
  /** The work area of the monitor it's on (the screen minus the menu bar and Dock). */
  workArea: Rect;
}

/** The theme as the desktop sends it: the snapshot, and its scheme for the runtime's `dark` class. */
export interface ThemeData extends ThemeSnapshot {
  scheme: 'light' | 'dark';
}

/** A launch, as the runtime gives it to `launchQueue`'s consumer and the Navigation API. */
export interface LaunchData {
  /** The `targetURL`: the app's URL (a shortcut's), with the launch parameters in its query. */
  url: string;
  files: HandleData[];
  /** What the window saved, to restore; null for a new window and a relaunch. */
  state: unknown;
  /** Din reopened the window on starting again, as it was before (saved state or none). */
  restored: boolean;
  opener: string | null;
}

/** The desktop's first message: everything the app reads synchronously. */
export interface Hello {
  type: 'hello';
  version: 1;
  appId: string;
  launch: LaunchData;
  state: WindowState;
  frameStyle: FrameStyle;
  theme: ThemeData;
  permissions: Permission[];
  /**
   * localStorage entries the app kept on the desktop's origin before it
   * moved out (its manifest's `migrateStorage`), to seed its own storage
   * with once. Null when there's nothing to move.
   */
  storage: Record<string, string> | null;
  /**
   * Recent-file lists the app kept on the desktop's origin, as JSON arrays of
   * `{ token, key, name, path, time }` (the manifest's `migrateRecentFiles`),
   * merged into the app's own under the same keys.
   */
  recentFiles: Record<string, string> | null;
  /** The drag going on, if one is. */
  drag: DragInfo | null;
  dictation: { available: boolean; status: DictationStatus; here: boolean };
  /** Din's assistant settings, for apps with the assistant permission. */
  assistant: AssistantSettings | null;
  /** The conversations with unread notifications, for apps with the assistant permission. */
  assistantUnread: string[];
  /** Power mode is on: the app tells the desktop where its caret is as keys are typed. */
  powerMode: boolean;
  /** For apps with fs: the URL base to load files from by path (din-file://<token>). */
  fsUrlBase: string | null;
  /** `din.system.fs` reaches only some folders (`file-folders`, the manifest's `folders`). */
  scopedFs: boolean;
}

/** What an app can ask, by method: the params, and what the reply carries. */
export interface Requests {
  'app.ready': [void, void];
  /** `appId` null: a new window of this app. */
  'app.open': [{ appId: string | null; params?: Record<string, unknown>; handles?: string[] }, void];
  'app.openFiles': [{ handles: string[] }, void];
  'app.openUrl': [{ url: string }, void];
  'app.canOpen': [{ appId: string }, boolean];
  'app.windows': [void, { id: string; title: string }[]];
  'app.saveState': [{ state: unknown }, void];
  'window.tabDragMove': [{ at: Point; label: string }, { windowId: string; at: Point } | null];
  'window.tabDragEnd': [{ at: Point }, { windowId: string; at: Point } | null];
  'files.parent': [{ handle: string }, HandleData | null];
  'files.release': [{ token: string }, void];
  'files.requestAccess': [{ paths: string[]; reason?: string }, HandleData[]];
  'assistant.setSettings': [Partial<Pick<AssistantSettings, 'enabled' | 'model'>>, void];
  'assistant.follow': [{ sessionID: string }, void];
  'assistant.viewing': [{ sessionID: string | null }, void];
  'storage.migrated': [void, void];

  'window.setTitle': [{ title: string | null }, void];
  'window.setIcon': [{ url: string | null }, void];
  'window.setAccent': [{ color: string | null }, void];
  'window.setChrome': [WindowChrome, void];
  'window.setShape': [{ shape: Rect[] | null }, void];
  /** `at` in the app's CSS pixels. */
  'window.beginMove': [{ at: Point }, void];
  'window.beginResize': [{ edge: Edge; at: Point }, void];
  /**
   * The pointer during a move or resize the page began, where the page
   * keeps it: a framed page's, or a finger's or pen's in any page (a
   * webview's mouse reaches the desktop itself): how far it has gone since,
   * in screen pixels, or `done` at the release.
   */
  'window.gesturePointer': [{ delta: Point; done: boolean }, void];
  'window.setBounds': [Partial<Rect>, void];
  'window.minimize': [void, void];
  'window.maximize': [void, void];
  'window.restore': [void, void];
  'window.focus': [void, void];
  'window.close': [void, void];
  'window.requestClose': [void, void];
  /** Whether the app has an onCloseRequest handler. */
  'window.setCloseGuard': [{ on: boolean }, void];
  /** The app's answer to a `closeRequest` push. */
  'window.closeAnswer': [{ request: number; keep: boolean }, void];
  /** A key typed into text, with power mode on: the caret, in the app's CSS pixels, and the text's color. */
  'window.typed': [{ x: number; y: number; color: string }, void];
  /** The window menu (Minimize, Maximize, workspaces…), drawn by the desktop. */
  'window.menu': [{ at: Point }, void];

  'menus.setMenuBar': [{ menus: Menu[] | null }, void];
  'menus.popup': [{ items: MenuItem[]; at: Point }, string | null];

  'files.open': [OpenFileOptions & { startInHandle?: string }, HandleData[]];
  'files.save': [SaveFileOptions & { startInHandle?: string }, HandleData | null];
  'files.read': [{ handle: string }, FileData];
  'files.write': [{ handle: string; data: ArrayBuffer | string }, void];
  'files.entries': [{ handle: string }, HandleData[]];
  'files.watch': [{ handle: string }, void];
  'files.unwatch': [{ handle: string }, void];
  'files.persist': [{ handle: string }, string];
  'files.restore': [{ token: string }, HandleData | null];
  'files.url': [{ handle: string }, string];
  'files.fromPath': [{ path: string }, HandleData];

  'media.setSession': [{ session: MediaReport | null }, void];
  'desktop.setWallpaper': [{ handle: string }, void];
  'desktop.setCursor': [{ handle: string }, void];
  'dictation.start': [{ held: boolean }, void];
  'dictation.finish': [void, void];
  'dictation.cancel': [void, void];

  /** The token is the app's own (random); the desktop refuses one already in use. */
  'drag.startFiles': [{ token: string; handles: string[]; label: string }, void];
  'drag.startPaths': [{ token: string; paths: string[]; label: string }, void];
  'drag.startTab': [{ token: string; tabType: string; state: unknown; label: string }, void];
  /** A Din drag is over the app at this point (for the desktop's drag overlay). */
  'drag.over': [{ at: Point }, void];
  'drag.accept': [{ token: string; operation: 'copy' | 'move' | 'link' }, DropResultData | null];
  /** The source's dragend: whether anything took the drop, and where it ended. */
  'drag.finish': [{ token: string; dropEffect: string; at: Point }, void];

  'clipboard.readFiles': [void, { files: HandleData[]; cut: boolean } | null];
  'clipboard.writeFiles': [{ handles: string[]; cut: boolean }, void];

  /** A page's `new Notification()`, by an id of its own; `close()` names the same id. */
  'notifications.show': [{ id: number; title: string; options: NotificationData }, void];
  'notifications.close': [{ id: number }, void];
  /** navigator.setAppBadge(): a count, a plain mark, or none. */
  'notifications.setBadge': [{ badge: number | 'flag' | null }, void];


  'nostr.getPublicKey': [void, string];
  'nostr.signEvent': [{ event: unknown }, unknown];
  'nostr.encrypt': [{ version: 'nip04' | 'nip44'; pubkey: string; text: string }, string];
  'nostr.decrypt': [{ version: 'nip04' | 'nip44'; pubkey: string; text: string }, string];
}

export type DropResultData =
  | { kind: 'files'; files: HandleData[]; operation: 'copy' | 'move' | 'link' }
  | { kind: 'tab'; tabType: string; state: unknown };

export type Method = keyof Requests;

export interface RequestMessage<M extends Method = Method> {
  type: 'request';
  id: number;
  method: M;
  params: Requests[M][0];
}

export interface ReplyMessage {
  type: 'reply';
  id: number;
  result?: unknown;
  error?: { name: string; message: string };
}

/** What the desktop tells the app unasked. */
export type Push =
  | { type: 'state'; state: WindowState }
  | { type: 'frameStyle'; style: FrameStyle }
  | { type: 'theme'; theme: ThemeData }
  | { type: 'launch'; launch: LaunchData }
  | { type: 'menuAction'; id: string }
  | { type: 'closeRequest'; request: number }
  | { type: 'moveEnd' }
  | { type: 'drag'; drag: DragInfo | null }
  | { type: 'tabDetached'; tabType: string; state: unknown; at: Point }
  | { type: 'fileChange'; handle: string; change: 'modified' | 'removed' }
  | { type: 'clipboardFiles'; has: { count: number; cut: boolean } | null }
  | { type: 'notification'; id: number; event: 'click' | 'close'; action: string | null }
  | { type: 'mediaAction'; action: MediaAction }
  | { type: 'dictation'; status: DictationStatus; here: boolean }
  | { type: 'tabHover'; at: Point | null }
  | { type: 'assistantSettings'; settings: AssistantSettings }
  | { type: 'assistantUnread'; sessionIDs: string[] }
  | { type: 'powerMode'; on: boolean };

/** What a page's Notification tells the desktop to show. */
export interface NotificationData {
  body: string;
  icon: string;
  tag: string;
  requireInteraction: boolean;
  actions: { id: string; label: string }[];
}

export type FromDesktop = Hello | ReplyMessage | Push;
export type FromApp = RequestMessage;

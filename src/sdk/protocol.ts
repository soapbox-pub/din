/**
 * The messages between an app (src/sdk/) and the desktop (DinAppFrame) on
 * the app's port. Internal: apps use window.din, never these. Versioned by
 * `Din.version`. Everything is structured-cloneable.
 */
import type {
  BlossomBlob,
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
  Edge,
  RelatedApplication,
  OpenWithApp,
} from '@/sdk/din';
import type { StoredHandle } from '@/sdk/standards';

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
   * Handles the desktop keeps for the app that its IndexedDB doesn't have
   * yet (kept before handles went there), to put in its `din-handles`
   * database under their tokens.
   */
  unstoredHandles: StoredHandle[];
  /** The drag going on, if one is. */
  drag: DragInfo | null;
  /** The files on Din's clipboard, if any are (as the `clipboardFiles` push says after). */
  clipboardFiles: { count: number; cut: boolean } | null;
  /** Whether this computer can take dictation (the runtime's SpeechRecognition). */
  dictation: { available: boolean };
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
  /** `din.fetch` reaches the hosts the manifest's `din.fetch` names. */
  fetch: boolean;
}

/** What an app can ask, by method: the params, and what the reply carries. */
export interface Requests {
  'app.ready': [void, void];
  /**
   * Launch the app at a URL (`din://<id>/`, its parameters in the query),
   * or with `self` a new window of this app, with files for its `launchQueue`.
   */
  'app.open': [{ url: string; self: boolean; handles?: string[] }, void];
  /** Open files in the desktop's app for them, or `app`, one of `app.openWithApps`'. */
  'app.openFiles': [{ handles: string[]; app?: string }, void];
  /** The installed apps that open a file, by its type (Open With). */
  'app.openWithApps': [{ handle: string }, OpenWithApp[]];
  'app.openUrl': [{ url: string }, void];
  /** The manifest's `related_applications` that can be opened now. */
  'app.relatedApps': [void, RelatedApplication[]];
  'app.saveState': [{ state: unknown }, void];
  'window.tabDragMove': [{ at: Point; label: string }, { windowId: string; at: Point } | null];
  'window.tabDragEnd': [{ at: Point }, { windowId: string; at: Point } | null];
  'files.parent': [{ handle: string }, HandleData | null];
  'files.requestAccess': [{ paths: string[]; reason?: string }, HandleData[]];
  'assistant.setSettings': [Partial<Pick<AssistantSettings, 'enabled' | 'model'>>, void];
  'assistant.follow': [{ sessionID: string }, void];
  'assistant.viewing': [{ sessionID: string | null }, void];

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
  /** A handle put in IndexedDB: keep its grant under the app's own (random) token; one in use by another app is refused. */
  'files.persist': [{ handle: string; token: string }, void];
  'files.restore': [{ token: string }, HandleData | null];
  /** These `unstoredHandles` are in the app's IndexedDB now. */
  'files.stored': [{ tokens: string[] }, void];
  'files.url': [{ handle: string }, string];
  'files.pageUrl': [{ handle: string }, string];
  'files.fromPath': [{ path: string }, HandleData];
  'files.upload': [{ handle: string }, BlossomBlob];

  'media.setSession': [{ session: MediaReport | null }, void];
  /** `din.desktop.pauseMedia()`: other media paused while `on`, resumed after. */
  'media.hold': [{ on: boolean }, void];
  'desktop.setWallpaper': [{ handle: string }, void];
  'desktop.setCursor': [{ handle: string }, void];
  /** SpeechRecognition's start(): listen until a pause, or with `continuous` until stop(). */
  'speech.start': [{ id: number; continuous: boolean }, void];
  'speech.stop': [void, void];
  'speech.abort': [void, void];

  /** The token is the app's own (random); the desktop refuses one already in use. */
  'drag.startFiles': [{ token: string; handles: string[]; label: string }, void];
  'drag.startPaths': [{ token: string; paths: string[]; label: string }, void];
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

export type DropResultData = { kind: 'files'; files: HandleData[]; operation: 'copy' | 'move' | 'link' };

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
  | { type: 'fileChange'; handle: string; change: 'modified' | 'removed' }
  | { type: 'clipboardFiles'; has: { count: number; cut: boolean } | null }
  | { type: 'notification'; id: number; event: 'click' | 'close'; action: string | null }
  | { type: 'mediaAction'; action: MediaAction }
  /** This window's SpeechRecognition: what was said, how it ended. */
  | { type: 'speech'; id: number; event: 'result'; text: string }
  | { type: 'speech'; id: number; event: 'error'; error: SpeechErrorCode; message: string }
  | { type: 'speech'; id: number; event: 'end' }
  | { type: 'tabHover'; at: Point | null }
  | { type: 'assistantSettings'; settings: AssistantSettings }
  | { type: 'assistantUnread'; sessionIDs: string[] }
  | { type: 'powerMode'; on: boolean };

/** SpeechRecognitionErrorEvent's `error`, as Din's dictation can fail. */
export type SpeechErrorCode = 'no-speech' | 'audio-capture' | 'service-not-allowed' | 'network';

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

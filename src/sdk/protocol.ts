/**
 * The messages between an app (src/sdk/) and the desktop (DinAppFrame) on
 * the app's port. Internal: apps use window.din, never these. Versioned by
 * `Din.version`. Everything is structured-cloneable.
 */
import type {
  DragInfo,
  FrameStyle,
  LaunchContext,
  Menu,
  MenuItem,
  OpenFileOptions,
  Permission,
  Point,
  Rect,
  SaveFileOptions,
  ThemeSnapshot,
  WindowChrome,
  WindowState,
  DinNotificationOptions,
  AssistantSettings,
  DictationStatus,
  Edge,
  MediaAction,
  MediaSession,
} from '@/sdk/din';

/** A file handle as it crosses the port; the SDK wraps it in a DinFileHandle. */
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

export interface AccountSnapshot {
  pubkey: string | null;
  relays: { url: string; read: boolean; write: boolean }[];
  blossom: string[];
}

/** The desktop's first message: everything the app reads synchronously. */
export interface Hello {
  type: 'hello';
  version: 1;
  appId: string;
  launch: Omit<LaunchContext, 'files'> & { files: HandleData[] };
  state: WindowState;
  frameStyle: FrameStyle;
  theme: ThemeSnapshot;
  account: AccountSnapshot;
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
  /** For apps with fs: the URL base to load files from by path (din-file://<token>). */
  fsUrlBase: string | null;
  printAvailable: boolean;
  /** `din.system.fs` reaches only some folders (`file-folders`, the manifest's `folders`). */
  scopedFs: boolean;
}

/** What an app can ask, by method: the params, and what the reply carries. */
export interface Requests {
  'app.ready': [void, void];
  'app.open': [{ appId: string; params?: Record<string, unknown>; handles?: string[] }, void];
  'app.openFiles': [{ handles: string[] }, void];
  'app.openUrl': [{ url: string }, void];
  'app.canOpen': [{ appId: string }, boolean];
  'app.windows': [void, { id: string; title: string }[]];
  'app.postToWindow': [{ windowId: string; data: unknown }, void];
  'app.sessionGet': [{ key: string }, unknown];
  'app.sessionSet': [{ key: string; value: unknown }, void];
  'window.tabDragMove': [{ at: Point; label: string }, { windowId: string; at: Point } | null];
  'window.tabDragEnd': [{ at: Point }, { windowId: string; at: Point } | null];
  'files.parent': [{ handle: string }, HandleData | null];
  'files.release': [{ token: string }, void];
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
  'window.setBounds': [Partial<Rect>, void];
  'window.minimize': [void, void];
  'window.maximize': [void, void];
  'window.restore': [void, void];
  'window.toggleMaximize': [void, void];
  'window.focus': [void, void];
  'window.close': [void, void];
  'window.requestClose': [void, void];
  /** Whether the app has an onCloseRequest handler. */
  'window.setCloseGuard': [{ on: boolean }, void];
  /** The app's answer to a `closeRequest` push. */
  'window.closeAnswer': [{ request: number; keep: boolean }, void];
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

  'media.setSession': [{ session: MediaSession | null }, void];
  'desktop.setWallpaper': [{ handle: string }, void];
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

  'notifications.show': [{ title: string; options: DinNotificationOptions }, void];
  'notifications.setBadge': [{ count: number | null }, void];

  'print.html': [{ title: string; html: string }, void];
  'print.file': [{ handle: string }, void];

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
  | { type: 'theme'; theme: ThemeSnapshot }
  | { type: 'account'; account: AccountSnapshot }
  | { type: 'launch'; launch: Omit<LaunchContext, 'files'> & { files: HandleData[] } }
  | { type: 'menuAction'; id: string }
  | { type: 'closeRequest'; request: number }
  | { type: 'moveEnd' }
  | { type: 'drag'; drag: DragInfo | null }
  | { type: 'dragEnd'; token: string; dropped: boolean; operation: 'copy' | 'move' | 'link' | null }
  | { type: 'tabDetached'; tabType: string; state: unknown; at: Point }
  | { type: 'fileChange'; handle: string; change: 'modified' | 'removed' }
  | { type: 'clipboardFiles'; has: { count: number; cut: boolean } | null }
  | { type: 'notificationAction'; tag: string | null; action: string }
  | { type: 'mediaAction'; action: MediaAction }
  | { type: 'dictation'; status: DictationStatus; here: boolean }
  | { type: 'windowMessage'; from: string; data: unknown }
  | { type: 'tabHover'; at: Point | null }
  | { type: 'assistantSettings'; settings: AssistantSettings };

export type FromDesktop = Hello | ReplyMessage | Push;
export type FromApp = RequestMessage;

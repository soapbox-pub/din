/**
 * `window.din`: the platform Din gives its apps.
 *
 * A built-in app runs at `din://<id>/` in a webview of its own, in its own
 * process, and reaches the rest of the computer only through this object.
 * Every call travels over a MessagePort to the Din desktop (`app://din`),
 * which owns the windows and decides what each app may do; apps never talk
 * to Electron. See docs/din/README.md for the overview and docs/din/*.md
 * for each area.
 *
 * Conventions:
 * - Reads of state (`din.window.state`, `din.theme.current`) are synchronous:
 *   the desktop pushes changes and the SDK keeps a copy. Each has an
 *   `onChange` that returns an unsubscribe function.
 * - Requests that the desktop answers return promises. Fire-and-forget
 *   setters (`setTitle`) return nothing and apply in order.
 * - Anything that needs a permission rejects with an error named
 *   `DinPermissionError` when the app's manifest didn't ask for it
 *   (docs/din/permissions.md).
 *
 * The implementation is src/sdk/index.ts (`connect()`), and the React
 * pieces are src/sdk/react.tsx.
 */

import type { FsBridge } from '@/lib/fs';
import type { PtyBridge } from '@/lib/pty';
import type { AssistantBridge } from '@/lib/assistant';
import type { InddBridge } from '@/lib/indd';
import type { VolumesBridge } from '@/lib/volumes';

export type Unsubscribe = () => void;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

// ---------------------------------------------------------------------------
// The whole object
// ---------------------------------------------------------------------------

export interface Din {
  /** Which version of this API the desktop speaks. */
  readonly version: 1;
  /**
   * Resolves once the desktop has said hello: until then the launch, window
   * state, theme, account and permissions read as empty, and calls queue.
   */
  readonly ready: Promise<void>;
  app: DinApp;
  window: DinWindow;
  menus: DinMenus;
  files: DinFiles;
  drag: DinDrag;
  clipboard: DinClipboard;
  theme: DinTheme;
  account: DinAccount;
  notifications: DinNotifications;
  print: DinPrint;
  media: DinMedia;
  desktop: DinDesktop;
  dictation: DinDictation;
  assistant: DinAssistant;
  permissions: DinPermissions;
  /** Privileged system bridges, present only when the manifest asks for them. */
  system: DinSystem;
}

declare global {
  interface Window {
    /** Defined by Din, before any of the page's scripts run, in every app it hosts (din:// apps, later nsites). */
    din?: Din;
  }
}

// ---------------------------------------------------------------------------
// din.app: identity, launching, lifecycle
// ---------------------------------------------------------------------------

/** Why the app (or this window) was opened. */
export interface LaunchContext {
  /** `new` for a fresh window; `relaunch` when a running single-instance app is launched again. */
  reason: 'new' | 'relaunch';
  /** App-defined launch parameters, as passed to `din.app.open()` or a shortcut. */
  params: Record<string, unknown>;
  /** Files the app was opened with (from Files, a drop on its Dock tile). Granted to it. */
  files: DinFileHandle[];
  /** The manifest shortcut that launched it, by `id`, if any. */
  shortcut: string | null;
}

export interface DinApp {
  /** The app's id: the host of its `din://` URL. */
  readonly id: string;
  /** How this window was launched. */
  readonly launch: LaunchContext;
  /**
   * A running single-instance app was launched again, or a Dock shortcut was
   * chosen. The window is already focused.
   */
  onLaunch(cb: (ctx: LaunchContext) => void): Unsubscribe;
  /**
   * The app has drawn its first useful frame: the desktop drops the window's
   * splash. Called automatically on `load` if the app never calls it.
   */
  ready(): void;
  /**
   * Launch another app (or a new window of this one) with launch
   * parameters, and files it holds for the new window to open (they arrive
   * in its `launch.files`).
   */
  open(appId: string, params?: Record<string, unknown>, files?: DinFileHandle[]): Promise<void>;
  /**
   * Open files in whichever app the desktop has for them (Files' default).
   * A Windows program (.exe) runs, through Wine.
   */
  openFiles(files: DinFileHandle[]): Promise<void>;
  /**
   * Whether an app can be opened now: it's installed, and (the Assistant)
   * set up and switched on.
   */
  canOpen(appId: string): Promise<boolean>;
  /** The app's other open windows, front to back. */
  windows(): Promise<{ id: string; title: string }[]>;
  /** Send another of the app's windows a message (structured-cloneable). */
  postToWindow(windowId: string, data: unknown): void;
  /** Hear messages from the app's other windows. */
  onWindowMessage(cb: (from: string, data: unknown) => void): Unsubscribe;
  /**
   * State the desktop keeps for the app for as long as it runs, across its
   * windows opening and closing (Files' undo history). Not saved to disk.
   */
  session: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): void;
  };
  /** Open a URL in the Web Browser (or the app that handles its scheme). */
  openUrl(url: string): Promise<void>;
  /**
   * localStorage keys this app kept on the desktop's origin before it moved
   * out are copied in before the app's code runs (the manifest's
   * `migrateStorage`); nothing to call.
   */
}

// ---------------------------------------------------------------------------
// din.window: the app's window and how it's drawn
// ---------------------------------------------------------------------------

/** Where a window's edge is grabbed to resize it. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface WindowState {
  /** The window's id, unique on this desktop. */
  readonly id: string;
  /** The window is the one keyboard input goes to. */
  focused: boolean;
  /** Some of the window can be seen (not minimized, not on another workspace). */
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  /** Half-screen tile, or null. */
  snapped: 'left' | 'right' | null;
  /** The page went fullscreen (requestFullscreen). */
  fullscreen: boolean;
  /** Where the window is on the desktop and its size, frame included, in CSS pixels. */
  bounds: Rect;
  /** The work area of the monitor it's on (the screen minus the menu bar and Dock). */
  workArea: Rect;
}

/** How much of the window Din draws. docs/din/window.md has pictures. */
export type FrameMode =
  /** Din's title bar, frame, shadow and resize handles; the app draws the contents. */
  | 'standard'
  /**
   * Din's frame, rounded corners, shadow and resize handles; the app lays out
   * the whole header with `<WindowDragRegion>` and `<WindowControls>` from
   * the SDK (a sidebar running to the top, tabs in the title bar).
   */
  | 'custom'
  /** Nothing: the app's pixels are the window, at any shape (skins). */
  | 'none';

/**
 * How the window is drawn. The page itself is always transparent where it
 * doesn't paint: a `standard` or `custom` window has the desktop's frosted
 * background behind it, a `none` window nothing.
 */
export interface WindowChrome {
  frame: FrameMode;
}

/** The look of the title bar, for SDK pieces drawn inside the app. */
export interface FrameStyle {
  /** The accent tinting the title bar (sanitized), or null. */
  accent: string | null;
  /** Whether the title bar is dark (light text and icons). */
  dark: boolean;
}

export interface DinWindow {
  /** Pushed by the desktop; always current. */
  readonly state: WindowState;
  onChange(cb: (state: WindowState) => void): Unsubscribe;

  /** What the window is showing ("Untitled.png"), or null for the app's name. */
  setTitle(title: string | null): void;
  /** An icon for what it's showing (a data: or https URL, or a root path of Din's public files like `/icons/…`), or null for the app's. */
  setIcon(url: string | null): void;
  /** Tint the title bar (a CSS color, e.g. a page's theme-color), or null. */
  setAccent(color: string | null): void;
  /** Title-bar look for `custom` frames, following the accent. */
  readonly frameStyle: FrameStyle;
  onFrameStyleChange(cb: (style: FrameStyle) => void): Unsubscribe;

  /** How the window is drawn. Takes effect on the next frame; the manifest sets the first value. */
  setChrome(chrome: WindowChrome): void;
  /**
   * The part of the window that exists: drawn, and taking clicks. Clicks
   * outside it go to whatever is behind. Rectangles in window coordinates;
   * null for the whole window. Meant for `frame: 'none'`.
   */
  setShape(shape: Rect[] | null): void;

  /**
   * Start moving the window from a pointerdown inside the app (what
   * `<WindowDragRegion>` does). The desktop follows the pointer until it's
   * released, with the same snapping, tear-off and wobble as the title bar.
   * Resolves when it's released (the app never sees that release itself),
   * or at once if the window can't move now.
   */
  beginMove(e: PointerEvent): Promise<void>;
  /** Start resizing from an edge, as `beginMove` (skins with their own grips). */
  beginResize(edge: Edge, e: PointerEvent): Promise<void>;
  /** Move or resize; clamped to the work area and the min/max size. */
  setBounds(bounds: Partial<Rect>): void;

  minimize(): void;
  maximize(): void;
  /** Un-maximize or un-tile. */
  restore(): void;
  toggleMaximize(): void;
  focus(): void;
  /** Close this window. Doesn't consult its own `onCloseRequest`. */
  close(): void;
  /** Close it as the user would (`<WindowControls>`' close button): through `onCloseRequest`. */
  requestClose(): void;
  /**
   * Din's window menu (Minimize, Maximize, tiling, workspaces, Close) at a
   * point in the window: what right-clicking a title bar opens.
   * `<WindowDragRegion>` does this itself.
   */
  showWindowMenu(at: Point): void;
  /**
   * A tab being dragged off this window's tab strip, at a point in this
   * window (the strip keeps the pointer captured). The desktop shows its
   * label under the pointer, and says which of the app's windows is
   * frontmost there, with the point in that window; that window hears
   * `onTabHover`. Null over anything else.
   */
  tabDragMove(at: Point, label: string): Promise<{ windowId: string; at: Point } | null>;
  /** The drag ended at this point: where it landed, as for `tabDragMove`. The label goes. */
  tabDragEnd(at: Point): Promise<{ windowId: string; at: Point } | null>;
  /** Another window's tab is dragged over this one (at a point in it), or no longer (null). */
  onTabHover(cb: (at: Point | null) => void): Unsubscribe;
  /**
   * Have a say when the user (or the desktop) closes the window. Return true
   * to keep it open: the app then asks its question ("Save changes?") and
   * calls `close()` itself if it should go. Must answer quickly; an app that
   * doesn't is offered for force quitting. One handler; a second replaces it.
   */
  onCloseRequest(handler: (() => boolean) | null): void;
}

// ---------------------------------------------------------------------------
// din.menus: the menu bar and menus that leave the window
// ---------------------------------------------------------------------------

export interface MenuItemBase {
  /** Reported to `onAction` when chosen. Unique within the app's menus. */
  id: string;
  label: string;
  enabled?: boolean;
  /** Shown beside the label and bound while the window is focused, e.g. `Ctrl+S`. */
  accelerator?: string;
  /**
   * Leave the accelerator to a text field that has focus (a search box's
   * Ctrl+F, a field's Ctrl+A). Shown in the menu either way.
   */
  notInFields?: boolean;
  /** An image: a data: URL, https, or a root path of Din's public files (`/icons/…`). */
  icon?: string;
  /** Drawn in the destructive color (Delete, Close Without Saving). */
  destructive?: boolean;
}

export type MenuItem =
  | (MenuItemBase & { type?: 'normal' })
  | (MenuItemBase & { type: 'checkbox'; checked: boolean })
  | (MenuItemBase & { type: 'radio'; checked: boolean; group: string })
  | (MenuItemBase & { type: 'submenu'; items: MenuItem[] })
  | { type: 'separator' }
  | { type: 'label'; label: string };

export interface Menu {
  /** File, Edit, View… */
  label: string;
  items: MenuItem[];
}

export interface DinMenus {
  /**
   * The app's menus in Din's menu bar, shown while one of its windows is
   * focused. Replaces the whole set; null for none. Accelerators are bound
   * by the desktop, so they work wherever focus is in the window.
   */
  setMenuBar(menus: Menu[] | null): void;
  /**
   * A menu drawn by the desktop at a point in the window, free to extend
   * past its edges. Resolves with the chosen item's id, or null. Menus that
   * fit inside the window can be drawn by the app itself.
   */
  popup(items: MenuItem[], at: Point): Promise<string | null>;
  /** A menu-bar item (or its accelerator) was chosen. */
  onAction(cb: (id: string) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// din.files: files the user hands the app
// ---------------------------------------------------------------------------

/**
 * A file the app was given: picked, dropped, launched with, or saved as. A
 * handle is a capability: having one is what lets the app read or write that
 * file and nothing else. Handles last as long as the window; `persist()`
 * keeps one for Recent Files.
 */
export interface DinFileHandle {
  readonly kind: 'file' | 'directory';
  /** The file's name, e.g. `holiday.png`. */
  readonly name: string;
  /** Opaque and stable for the same file within the app; for comparing handles. */
  readonly key: string;
  /**
   * Its full path, to show (a Recent list's folder, Copy Path). Knowing it
   * grants nothing: reaching a file by path takes `fs` or `file-folders`.
   */
  readonly path: string;
  /** Read the whole file. */
  getFile(): Promise<File>;
  /**
   * A URL the app can load the file from (an `<img>`, `<audio>`, `<video>`,
   * or `fetch` with Range requests), streamed rather than sent whole. Good
   * while this page stays loaded. Not available outside Electron.
   */
  url(): Promise<string>;
  /** Replace its contents (and create it, for a handle from `save`). Needs `writable`. */
  write(data: Blob | ArrayBuffer | ArrayBufferView | string): Promise<void>;
  /** Whether `write` is allowed. False for files opened read-only. */
  readonly writable: boolean;
  /** Hear when something else changes or removes the file. */
  onChange(cb: (change: 'modified' | 'removed') => void): Unsubscribe;
  /**
   * For apps with `file-folders`: the folder a file is in, as a handle (and
   * `din.system.fs` reaches it by path). Null without the permission, and
   * for a folder (whose parent the user didn't hand over).
   */
  parent(): Promise<DinFileHandle | null>;
  /** Directories only: the entries, as handles granted along with it. */
  entries?(): Promise<DinFileHandle[]>;
  /** Keep the grant across restarts; resolves with a token for `din.files.restore`. */
  persist(): Promise<string>;
}

export interface FileTypeFilter {
  /** "Pictures", "PNG image". */
  description: string;
  /** Extensions with the dot: `['.png', '.jpg']`. */
  extensions: string[];
}

export interface OpenFileOptions {
  title?: string;
  types?: FileTypeFilter[];
  multiple?: boolean;
  directory?: boolean;
  /** Ask to write back to what's chosen. Default true for files. */
  writable?: boolean;
  /** Start in this folder, beside this file, or in a named folder of home. */
  startIn?: DinFileHandle | 'documents' | 'pictures' | 'music' | 'videos' | 'downloads';
  /** The button that picks ("Add"); Open or Select by default. */
  confirmLabel?: string;
}

export interface SaveFileOptions {
  title?: string;
  /**
   * The types to save as. A name typed without any of these types'
   * extensions gets the chosen type's first one.
   */
  types?: FileTypeFilter[];
  suggestedName?: string;
  startIn?: OpenFileOptions['startIn'];
}

export interface DinFiles {
  /** Din's file picker. Resolves with what was chosen, or an empty array if cancelled. */
  open(options?: OpenFileOptions): Promise<DinFileHandle[]>;
  /** Din's save dialog. Resolves with a writable handle, or null if cancelled. */
  save(options?: SaveFileOptions): Promise<DinFileHandle | null>;
  /** A handle kept by `persist()`; null if the file is gone or the grant was revoked. */
  restore(token: string): Promise<DinFileHandle | null>;
  /** Forget a `persist()` token the app no longer keeps (a Recent entry removed). */
  release(token: string): void;
  /**
   * Files and folders by path that nothing granted the app: songs a playlist
   * names elsewhere, folders its saved state lists. Resolves with handles for
   * those it may have (and, with `file-folders`, their folders come into
   * reach). On an app's first launch after it moved out of the desktop,
   * paths its own saved state named then are granted without asking;
   * otherwise the desktop asks the user, giving `reason`. Missing paths are
   * left out.
   */
  requestAccess(paths: string[], reason?: string): Promise<DinFileHandle[]>;
  /**
   * A handle for a path, for apps with `fs`, which reach files by path
   * anyway (`din.system.fs`) but want a handle's `url()` or to hand the
   * file to another app.
   */
  fromPath(path: string): Promise<DinFileHandle>;
  /**
   * A URL to load a file from by path, for apps with `fs`: no round trip,
   * so cheap enough for a folder of thumbnails. Throws without `fs`, and
   * outside Electron.
   */
  pathUrl(path: string): string;
}

// ---------------------------------------------------------------------------
// din.drag: drag and drop between apps, brokered by the desktop
// ---------------------------------------------------------------------------

/** What's being dragged, as every app can see it during the drag. */
export interface DragInfo {
  kind: 'files' | 'tab';
  /** The app it came from. */
  source: string;
  /** For `files`: how many, and whether they're all folders. Names only after the drop. */
  count: number;
  folders: boolean;
  /** For `tab`: the app-defined type of tab (`terminal`, `editor`). */
  tabType?: string;
}

/** What a drop hands the target. */
export type DropResult =
  | { kind: 'files'; files: DinFileHandle[]; operation: 'copy' | 'move' | 'link' }
  | { kind: 'tab'; tabType: string; state: unknown };

export interface DinDrag {
  /**
   * Call from `dragstart` to drag files out of the app. Sets the drag's data
   * (the token, and plain text for other targets) and its drag image.
   */
  startFiles(e: DragEvent, files: DinFileHandle[], label: string): void;
  /**
   * The same, by path, for apps with `fs`: no handles to wait for, which a
   * dragstart can't do.
   */
  startPaths(e: DragEvent, paths: string[], label: string): void;
  /**
   * Call from `dragstart` to drag a tab out. `state` is what a window that
   * accepts it gets, structured-cloneable; if it's dropped outside every
   * window, `onTabDetached` asks the source to open it in a new window.
   */
  startTab(e: DragEvent, tabType: string, state: unknown, label: string): void;
  /** The drag going on anywhere on the desktop, or null. */
  readonly current: DragInfo | null;
  onChange(cb: (drag: DragInfo | null) => void): Unsubscribe;
  /**
   * Take a drop. Call from `drop` with the event; resolves with what was
   * dropped, or null if the event isn't a Din drag (then read the
   * DataTransfer as usual, for files and text from web pages).
   */
  accept(e: DragEvent, operation?: 'copy' | 'move' | 'link'): Promise<DropResult | null>;
  /** The drag this app started finished: where it went, so a move can drop the original. */
  onEnd(cb: (result: { token: string; dropped: boolean; operation: 'copy' | 'move' | 'link' | null }) => void): Unsubscribe;
  /** A tab this app was dragging was dropped outside every window. */
  onTabDetached(cb: (e: { tabType: string; state: unknown; at: Point }) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// din.clipboard: cut, copy and paste of files
// ---------------------------------------------------------------------------

export interface DinClipboard {
  /**
   * Files on Din's clipboard, as Cut or Copy left them. Text and images use
   * navigator.clipboard. Without `fs`, only on a paste: within a few seconds
   * of a key or click in the focused window, or a pick from its menus;
   * otherwise it rejects with `NotAllowedError`.
   */
  readFiles(): Promise<{ files: DinFileHandle[]; cut: boolean } | null>;
  writeFiles(files: DinFileHandle[], cut: boolean): void;
  /** Whether files are on the clipboard (for enabling Paste), and from now on when that changes. */
  onFilesChange(cb: (has: { count: number; cut: boolean } | null) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// din.theme: the desktop's look, applied to the app
// ---------------------------------------------------------------------------

export interface ThemeSnapshot {
  scheme: 'light' | 'dark';
  /**
   * Din's design tokens as CSS custom properties without the `--`
   * (`background`, `foreground`, `primary`, `radius`, …), as the desktop
   * computes them, profile theme included. The SDK sets them on `:root`, so
   * Tailwind classes match the desktop's out of the box.
   */
  tokens: Record<string, string>;
  /** A profile theme's web fonts, which the SDK loads. */
  fontFaces: { family: string; url: string }[];
  /** The desktop's interface zoom. The desktop already scales the window; for canvas apps. */
  zoom: number;
  /** The user prefers reduced motion. */
  reducedMotion: boolean;
}

export interface DinTheme {
  readonly current: ThemeSnapshot;
  onChange(cb: (theme: ThemeSnapshot) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// din.account: who's signed in
// ---------------------------------------------------------------------------

export interface DinAccount {
  /** Hex pubkey of the signed-in user, or null. Needs `account`. */
  readonly pubkey: string | null;
  /** The user's NIP-65 relays. */
  readonly relays: { url: string; read: boolean; write: boolean }[];
  /** The user's Blossom servers. */
  readonly blossom: string[];
  onChange(cb: () => void): Unsubscribe;
  /**
   * NIP-07, backed by Din's signer and its prompts. Needs `nostr`; the SDK
   * also installs it as `window.nostr`.
   */
  readonly nostr: Nip07 | null;
}

export interface NostrEventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

export interface SignedNostrEvent extends NostrEventTemplate {
  id: string;
  pubkey: string;
  sig: string;
}

export interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: NostrEventTemplate): Promise<SignedNostrEvent>;
  nip04: { encrypt(pubkey: string, text: string): Promise<string>; decrypt(pubkey: string, text: string): Promise<string> };
  nip44: { encrypt(pubkey: string, text: string): Promise<string>; decrypt(pubkey: string, text: string): Promise<string> };
}

// ---------------------------------------------------------------------------
// din.notifications
// ---------------------------------------------------------------------------

export interface DinNotificationOptions {
  body?: string;
  icon?: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
  /** Buttons on the notification; their ids come back through `onAction`. */
  actions?: { id: string; label: string }[];
  /** A short-lived toast that never goes to the notification center. */
  transient?: boolean;
}

export interface DinNotifications {
  show(title: string, options?: DinNotificationOptions): Promise<void>;
  /** A notification (or one of its buttons, by id; `default` for the body) was clicked. */
  onAction(cb: (e: { tag: string | null; action: string }) => void): Unsubscribe;
  /** A number on the app's Dock tile, or null to clear it. */
  setBadge(count: number | null): void;
}

// ---------------------------------------------------------------------------
// din.media (permission `media-session`)
// ---------------------------------------------------------------------------

/** What an app is playing, for Din's media controls and the media keys. */
export interface MediaSession {
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
   * controls, but a play key pressed with nothing else playing starts it
   * (`onAction('play')`), as a music player does.
   */
  idle?: boolean;
}

export type MediaAction = 'play' | 'pause' | 'nexttrack' | 'previoustrack';

export interface DinMedia {
  /** What's playing now, or null when nothing is (the controls go). */
  setSession(session: MediaSession | null): void;
  /**
   * Din's media controls or a media key. `play` also comes when a play key
   * is pressed with nothing else playing and the session can play.
   */
  onAction(cb: (action: MediaAction) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// din.desktop (permissions `wallpaper` and `cursor`)
// ---------------------------------------------------------------------------

export interface DinDesktop {
  /** Make a picture the app holds the desktop's background. */
  setWallpaper(file: DinFileHandle): Promise<void>;
  /**
   * Install the cursor theme in a file the app holds (a .CurXPTheme,
   * .CursorFX, .cape, an archive of a theme…) and make it the pointer, as
   * Settings' Import does. Rejects with why when the file isn't one, or
   * when Din can't change the cursor on this system.
   */
  setCursor(file: DinFileHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// din.dictation: speech to text, into the app's focused field
// ---------------------------------------------------------------------------

export type DictationStatus = 'idle' | 'listening' | 'transcribing' | 'error';

export interface DinDictation {
  /** Whether this computer can take dictation. */
  readonly available: boolean;
  readonly status: DictationStatus;
  /** Whether what's being dictated goes into this window (from its mic button, or Din's dictation key). */
  readonly here: boolean;
  onStatus(cb: (status: DictationStatus) => void): Unsubscribe;
  /**
   * Listen, and type what's said into the field focused in the app when it
   * finishes (as Din's dictation key does). `held`: stops when `finish()`
   * is called rather than at a pause.
   */
  start(options?: { held?: boolean }): Promise<void>;
  finish(): Promise<void>;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// din.assistant (permission `assistant`): the desktop's side of the assistant
// ---------------------------------------------------------------------------

/** Din's assistant settings (Settings > Assistant), which the desktop keeps. */
export interface AssistantSettings {
  enabled: boolean;
  /** The folder new conversations work in; '' for the home folder. */
  directory: string;
  colorfulReplies: boolean;
  /** The model new conversations use, if one was chosen. */
  model: { id: string; providerID: string } | null;
}

/**
 * For apps that show the assistant (the Assistant, CAD's palette): Din's
 * settings for it, and what the desktop needs to know to notify well. The
 * desktop announces requests, questions and finished turns for
 * conversations Din started, unless the user is looking at that one.
 */
export interface DinAssistant {
  readonly settings: AssistantSettings;
  onSettingsChange(cb: (settings: AssistantSettings) => void): Unsubscribe;
  /** Change the ones the app offers (switching it on, choosing a model). */
  setSettings(patch: Partial<Pick<AssistantSettings, 'enabled' | 'model'>>): void;
  /** A conversation the app started or wrote in, which Din then follows. */
  follow(sessionID: string): void;
  /** The conversation this window shows now, or null. */
  setViewing(sessionID: string | null): void;
}

// ---------------------------------------------------------------------------
// din.print (permission `printing`)
// ---------------------------------------------------------------------------

export interface DinPrint {
  /** Whether this computer can print (has a print service). */
  readonly available: boolean;
  /** Din's print dialog for a document, as HTML (with its own styles inline). */
  html(title: string, html: string): Promise<void>;
  /** Din's print dialog for a file the app holds (a PDF, a picture, text). */
  file(file: DinFileHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// din.permissions and din.system
// ---------------------------------------------------------------------------

/**
 * What an app can ask for in its manifest's `din.permissions`. Everything
 * not listed here, every app has (its own window, files it's handed, the
 * theme). docs/din/permissions.md says what each grants.
 */
export type Permission =
  /** The user's pubkey, relays and Blossom servers. */
  | 'account'
  /** Sign, encrypt and decrypt as the user, through Din's prompts. Implies `account`. */
  | 'nostr'
  /** The whole filesystem, by path (`din.system.fs`). Files, Text Editor. */
  | 'fs'
  /** Terminals (`din.system.pty`). Terminal. */
  | 'pty'
  /** Print documents (`din.print`). */
  | 'printing'
  /** Notifications kept in the notification center, and a Dock badge. Toasts need nothing. */
  | 'notifications'
  /** Report what's playing and hear the media keys (`din.media`). */
  | 'media-session'
  /** Set the desktop wallpaper (`din.desktop`). */
  | 'wallpaper'
  /** Install cursor themes and change the pointer (`din.desktop.setCursor`). */
  | 'cursor'
  /** The Assistant's OpenCode service (`din.system.assistant`). Assistant, CAD. */
  | 'assistant'
  /** InDesign conversion (`din.system.indd`). Publisher. */
  | 'indd'
  /** Removable disks: list, mount, eject (`din.system.volumes`). Files. */
  | 'volumes'
  /**
   * `din.system.fs` scoped to the folders of the files the user handed the
   * app (opened, saved, dropped, launched with), and `handle.parent()`.
   * Preview (stepping through a folder, archives), Publisher (linked
   * pictures). Apps that need fixed folders instead list them in their
   * manifest's `din.folders`.
   */
  | 'file-folders';

export interface DinPermissions {
  /** Whether the manifest asked for it and the desktop granted it. */
  has(permission: Permission): boolean;
}

/**
 * The desktop's own bridges (`window.dinos` namespaces), for the few apps
 * whose job they are. Each is present only with its permission, and talks
 * to Electron main over a port of its own that the desktop had main make
 * for this app, so it's as fast as the desktop's own. Functions that take
 * callbacks work as on the desktop. Absent outside Electron.
 */
export interface DinSystem {
  fs?: FsBridge;
  /**
   * Terminals. `release` lets go of one for another window of the app to
   * `adopt` (a tab moving between windows); its output waits meanwhile, and
   * it ends if nobody adopts it within 15 seconds.
   */
  pty?: PtyBridge & { release(id: number): Promise<string>; adopt(token: string): Promise<number> };
  assistant?: AssistantBridge;
  indd?: InddBridge;
  volumes?: VolumesBridge;
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * An app's `manifest.webmanifest`: a W3C web app manifest with a `din`
 * section. docs/din/manifest.md.
 */
export interface DinManifest {
  name: string;
  short_name?: string;
  description?: string;
  /** The app's icons; Din uses the largest square one. */
  icons: { src: string; sizes?: string; type?: string; purpose?: string }[];
  /** The page to load; defaults to `/`. */
  start_url?: string;
  theme_color?: string;
  background_color?: string;
  /** Dock and launcher shortcuts. A shortcut's `din.params` become the launch params. */
  shortcuts?: {
    name: string;
    url: string;
    din?: { id: string; params?: Record<string, unknown> };
  }[];
  /** File types Files opens in this app. */
  file_handlers?: { action: string; accept: Record<string, string[]>; din?: { default?: boolean } }[];
  /**
   * `nostr:` links this app opens: `url` has `%s` for the link, and `kinds`
   * (Din's addition) lists the event kinds it shows, every kind when absent.
   * Only `protocol: "nostr"` counts.
   */
  protocol_handlers?: { protocol: string; url: string; kinds?: number[] }[];
  /** `focus-existing` makes the app single-instance. */
  launch_handler?: { client_mode: 'navigate-new' | 'focus-existing' };
  din: {
    /** What the app needs beyond the basics. */
    permissions?: Permission[];
    /** The first window's size, and its chrome until the app sets its own. */
    window?: { size?: Size; floating?: boolean } & Partial<WindowChrome>;
    /** Extra terms the launcher's search matches. */
    keywords?: string[];
    /** Resolvable but not in the launcher (Preview, Developer Tools). */
    hidden?: boolean;
    /** Windows go under this app's Dock tile. */
    dockAs?: string;
    /**
     * localStorage keys (a trailing `*` matches a prefix) the app kept on the
     * desktop's origin before it moved out. The desktop copies them into the
     * app's storage before its first launch, once.
     */
    migrateStorage?: string[];
    /**
     * Folders the app reaches by path through `din.system.fs` without the
     * whole filesystem: `~/Music`, `~/.local/share/din/skins`. Created if
     * missing. Media Player.
     */
    folders?: string[];
    /**
     * Recent-file lists the app kept on the desktop's origin, as JSON arrays
     * of `{ path, time }` under these keys. The desktop turns each entry it
     * can still find into `{ token, key, name, path, time }` (a `persist()`
     * token) in the app's storage, once.
     */
    migrateRecentFiles?: string[];
    /**
     * Files the app kept elsewhere before it moved, to copy once into its
     * folders: `{ "~/.local/share/din/x.json": "~/.local/share/din/app/x.json" }`.
     * Copied on a launch when the destination is missing; paths they name
     * count as the app's saved state for `din.files.requestAccess`.
     */
    migrateFiles?: Record<string, string>;
  };
}

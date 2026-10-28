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
 * - Anything that needs a permission throws `DinPermissionError` when the
 *   app's manifest didn't ask for it (docs/din/permissions.md).
 */

import type { FsBridge } from '@/lib/fs';
import type { PtyBridge } from '@/lib/pty';
import type { PrintingBridge } from '@/lib/printing';

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
  app: DinApp;
  window: DinWindow;
  menus: DinMenus;
  files: DinFiles;
  drag: DinDrag;
  clipboard: DinClipboard;
  theme: DinTheme;
  account: DinAccount;
  notifications: DinNotifications;
  permissions: DinPermissions;
  /** Privileged system bridges, present only when the manifest asks for them. */
  system: DinSystem;
}

declare global {
  interface Window {
    /** Present in apps Din hosts (din:// apps, later nsites). */
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
  /** Launch another app (or a new window of this one) with launch parameters. */
  open(appId: string, params?: Record<string, unknown>): Promise<void>;
  /** Open files in whichever app the desktop has for them (Files' default). */
  openFiles(files: DinFileHandle[]): Promise<void>;
  /** Open a URL in the Web Browser (or the app that handles its scheme). */
  openUrl(url: string): Promise<void>;
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
  /** The window's content area on the desktop, in CSS pixels. */
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

export interface WindowChrome {
  frame: FrameMode;
  /**
   * `transparent` lets the desktop show through wherever the page doesn't
   * paint. `custom` windows default to opaque, `none` windows to transparent.
   */
  background?: 'opaque' | 'transparent';
  /** Din's soft window shadow. Default: true unless `frame` is `none`. */
  shadow?: boolean;
  /** Whether the user can resize it. Default true. */
  resizable?: boolean;
  minSize?: Size;
  maxSize?: Size;
  /** Width over height, kept while resizing. */
  aspectRatio?: number;
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
  /** An icon for what it's showing (a data: or din: URL), or null for the app's. */
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
   */
  beginMove(e: PointerEvent): void;
  /** Start resizing from an edge, as `beginMove` (skins with their own grips). */
  beginResize(edge: Edge, e: PointerEvent): void;
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
  /**
   * Have a say when the user (or the desktop) closes the window. Return true
   * to keep it open: the app then asks its question ("Save changes?") and
   * calls `close()` itself if it should go. Must answer quickly; an app that
   * doesn't is offered for force quitting. One handler; a second replaces it.
   */
  onCloseRequest(handler: (() => boolean) | null): void;

  /** Open a new window of this app, as a child that follows this one (a pop-up tool). */
  openChild(params?: Record<string, unknown>, size?: Size): Promise<void>;
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
  /** A lucide icon name, or a data:/din: URL. */
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
  /** Its full path, only for apps with the `fs` permission; null otherwise. */
  readonly path: string | null;
  /** Read the whole file. */
  getFile(): Promise<File>;
  /** Replace its contents (and create it, for a handle from `save`). Needs `writable`. */
  write(data: Blob | BufferSource | string): Promise<void>;
  /** Whether `write` is allowed. False for files opened read-only. */
  readonly writable: boolean;
  /** Hear when something else changes or removes the file. */
  onChange(cb: (change: 'modified' | 'removed') => void): Unsubscribe;
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
  /** Start next to this file. */
  startIn?: DinFileHandle | 'documents' | 'pictures' | 'music' | 'videos' | 'downloads';
}

export interface SaveFileOptions {
  title?: string;
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
  /** Add to Din's recent files (Files' Recent, the Dock tile's menu). */
  addRecent(file: DinFileHandle): void;
}

// ---------------------------------------------------------------------------
// din.drag: drag and drop between apps, brokered by the desktop
// ---------------------------------------------------------------------------

/** What's being dragged, as every app can see it during the drag. */
export interface DragInfo {
  /** Opaque, unique to this drag; also in the DataTransfer under `application/x-din-drag`. */
  token: string;
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
  /** Files on Din's clipboard, as Cut or Copy left them. Text and images use navigator.clipboard. */
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
   * (`background`, `foreground`, `primary`, `radius`, …). The SDK sets them
   * on `:root`, so Tailwind classes match the desktop's out of the box.
   */
  tokens: Record<string, string>;
  /** The UI font stack and the monospace one. */
  fonts: { sans: string; mono: string };
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
  /** Print documents (`din.system.printing`). */
  | 'printing'
  /** Notifications kept in the notification center, and a Dock badge. Toasts need nothing. */
  | 'notifications'
  /** Report what's playing and hear the media keys. */
  | 'media-session'
  /** Set the desktop wallpaper. */
  | 'wallpaper';

export interface DinPermissions {
  /** Whether the manifest asked for it and the desktop granted it. */
  has(permission: Permission): boolean;
}

export class DinPermissionError extends Error {
  readonly permission: Permission;
}

/**
 * The desktop's own bridges (`window.dinos` namespaces), for the few apps
 * whose job they are. Each is present only with its permission, and talks
 * to Electron main over a port of its own that the desktop had main make
 * for this app, so it's as fast as the desktop's own. Functions that take
 * callbacks work as on the desktop.
 */
export interface DinSystem {
  fs?: FsBridge;
  pty?: PtyBridge;
  printing?: PrintingBridge;
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
  };
}

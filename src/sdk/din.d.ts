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
 * - Reads of state (`din.window.snapped`, `din.theme.current`) are synchronous:
 *   the desktop pushes changes and the SDK keeps a copy. Each has an
 *   `onChange` that returns an unsubscribe function.
 * - Requests that the desktop answers return promises. Fire-and-forget
 *   setters (`setChrome`) return nothing and apply in order.
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
import type { MailBridge } from '@/lib/mail';
import type { VolumesBridge } from '@/lib/volumes';
import type { DriveSetupBridge } from '@/lib/drive';
import type { PasswordsBridge } from '@/lib/passwords';
import type { PhoneAppBridge } from '@/lib/phone';
import type { VmsBridge } from '@/lib/vms';
import type { GamesBridge } from '@/lib/games';
import type { CaptureBridge } from '@/lib/capture';

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
   * state, theme and permissions read as empty, and calls queue.
   */
  readonly ready: Promise<void>;
  app: DinApp;
  window: DinWindow;
  menus: DinMenus;
  files: DinFiles;
  drag: DinDrag;
  clipboard: DinClipboard;
  theme: DinTheme;
  desktop: DinDesktop;
  assistant: DinAssistant;
  /** Privileged system bridges, present only when the manifest asks for them. */
  system: DinSystem;
  /**
   * `fetch`, for the hosts the manifest's `din.fetch` names, without CORS:
   * the response's body and headers are the app's to read whatever the
   * server sends. https only, anonymous (no cookies are sent or kept), never
   * the local network, at most 8 requests in flight. Anything else, or an
   * app whose manifest names no hosts, rejects (`TypeError`, or
   * `DinPermissionError` without the grant).
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** One of `navigator.getInstalledRelatedApps()`'s answers (Getting Installed Related Apps). */
export interface RelatedApplication {
  platform: string;
  url?: string;
  id?: string;
}

declare global {
  interface Navigator {
    /** The manifest's `related_applications` that are installed and can be opened now. */
    getInstalledRelatedApps(): Promise<RelatedApplication[]>;
  }
  interface Window {
    /** Defined by Din, before any of the page's scripts run, in every app it hosts (din:// apps, later nsites). */
    din?: Din;
    /**
     * From the web's Additional Windowing Controls draft, on the app's own
     * window: as the title bar's buttons. `restore` brings a minimized
     * window back, and un-maximizes or un-tiles one that isn't.
     */
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    restore(): Promise<void>;
  }
  /** Where the work area starts, beside `availWidth` and `availHeight` (every engine has them; TypeScript's DOM types don't). */
  interface Screen {
    readonly availLeft: number;
    readonly availTop: number;
  }
}

// ---------------------------------------------------------------------------
// din.app: identity, launching, lifecycle
// ---------------------------------------------------------------------------

/**
 * A window's launches come to the web's `launchQueue` consumer (Launch
 * Handling): its own first, then each time a running single-instance app is
 * launched again or a Dock shortcut is chosen (the window already focused).
 * The launch parameters are the `targetURL`'s query (a string as itself,
 * anything else as JSON; `src/shared/launch.ts` reads them), on the URL of
 * the manifest shortcut that launched it, if one did. To launch an app,
 * `window.open` its URL: `din://<id>/` with the parameters in the query
 * (`appLink(id, params)` in `src/shared/launch.ts` writes it), or this
 * app's own for a new window of it (`appLink(null, params)`). What the
 * window saved for Din to reopen it with is its Navigation API state
 * (`navigation.updateCurrentEntry({ state })`): when Din reopens it after
 * restarting, or after the app crashed, `navigation.currentEntry.getState()`
 * has it back by the time `din.ready` resolves. JSON, up to 512 KB (more is
 * dropped, with a warning).
 *
 * The app's windows talk to each other on a BroadcastChannel, which
 * reaches the app's windows and nothing else (each app is an origin of its
 * own), and share state in a SharedWorker, which lives while one of them
 * does. Which others are open, they say there when asked.
 *
 * Whether another app can be opened now is the web's
 * `navigator.getInstalledRelatedApps()`, for the apps the manifest lists in
 * `related_applications` as `{ "platform": "webapp", "url":
 * "din://<id>/manifest.webmanifest" }`: those installed (and, the
 * Assistant, set up and switched on).
 */
export interface DinApp {
  /**
   * The app that launched the launch `launchQueue`'s consumer is hearing,
   * with `window.open` or `din.app.launch`, by id, as the desktop saw it
   * (an app can't say it's another); null when it was the user or the
   * desktop.
   */
  readonly opener: string | null;
  /**
   * The app has drawn its first useful frame: the desktop drops the window's
   * splash. Called automatically on `load` if the app never calls it.
   */
  ready(): void;
  /**
   * Launch an app, as `window.open` does for its URL, handing the new
   * window files the app holds (they come to its `launchQueue`). Rejects
   * with a TypeError for a URL that isn't an app's.
   */
  launch(url: string | URL, files: FileSystemHandle[]): Promise<void>;
  /**
   * Open files in whichever app the desktop has for them (Files' default),
   * or in `app`, one of `openWithApps`' (an installed Linux or Windows
   * app). A Windows program (.exe) runs, through Wine. For an app with
   * `fs`, a kind of file Din has no app of its own for opens in the
   * installed app for its type, when there is one. Running a program, or
   * opening in an installed app, takes `fs`; others get a DinPermissionError.
   */
  openFiles(files: FileSystemHandle[], app?: string): Promise<void>;
  /**
   * The installed apps (Linux's, and Windows programs') that open a file,
   * by its type, for an Open With menu: Windows programs' own types'
   * first. Takes `fs`.
   */
  openWithApps(file: FileSystemHandle): Promise<OpenWithApp[]>;
}

/** An installed app that opens a file (`din.app.openWithApps`). */
export interface OpenWithApp {
  /** What `din.app.openFiles` takes to open the file in it. */
  id: string;
  name: string;
  /** Its icon, as a data: URL, when it has one. */
  icon: string | null;
}

// ---------------------------------------------------------------------------
// din.window: the app's window and how it's drawn
// ---------------------------------------------------------------------------

/** Where a window's edge is grabbed to resize it. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The half or quarter of the screen a window is snapped to. */
export type Snap = 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

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

/**
 * The rest of the window's state is the web's own, which the runtime
 * answers from the desktop's (docs/din/window.md): `document.hasFocus()`
 * and window `focus`/`blur` events; `document.visibilityState` and
 * `visibilitychange`; `matchMedia('(display-state: maximized)')` (and
 * `minimized`, `fullscreen`, `normal`); `screenX`, `screenY`, `outerWidth`
 * and `outerHeight` for the window's place and size, frame included; and
 * `screen.availLeft`, `availTop`, `availWidth` and `availHeight` for the
 * work area of its monitor.
 *
 * The app's title bar, in a `custom` or `none` frame, is CSS
 * `app-region: drag` (from the Window Controls Overlay draft), as
 * `<WindowDragRegion>` sets: pressing it and moving the pointer moves the
 * window, double-clicking maximizes or restores it, and right-clicking
 * opens Din's window menu. Buttons, links, fields, tabs and anything
 * `app-region: no-drag` (or `[data-window-no-drag]`) inside keep their own
 * clicks, and the page's own listeners can cancel each first.
 *
 * When the user (or the desktop) closes the window, it fires `beforeunload`
 * first, as a browser does before closing a tab, while the page listens for
 * one. Cancelling it (`preventDefault()`, or a `returnValue`) keeps the
 * window open, with no dialog of Din's: the app asks its own question
 * ("Save changes?") and calls `window.close()` itself if it should go.
 * Listeners must answer quickly; an app that doesn't is offered for force
 * quitting.
 */
export interface DinWindow {
  /** The window's id, unique on this desktop, for its app's other windows to address it by. */
  readonly id: string;
  /** The half or quarter of the screen it's snapped to, or null. */
  readonly snapped: Snap | null;
  onSnappedChange(cb: (snapped: Snap | null) => void): Unsubscribe;

  /**
   * Title-bar look for `custom` frames, following the accent. The window's
   * title, icon and accent are the page's own `document.title`,
   * `<link rel="icon">` and `<meta name="theme-color">` (docs/din/window.md).
   */
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
   * `app-region: drag` does, for a drag that turns into a move partway, as
   * a window's only tab does). The desktop follows the pointer until it's
   * released, with the same snapping, tear-off and wobble as the title bar.
   * Resolves when it's released (the app never sees that release itself),
   * or at once if the window can't move now.
   */
  beginMove(e: PointerEvent): Promise<void>;
  /** Start resizing from an edge, as `beginMove` (skins with their own grips). */
  beginResize(edge: Edge, e: PointerEvent): Promise<void>;

  /**
   * Close it as the user would (`<WindowControls>`' close button): through
   * a `beforeunload`. The web's `window.close()` closes it without asking.
   */
  requestClose(): void;
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
   * focused (not at all in the taskbar layout, which has no menu bar).
   * Replaces the whole set; null for none. Accelerators are bound
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
// din.files: what the web's file handles can't do
// ---------------------------------------------------------------------------

/**
 * Files the user hands an app are the web's `FileSystemFileHandle` and
 * `FileSystemDirectoryHandle`, backed by the desktop: picked
 * (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, which
 * open Din's pickers), launched with (`launchQueue`), dropped
 * (a drop's `getAsFileSystemHandle()`), pasted (a paste's, or `din.clipboard.readFiles`) or restored
 * (read back from IndexedDB). A handle is a capability: having one is what lets
 * the app read or write that file and nothing else. Handles last as long as
 * the page, and can be kept in IndexedDB like the web's, to open again
 * after a restart. These take them.
 */
export interface DinFiles {
  /**
   * Its full path, to show (a Recent list's folder, Copy Path), and stable
   * for the same file, for comparing handles. Knowing it grants nothing:
   * reaching a file by path takes `fs` or `file-folders`.
   */
  path(handle: FileSystemHandle): string;
  /**
   * A URL the app can load the file from (an `<img>`, `<audio>`, `<video>`,
   * or `fetch` with Range requests), streamed rather than sent whole. Good
   * while this page stays loaded. Not available outside Electron.
   */
  url(handle: FileSystemFileHandle): Promise<string>;
  /**
   * For apps with `file-folders`: the folder a file is in, as a handle (and
   * `din.system.fs` reaches it by path). Null without the permission, and
   * for a folder (whose parent the user didn't hand over).
   */
  parent(handle: FileSystemHandle): Promise<FileSystemDirectoryHandle | null>;
  /**
   * Files and folders by path that nothing granted the app: songs a playlist
   * names elsewhere, folders its saved state lists. Resolves with handles for
   * those it may have (and, with `file-folders`, their folders come into
   * reach). On an app's first launch after it moved out of the desktop,
   * paths its own saved state named then are granted without asking;
   * otherwise the desktop asks the user, giving `reason`. Missing paths are
   * left out.
   */
  requestAccess(paths: string[], reason?: string): Promise<FileSystemHandle[]>;
  /**
   * A handle for a path, for apps with `fs`, which reach files by path
   * anyway (`din.system.fs`) but want a handle's `url` or to hand the file
   * to another app.
   */
  fromPath(path: string): Promise<FileSystemHandle>;
  /**
   * A URL to load a file from by path, for apps with `fs`: no round trip,
   * so cheap enough for a folder of thumbnails. Throws without `fs`, and
   * outside Electron.
   */
  pathUrl(path: string): string;
  /**
   * For apps with `nostr`: upload a file the app holds to the signed-in
   * account's Blossom servers (those in Settings → Nostr & Storage), signed
   * as the account, and resolve with where anyone can now get it. The file
   * is public from then on. Rejects with why when no one is signed in, the
   * file is a folder or too big, or no server takes it.
   */
  upload(handle: FileSystemFileHandle): Promise<BlossomBlob>;
}

/** A file on a Blossom server (BUD-02's blob descriptor). */
export interface BlossomBlob {
  /** Where anyone can get it, https. */
  url: string;
  /** Its SHA-256, hex, which is its name on every Blossom server. */
  sha256: string;
  size: number;
  type: string;
}

/** Where a picker starts: beside a handle, or in a named folder of home. */
export type StartIn = FileSystemHandle | 'documents' | 'pictures' | 'music' | 'videos' | 'downloads';

/** What every picker takes: the web's options, and two of Din's. */
export interface PickerOptions {
  /** The dialog's title (Din's). */
  title?: string;
  startIn?: StartIn;
  /** The types to pick or save as: `{ description: 'Pictures', accept: { 'image/*': ['.png', '.jpg'] } }`. */
  types?: { description?: string; accept?: Record<string, string | string[]> }[];
  excludeAcceptAllOption?: boolean;
  id?: string;
}

export interface OpenFilePickerOptions extends PickerOptions {
  multiple?: boolean;
  /** `read` for files the app won't write back (Din's; the web has it only for folders). Default `readwrite`. */
  mode?: 'read' | 'readwrite';
  /** The button that picks ("Add"); Open by default (Din's). */
  confirmLabel?: string;
}

export interface SaveFilePickerOptions extends PickerOptions {
  /** A name typed without any of `types`' extensions gets the chosen type's first one. */
  suggestedName?: string;
}

export interface DirectoryPickerOptions extends Omit<PickerOptions, 'types'> {
  /** Default `read`. */
  mode?: 'read' | 'readwrite';
  /** The button that picks; Select by default (Din's). */
  confirmLabel?: string;
}

/** What `launchQueue`'s consumer hears: this window's launch, then each after it. */
export interface LaunchParams {
  readonly targetURL: string;
  /** Files the app was opened with (from Files, a drop on its Dock tile), granted to it. */
  readonly files: readonly FileSystemHandle[];
}

declare global {
  // The web's File System Access and Launch Handling, which TypeScript's
  // DOM types don't have yet, as Din provides them.
  function showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  function showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  function showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  const launchQueue: { setConsumer(consumer: (params: LaunchParams) => void): void };
  interface FileSystemHandle {
    /** What the grant allows; never asks. */
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    /** As `queryPermission`: the user's pick was the grant. */
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
  /** The File System Observer API: what else changes a file or folder the app holds. */
  interface FileSystemChangeRecord {
    readonly root: FileSystemHandle;
    readonly changedHandle: FileSystemHandle | null;
    readonly relativePathComponents: readonly string[];
    readonly relativePathMovedFrom: readonly string[] | null;
    /** Din reports `modified`, and `disappeared` when it's removed. */
    readonly type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';
  }
  interface DataTransferItem {
    /** File System Access: a handle to a dropped or pasted file, or null for anything else. */
    getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
  }
  interface DataTransferItemList {
    /** Din's, in a `copy` or `cut` event or a `dragstart`: put the file behind a handle Din granted on Din's clipboard, or drag it. */
    add(handle: FileSystemHandle): DataTransferItem | null;
  }
  class FileSystemObserver {
    constructor(callback: (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void);
    observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
    unobserve(handle: FileSystemHandle): void;
    disconnect(): void;
  }
}

// ---------------------------------------------------------------------------
// din.drag: drag and drop between apps, brokered by the desktop
// ---------------------------------------------------------------------------

/** What's being dragged, as every app can see it during the drag. */
export interface DragInfo {
  kind: 'files';
  /** The app it came from. */
  source: string;
  /** How many, and whether they're all folders. Names only after the drop. */
  count: number;
  folders: boolean;
}

/**
 * Files dragged between apps are the web's. To drag files out, in
 * `dragstart`, `e.dataTransfer.items.add(handle)` (or a `File` read from
 * one), as in a `copy`; an app that reaches files by path (`fs`, or
 * `file-folders` within its folders) can instead
 * `setData('text/uri-list', …)` their `file:` URLs, as a native file
 * manager does. Din then brokers the drag: it adds the token, the names as
 * `text/plain` (unless the page set its own) and the label the desktop
 * draws under the pointer. Files dropped from other apps are the drop's
 * `file` items, each with `getAsFileSystemHandle()`. Where a drag of files
 * went, the source's `dragend` says, in its `dropEffect`. Anything else an
 * app drags between its own windows is plain HTML drag and drop, under a
 * type of its own (`dataTransfer.setData('application/x-my-thing', …)`).
 *
 * What's left here is what the web can't see: a drag of files going on
 * elsewhere on the desktop, before it reaches the window.
 */
export interface DinDrag {
  /** The drag going on anywhere on the desktop, or null. */
  readonly current: DragInfo | null;
  onChange(cb: (drag: DragInfo | null) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// din.clipboard: cut, copy and paste of files
// ---------------------------------------------------------------------------

/**
 * Files cut, copied and pasted are the web's clipboard events'. A `paste`
 * while files are on Din's clipboard has a `file` item for each in its
 * `clipboardData.items` (and `Files` in its `types`), whose
 * `getAsFileSystemHandle()` resolves with a handle granted to the app, as a
 * drop's does. In a `copy` or `cut`, `clipboardData.items.add(handle)` (or
 * a `File` read from one) puts the file on Din's clipboard, cut or copied
 * as the event was. When files come onto Din's clipboard or go,
 * `navigator.clipboard` fires the Clipboard API draft's `clipboardchange`,
 * its `types` holding `Files` while some are there (for enabling Paste).
 *
 * These are for what the events can't do: a Paste or Copy chosen from a
 * menu or a toolbar, which fires no event, and knowing whether the files
 * were cut.
 */
export interface DinClipboard {
  /**
   * Files on Din's clipboard, as Cut or Copy left them, and whether they
   * were cut. Text and images use navigator.clipboard. Without `fs`, only on
   * a paste: within a few seconds of a key or click in the focused window,
   * or a pick from its menus; otherwise it rejects with `NotAllowedError`.
   */
  readFiles(): Promise<{ files: FileSystemHandle[]; cut: boolean } | null>;
  writeFiles(files: FileSystemHandle[], cut: boolean): void;
}

// ---------------------------------------------------------------------------
// din.theme: the desktop's look, applied to the app
// ---------------------------------------------------------------------------

/**
 * Light or dark is the web's `prefers-color-scheme`, which follows Din's
 * (a profile theme's too); the runtime also sets the `dark` class on
 * `:root`, and `color-scheme` on `body` (the root's stays normal, so the
 * page's canvas is transparent and the window's glass shows through it).
 */
export interface ThemeSnapshot {
  /**
   * Din's design tokens as CSS custom properties without the `--`
   * (`background`, `foreground`, `primary`, `radius`, …), as the desktop
   * computes them, profile theme included. The SDK sets them on `:root`, so
   * Tailwind classes match the desktop's out of the box.
   */
  tokens: Record<string, string>;
  /** A profile theme's web fonts, which the SDK loads. */
  fontFaces: { family: string; url: string }[];
  /**
   * File-type icons from the system's icon theme, as data URLs keyed by
   * freedesktop icon name (`folder`, `image-x-generic`, …). Empty while Din
   * shows its own icons, and missing any the theme doesn't have.
   */
  icons: Record<string, string>;
}

export interface DinTheme {
  readonly current: ThemeSnapshot;
  onChange(cb: (theme: ThemeSnapshot) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// window.nostr (permission `nostr`)
// ---------------------------------------------------------------------------

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

/** `window.nostr` in an app with `nostr`: NIP-07, backed by Din's signer and its prompts. */
export interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: NostrEventTemplate): Promise<SignedNostrEvent>;
  nip04: { encrypt(pubkey: string, text: string): Promise<string>; decrypt(pubkey: string, text: string): Promise<string> };
  nip44: { encrypt(pubkey: string, text: string): Promise<string>; decrypt(pubkey: string, text: string): Promise<string> };
}

// ---------------------------------------------------------------------------
// din.desktop (permissions `wallpaper` and `cursor`)
// ---------------------------------------------------------------------------

export interface DinDesktop {
  /** Make a picture the app holds the desktop's background. */
  setWallpaper(file: FileSystemHandle): Promise<void>;
  /**
   * Install the cursor theme in a file the app holds (a .CurXPTheme,
   * .CursorFX, .cape, an archive of a theme…) and make it the pointer, as
   * Settings' Import does. Rejects with why when the file isn't one, or
   * when Din can't change the cursor on this system.
   */
  setCursor(file: FileSystemHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// Speech to text: the web's SpeechRecognition
// ---------------------------------------------------------------------------

// `SpeechRecognition` (and `webkitSpeechRecognition`), from the Web Speech
// API, is Din's dictation (whisper.cpp, on this computer), in the window
// the user is in: `start()` listens until a pause (until `stop()` with
// `continuous`), then one final `result` brings what was said and `end`
// follows. `SpeechRecognition.available()` says whether this computer can
// take dictation. No interim results; `lang` is whisper's to guess.

declare global {
  // The Web Speech API's recognizer, which TypeScript's DOM types don't have.
  interface SpeechRecognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    processLocally: boolean;
    start(): void;
    stop(): void;
    abort(): void;
    onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
    onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null;
    onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null;
    onend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  }
  var SpeechRecognition: {
    prototype: SpeechRecognition;
    new (): SpeechRecognition;
    available(options?: { langs?: string[]; processLocally?: boolean }): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  };
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
  /** The model new conversations use, if one was chosen, and how hard it thinks (`variant`, unset for its default). */
  model: { id: string; providerID: string; variant?: string } | null;
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
  /**
   * The conversations with unread notifications in the notification center
   * (the ones behind the app's Dock badge), so the app can mark them.
   */
  readonly unread: readonly string[];
  onUnreadChange(cb: (sessionIDs: readonly string[]) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Permissions and din.system
// ---------------------------------------------------------------------------

/**
 * What an app can ask for in its manifest's `din.permissions`. Everything
 * not listed here, every app has (its own window, files it's handed, the
 * theme). docs/din/permissions.md says what each grants.
 */
export type Permission =
  /**
   * `window.nostr` (NIP-07): the user's pubkey, and signing, encrypting and
   * decrypting as them, through Din's prompts. Relays and the rest are the
   * user's own events (kind 10002, 10063).
   */
  | 'nostr'
  /** The whole filesystem, by path (`din.system.fs`). Files, Text Editor. */
  | 'fs'
  /** Terminals (`din.system.pty`). Terminal. */
  | 'pty'
  /** Notifications kept in the notification center, and a Dock badge. Toasts need nothing. */
  | 'notifications'
  /**
   * Work while no window is open: `registration.periodicSync` wakes the app's
   * service worker on a schedule (every 15 minutes at most), which with
   * `notifications` may also notify. docs/din/background.md.
   */
  | 'background'
  /** Set the desktop wallpaper (`din.desktop`). */
  | 'wallpaper'
  /** Install cursor themes and change the pointer (`din.desktop.setCursor`). */
  | 'cursor'
  /**
   * The Assistant's OpenCode service (`din.system.assistant`). Assistant, CAD:
   * any app but the Assistant reaches only conversations it started.
   */
  | 'assistant'
  /**
   * Answering sudo's password and approval requests in a conversation
   * (`din.system.assistant`'s `passwords`, `answerPassword`, `approve`).
   * Built-in apps only. Assistant.
   */
  | 'assistant-sudo'
  /** InDesign conversion (`din.system.indd`). Publisher. */
  | 'indd'
  /** Removable disks: list, mount, unlock, eject (`din.system.volumes`). Files. */
  | 'volumes'
  /** Din Drive, the encrypted drive at ~/Drive: whether it's on, and turning it on (`din.system.drive`). Files. */
  | 'drive'
  /** IMAP and SMTP accounts: read, file and send mail (`din.system.mail`). Mail. */
  | 'mail'
  /** The user's phones' text messages: read, send, mark read (`din.system.phone`). Messages. */
  | 'phone'
  /** The password vault: its items, locking, generating (`din.system.passwords`). Passwords. */
  | 'passwords'
  /** QEMU virtual machines in ~/VMs: running them, their screens, snapshots (`din.system.vms`). Virtual Machines. */
  | 'vms'
  /** The games in ~/roms, and playing them full screen in emulators Din sets up (`din.system.games`). Games. */
  | 'games'
  /**
   * The camera, the microphone and the whole screen in the app's own page
   * (getUserMedia, getDisplayMedia with no picker), and `din.system.capture`:
   * projects of takes and clips in ~/Videos/Studio, the screen recorded with its pointer, live
   * streams over RTMP. Studio.
   */
  | 'capture'
  /**
   * The camera and the microphone in the app's own page (getUserMedia),
   * never the screen. Camera.
   */
  | 'camera'
  /** The microphone alone in the app's own page (getUserMedia). The Assistant's Record Audio. */
  | 'microphone'
  /**
   * `din.system.fs` scoped to the folders of the files the user handed the
   * app (opened, saved, dropped, launched with), and `handle.parent()`.
   * Preview (stepping through a folder, archives), Publisher (linked
   * pictures). Apps that need fixed folders instead list them in their
   * manifest's `din.folders`.
   */
  | 'file-folders';

declare global {
  interface Permissions {
    /**
     * The Permissions API, answering from the app's grants for each of Din's
     * permissions by name (`{ name: 'cursor' }`), and for the web's names one
     * of them grants (`notifications`, `periodic-background-sync`, `camera`,
     * `microphone`, `display-capture`): `granted` when the manifest asked for
     * it and the desktop granted it, else `denied`, never `prompt`.
     */
    query(permissionDesc: { name: Permission }): Promise<PermissionStatus>;
  }
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
  drive?: DriveSetupBridge;
  mail?: MailBridge;
  /** Phones' messages. Adding, pairing and forgetting phones are Settings', not the app's. */
  phone?: PhoneAppBridge;
  passwords?: PasswordsBridge;
  vms?: VmsBridge;
  games?: GamesBridge;
  capture?: CaptureBridge;
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
  /** Dock and launcher shortcuts. The `url`'s query is the launch's parameters, and `din.params` are added to them. */
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
  /** Apps whose presence `navigator.getInstalledRelatedApps()` may report: `{ platform: 'webapp', url: 'din://<id>/manifest.webmanifest' }`. */
  related_applications?: RelatedApplication[];
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
     * Folders the app reaches by path through `din.system.fs` without the
     * whole filesystem: `~/Music`, `~/.local/share/din/skins`. Created if
     * missing. Media Player.
     */
    folders?: string[];
    /**
     * Hosts `din.fetch` reaches without CORS, by name (`thumbnails.libretro.com`):
     * no port, no wildcard, https only. Built-in apps only. Games.
     */
    fetch?: string[];
  };
}

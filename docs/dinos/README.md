# `window.dinos`: the desktop's bridge to the OS

> **Status: in place.** The 61 namespaces used to be separate globals (`window.fs`,
> `window.pty`, …); they moved under one object with no change in
> behavior.

`window.dinos` exists only in the desktop's main frame at `app://din`.
Apps never see it; the few that need a piece of it (Files needs `fs`,
Terminal needs `pty`) get that piece through `din.system`, over a port
to main that the desktop grants ([../din/permissions.md](../din/permissions.md)).

Every method is answered by a handler in `electron/` that first checks
`assertShellSender`. Outside Electron (`npm run dev:browser`)
`window.dinos` is undefined, and code reaching for it must cope.

## Shape

```ts
interface Dinos {
  readonly version: 1;

  // Session and boot
  boot: BootBridge;
  session: SessionBridge;
  bootScreen: BootScreenBridge;
  lock: LockBridge;
  erase: EraseBridge;
  power: PowerBridge;
  installer: InstallerBridge;
  updater: UpdaterBridge;
  firmware: FirmwareBridge;

  // Files and terminals
  fs: FsBridge;
  volumes: VolumesBridge;
  pty: PtyBridge;
  indd: InddBridge;
  passwords: PasswordsDesktopBridge;

  // Network
  wifi: WifiBridge;
  vpn: VpnBridge;
  tor: TorBridge;
  siteLocations: SiteLocationsBridge;
  bluetooth: BluetoothBridge;
  bluetoothLogin: BluetoothLoginBridge;
  phone: PhoneBridge;
  airplay: AirPlayBridge;

  // Displays and input
  display: DisplayBridge;
  monitors: MonitorsBridge;
  zoom: ZoomBridge;
  brightness: BrightnessBridge;
  keyboard: KeyboardBridge;
  cursor: SystemCursorBridge;
  iconTheme: IconThemeBridge;
  screenshot: ScreenshotBridge;
  dictation: DictationBridge;
  shellShortcuts: ShellShortcutsBridge;

  // Sound and media
  audio: AudioBridge;
  media: MediaBridge;
  capture: CaptureBridge;

  // System
  datetime: DateTimeBridge;
  theme: ColorSchemeBridge;
  systemEvents: SystemEventsBridge;   // typed inline in SystemEventsHost.tsx today
  systemMonitor: SystemMonitorBridge;
  systemNotifications: SystemNotificationsBridge;
  tray: TrayBridge;
  printing: PrintingBridge;

  // Native apps
  nativeApps: NativeAppsBridge;
  nativeDisplay: NativeDisplayBridge;

  // Nostr
  nostrd: NostrdBridge;
  nostrHost: NostrHostBridge;
  bunkerHost: BunkerBridge;

  // The browser
  browser: BrowserBridge;
  crx: CrxBridge;
  userscripts: UserscriptsBridge;
  adblock: AdblockBridge;
  popups: PopupsBridge;
  devtools: DevtoolsBridge;
  screenShare: ScreenShareBridge;
  eyeDropper: EyeDropperBridge;

  // nsites and napps
  nsiteHost: NsiteHostBridge;
  nsiteStore: NsiteStore;
  nappHost: NappHostBridge;
  webPushHost: WebPushHostBridge;

  // Guest plumbing (used only inside src/platform/)
  pageFullscreen: PageFullscreenBridge;
  guestVisibility: GuestVisibilityBridge;
  guestFileDrop: GuestFileDropBridge;
  guestInput: GuestInputBridge;
  highlightHost: HighlightHostBridge;
  filePickerHost: FilePickerHostBridge;
  promptHost: PromptHostBridge;

  // The Assistant
  assistant: AssistantBridge;

  // Hosting din:// apps (below)
  apps: AppsBridge;

  // Hosting widgets (../widgets.md)
  widgets: WidgetsBridge;
}
```

`src/lib/dinos.ts` declares the global `Dinos` interface and
`window.dinos`. Each namespace's type stays in the `src/lib/` (or
component) file that wraps it, which adds its member to `Dinos`:

```ts
declare global {
  interface Dinos {
    fs?: FsBridge;
  }
}
```

Members are optional, as the old globals were, so code reads
`window.dinos?.fs` and copes with its absence outside Electron. In
`electron/preload.cjs`, `expose(name, api)` adds a namespace, and one
`contextBridge.exposeInMainWorld('dinos', dinos)` at the end publishes
them all. There are no old globals left to alias: the desktop and its
preload ship together.

## Namespaces

Grouped by what they're for. "Guest plumbing" namespaces exist so the
desktop can host webviews; they move behind `GuestSurface`
([../guest-surfaces.md](../guest-surfaces.md)) and stop being used
directly by components.

| Area | Namespaces |
|---|---|
| Session and boot | `boot`, `session`, `bootScreen`, `lock`, `erase`, `power`, `installer`, `updater`, `firmware` |
| Files and terminals | `fs`, `volumes`, `pty`, `indd`, `passwords` |
| Network | `wifi`, `vpn`, `tor`, `siteLocations`, `bluetooth`, `bluetoothLogin`, `phone`, `airplay` |
| Displays and input | `display`, `monitors`, `zoom`, `brightness`, `keyboard`, `cursor`, `iconTheme`, `screenshot`, `dictation`, `shellShortcuts` |
| Sound and media | `audio`, `media`, `capture` (Studio's takes and live streams) |
| System | `datetime`, `theme`, `systemEvents`, `systemMonitor`, `systemNotifications`, `tray`, `printing` |
| Native apps | `nativeApps`, `nativeDisplay` |
| Nostr | `nostrd`, `nostrHost`, `bunkerHost` |
| The browser | `browser`, `crx`, `userscripts`, `adblock`, `popups`, `devtools`, `screenShare`, `eyeDropper` |
| nsites and napps | `nsiteHost`, `nsiteStore`, `nappHost`, `webPushHost` |
| Guest plumbing | `pageFullscreen`, `guestVisibility`, `guestFileDrop`, `guestInput`, `highlightHost`, `filePickerHost`, `promptHost` |
| The Assistant | `assistant` |

Pages per namespace are added here as each one's types are tidied up;
until then the TSDoc on its bridge interface in `src/lib/` is the
reference.

## New for the app platform

One namespace is new: `dinos.apps`, the desktop's side of hosting apps
(`AppsBridge` in `src/lib/dinApps.ts`, handled by `electron/din-apps.mts`).

| Method | Does |
|---|---|
| `grant(webContentsId, permission)` | Have main open a port from that app straight to a system bridge (`fs`, `pty`, `assistant`, `indd`, `volumes`, `mail`, `phone`, `passwords`, `vms`, `capture`, `quickshare`), bound to the app and permission ([../din/permissions.md](../din/permissions.md#dinsystem)). For `fs`, resolves with the URL base the app loads files from by path |
| `addFsRoot(webContentsId, root, writable)` | Another folder a scoped `fs` grant reaches, writable or not (`grant`'s third argument, `{ path, writable }[]`, scopes it). Main refuses `/`, home and above, and Din's profile |
| `reaches(webContentsId, paths, write)` | Whether the app's `fs` grant reaches each path (to write it, with `write`), checked as main checks the app's own calls: `..` and symlinks resolved, Din's profile refused |
| `sinceInput(webContentsId)` | Milliseconds since the user last pressed a key or clicked in that app window, or null: the gesture a paste from the file clipboard needs |
| `revoke(webContentsId, permission)` | Close that port (and end the app's terminals) |
| `fileUrl(webContentsId, path)` | A `din-file://<token>/…` URL that app window can stream the file from ([../din/files.md](../din/files.md#streaming-and-paths)) |
| `onResponsive(cb)` | Main's `unresponsive`/`responsive` for an app's webContents, which the `<webview>` element never sees |
| `kill(webContentsId)` | Force quit a hung app: main kills its renderer process (about 100 ms to `render-process-gone`; `forcefullyCrashRenderer` took seconds on a hung page) |

An app window's port to the desktop isn't a method: a port can't cross
`contextBridge`, so the preload posts each one to the page as a window
message (`dinos-apps:port`), which `onAppPort` in `src/lib/dinApps.ts`
hands to the window's `DinAppFrame`.

`dinos.widgets` (`WidgetsBridge` in `src/lib/widgets.ts`, handled by
`electron/widgets.mts`) does the same for desktop widgets
([../widgets.md](../widgets.md)): `fetch(sha256, servers)` has main fetch
a widget from Blossom and keep it if its bytes match, `icon(sha256,
servers)` its icon the same way, `resource(url)` download something from
the web for a widget granted NAP-RESOURCE, `onContextMenu(cb)`
hears right-clicks in a widget outside text fields, and each widget's port
arrives as a `dinos-widgets:port` message for `onWidgetPort`.

## Conventions for adding to it

- One namespace per area, typed in its `src/lib/` wrapper with TSDoc on
  every method.
- Every handler in main checks `assertShellSender` (or `isShellSender`
  for `ipcMain.on`) before anything else, and validates its arguments as
  untrusted.
- Events are `onX(cb): () => void`, returning an unsubscribe.
- Nothing in `window.dinos` takes a webview or webContents from app code;
  ids of guests go through `shellGuestFromId` in main.

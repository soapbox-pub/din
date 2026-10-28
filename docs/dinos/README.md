# `window.dinos`: the desktop's bridge to the OS

> **Status: design.** Today these are 61 separate globals (`window.fs`,
> `window.pty`, `window.wifi`, …), each exposed by `electron/preload.cjs`
> with `contextBridge.exposeInMainWorld` and typed in the `src/lib/` file
> that wraps it (`FsBridge` in `src/lib/fs.ts`). Collecting them under one
> object is a rename with no change in behavior.

`window.dinos` exists only in the desktop's main frame at `app://din`.
Apps never see it; the few that need a piece of it (Files needs `fs`,
Terminal needs `pty`) get that piece through `din.system`, proxied and
checked by the desktop ([../din/permissions.md](../din/permissions.md)).

Every method is answered by a handler in `electron/` that first checks
`assertShellSender`. Outside Electron (`npm run dev:browser`)
`window.dinos` is undefined, and code reaching for it must cope, as it
does with today's globals.

## Shape

```ts
interface Dinos {
  readonly version: 1;

  // Session and boot
  boot: BootBridge;
  session: SessionBridge;
  bootScreen: BootScreenBridge;
  lock: LockBridge;
  power: PowerBridge;
  installer: InstallerBridge;
  updater: UpdaterBridge;
  firmware: FirmwareBridge;

  // Files and terminals
  fs: FsBridge;
  volumes: VolumesBridge;
  pty: PtyBridge;
  indd: InddBridge;

  // Network
  wifi: WifiBridge;
  vpn: VpnBridge;
  tor: TorBridge;
  siteLocations: SiteLocationsBridge;
  bluetooth: BluetoothBridge;
  bluetoothLogin: BluetoothLoginBridge;
  airplay: AirPlayBridge;

  // Displays and input
  display: DisplayBridge;
  monitors: MonitorsBridge;
  zoom: ZoomBridge;
  brightness: BrightnessBridge;
  keyboard: KeyboardBridge;
  cursor: SystemCursorBridge;
  screenshot: ScreenshotBridge;
  dictation: DictationBridge;
  shellShortcuts: ShellShortcutsBridge;

  // Sound and media
  audio: AudioBridge;
  media: MediaBridge;

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

  // New: hosting din:// apps
  apps: AppsBridge;
}
declare global { interface Window { dinos?: Dinos } }
```

Each type is the existing interface in the `src/lib/` (or component)
file that wraps that global today; none of them change.

The types stay where they are; `src/lib/dinos.ts` gathers them into
`Dinos` and exports `dinos()` (the object, or undefined outside Electron),
the way each `src/lib/*.ts` exports its bridge today. The migration keeps
the old globals as aliases for one release, then a lint rule forbids them.

## Namespaces

Grouped by what they're for. "Guest plumbing" namespaces exist so the
desktop can host webviews; they move behind `GuestSurface`
([../guest-surfaces.md](../guest-surfaces.md)) and stop being used
directly by components.

| Area | Namespaces |
|---|---|
| Session and boot | `boot`, `session`, `bootScreen`, `lock`, `power`, `installer`, `updater`, `firmware` |
| Files and terminals | `fs`, `volumes`, `pty`, `indd` |
| Network | `wifi`, `vpn`, `tor`, `siteLocations`, `bluetooth`, `bluetoothLogin`, `airplay` |
| Displays and input | `display`, `monitors`, `zoom`, `brightness`, `keyboard`, `cursor`, `screenshot`, `dictation`, `shellShortcuts` |
| Sound and media | `audio`, `media` |
| System | `datetime`, `theme`, `systemEvents`, `systemMonitor`, `systemNotifications`, `tray`, `printing` |
| Native apps | `nativeApps`, `nativeDisplay` |
| Nostr | `nostrd`, `nostrHost`, `bunkerHost` |
| The browser | `browser`, `crx`, `userscripts`, `adblock`, `popups`, `devtools`, `screenShare` |
| nsites and napps | `nsiteHost`, `nsiteStore`, `nappHost`, `webPushHost` |
| Guest plumbing | `pageFullscreen`, `guestVisibility`, `guestFileDrop`, `guestInput`, `highlightHost`, `filePickerHost`, `promptHost` |
| The Assistant | `assistant` |

Pages per namespace are added here as each one's types are tidied up;
until then the TSDoc on its bridge interface in `src/lib/` is the
reference.

## New for the app platform

One namespace is new: `dinos.apps`, the desktop's side of hosting apps.

| Method | Does |
|---|---|
| `onPort(cb: (e: { webContentsId, appId, port: MessagePort }) => void)` | A `din://` app's webview finished the handshake ([../security-model.md](../security-model.md)) |
| `grant(webContentsId, permission)` | Have main open a port from that app straight to a system bridge (`fs`, `pty`, `printing`), bound to the app and permission ([../din/permissions.md](../din/permissions.md#dinsystem)) |
| `revoke(webContentsId, permission)` | Close that port |
| `onUnresponsive(cb)`, `onResponsive(cb)` | Main's `unresponsive`/`responsive` for an app's webContents, which the `<webview>` element never sees |
| `kill(webContentsId)` | Force quit a hung app: main kills its renderer process (about 50 ms to `render-process-gone`; `forcefullyCrashRenderer` took seconds on a hung page) |
| `migrateStorage(appId, entries)` | Seed a new app origin's `localStorage` before its first load ([../din/manifest.md](../din/manifest.md)) |

## Conventions for adding to it

- One namespace per area, typed in its `src/lib/` wrapper with TSDoc on
  every method.
- Every handler in main checks `assertShellSender` (or `isShellSender`
  for `ipcMain.on`) before anything else, and validates its arguments as
  untrusted.
- Events are `onX(cb): () => void`, returning an unsubscribe.
- Nothing in `window.dinos` takes a webview or webContents from app code;
  ids of guests go through `shellGuestFromId` in main.

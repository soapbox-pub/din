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
  fs: FsBridge;        // src/lib/fs.ts
  pty: PtyBridge;      // src/lib/pty.ts
  wifi: WifiBridge;    // src/lib/wifi.ts
  // … one member per namespace below
}
declare global { interface Window { dinos?: Dinos } }
```

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
| `kill(webContentsId)` | Force quit a hung app's renderer |
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

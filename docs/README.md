# Din's app platform

> **Status: in place, apps moving over.** The layers, the host and the SDK
> exist; built-in apps move out of the desktop one at a time
> ([migrating-builtin-apps.md](migrating-builtin-apps.md) says which have).
> Each page's status note says what of it is built.

Din used to run every built-in app inside the desktop's own page, in one
React tree at one origin. That's quick to build on, but one app's busy loop
freezes the whole desktop, and a bug in one app (an XSS in a document
renderer, say) has everything the desktop has: the filesystem, the
terminal, Wi-Fi, the signer.

So Din is splitting into three layers, each trusting only the one below it:

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron main (electron/)                                             │
│   processes, sessions, protocols, the OS                              │
└────────────────┬──────────────────────────────────────────────────────┘
                 │ window.dinos — the OS bridge
                 │ (preload; only the desktop's main frame at app://din)
┌────────────────▼──────────────────────────────────────────────────────┐
│ The Din desktop (src/, at app://din)                                  │
│   window manager, Dock, menu bar, file picker, signer, policy         │
└────────────────┬──────────────────────────────────────────────────────┘
                 │ window.din — the app platform
                 │ (a MessagePort per window; the desktop decides)
┌────────────────▼──────────────────────────────────────────────────────┐
│ Apps, each in its own webview, origin and process                     │
│   built-in apps at din://paint/, din://calculator/, …                 │
│   later: nsites at nsite://…, the same API                            │
└───────────────────────────────────────────────────────────────────────┘
```

- **[`window.dinos`](dinos/README.md)** is how the desktop reaches the
  machine: files, terminals, Wi-Fi, power, displays. It's Electron-specific
  underneath and exists only in the desktop.
- **[`window.din`](din/README.md)** is how an app reaches the desktop: its
  window, menus, the files the user gives it, drag and drop, the theme, the
  account. It knows nothing about Electron, so it can be offered to nsites
  and to other hosts later.
- **[Guest surfaces](guest-surfaces.md)** are how the desktop embeds an app
  or a web page (Electron's `<webview>` today), behind one component so the
  engine can be swapped.

## The pages

| Page | What it covers |
|---|---|
| [security-model.md](security-model.md) | Origins, sessions, who trusts whom, what an app can and can't reach |
| [dinos/README.md](dinos/README.md) | `window.dinos`: the desktop's bridge to Electron, by namespace |
| [din/README.md](din/README.md) | `window.din`: overview, the SDK, how calls travel |
| [din/manifest.md](din/manifest.md) | `manifest.webmanifest` and its `din` section |
| [din/window.md](din/window.md) | Titles, frame modes, custom headers, transparency and shapes, moving and resizing |
| [din/lifecycle.md](din/lifecycle.md) | Launching, launch params, `ready`, closing, hangs and force quit |
| [din/menus.md](din/menus.md) | The menu bar, accelerators, menus that leave the window |
| [din/files.md](din/files.md) | File handles, the picker, recent files |
| [din/drag-and-drop.md](din/drag-and-drop.md) | Dragging files and tabs between apps |
| [din/theme-and-account.md](din/theme-and-account.md) | Theme tokens, the signed-in user, `window.nostr`, notifications |
| [din/permissions.md](din/permissions.md) | What each permission grants, and `din.system` |
| [guest-surfaces.md](guest-surfaces.md) | The `GuestSurface` abstraction over `<webview>` |
| [building-an-app.md](building-an-app.md) | A built-in app from scratch |
| [migrating-builtin-apps.md](migrating-builtin-apps.md) | Old desktop hooks and their `window.din` replacements, app by app |

The types are the reference: [`src/sdk/din.d.ts`](../src/sdk/din.d.ts).
Where a page and the types disagree, the types win and the page is a bug.

## Where things live

| Path | What |
|---|---|
| `electron/main.mts` | Schemes (`app:`, `din:`, `nsite:`), sessions, webview attach policy |
| `electron/din-apps.mts` | The `din:` scheme's files, the apps' session, port handshakes, granted bridge ports, app guests' policy |
| `electron/preload.cjs` | The desktop's preload: `window.dinos` |
| `electron/din-app-preload.cjs` | Apps' preload: holds the ports and exposes them as functions, nothing else |
| `src/sdk/` | `din.d.ts` (the API), `index.ts` (`connect()`), `react/` (hooks and title-bar pieces), `start.tsx` (an app's entry point), `protocol.ts` (the port's messages) |
| `src/platform/` | `GuestSurface` and the guest helpers ([guest-surfaces.md](guest-surfaces.md)) |
| `src/components/desktop/DinAppFrame.tsx` | The desktop's end of every app window's port; `dinHost/` beside it |
| `src/lib/dinApps.ts`, `src/lib/dinDrag.ts` | Apps' manifests and ports; the drag broker |
| `src/apps/<id>/` | Each built-in app: `index.html`, `manifest.webmanifest`, `main.tsx`, its code |
| `src/shared/` | Code apps and the desktop both use (it must not reach the desktop's internals) |

## The plan

1. Write the API down (these pages and `src/sdk/din.d.ts`).
2. ~~Spike the risky parts~~ (done): transparency, shapes, moving a
   window from inside an app, drag and drop across webviews, keyboard
   input, hung apps and `din://` isolation all work; the pages say how.
3. ~~Groundwork~~ (done): the desktop's globals are `window.dinos`;
   `<webview>` is behind `GuestSurface`. (The desktop's `WindowFrame`
   stays as it is: apps get their own, `din.window.frameStyle`.)
4. ~~The app host~~ (done): the `din:` scheme and session, `DinAppFrame`,
   the SDK, a multi-page build.
5. Move apps over one at a time
   ([migrating-builtin-apps.md](migrating-builtin-apps.md) has the order).

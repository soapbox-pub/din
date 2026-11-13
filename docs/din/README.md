# `window.din`: the app platform

> **Status: in place.** The types are
> [`src/sdk/din.d.ts`](../../src/sdk/din.d.ts), the runtime
> `src/sdk/runtime.ts`, the desktop's side `DinAppFrame`. Apps still in the
> desktop's tree use the desktop's hooks until they move
> ([../migrating-builtin-apps.md](../migrating-builtin-apps.md)).

`window.din` is everything an app can ask of Din. It's deliberately small
and web-shaped: an app is a web page with a manifest, and `window.din`
fills in what a page in a desktop needs that the web platform doesn't give
it (its window, a menu bar, files from the user, drag and drop with other
apps, the desktop's theme).

Din defines `window.din` in every app page before the page's own scripts
run, the way a browser provides `navigator` (and Din provides
`window.nostr` and `window.napp` to web pages). No library is needed:

```ts
await din.ready;

document.title = 'Untitled.png';
addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  askToSave().then((ok) => ok && window.close());
});

const [file] = await showOpenFilePicker({ types: [{ description: 'Pictures', accept: { 'image/*': ['.png', '.jpg'] } }] });
load(await file.getFile());

din.app.ready();
```

## The areas

| | Page |
|---|---|
| `din.app` | [lifecycle.md](lifecycle.md): launch params, opening other apps, `ready` |
| `din.window` | [window.md](window.md): title, chrome, custom headers, transparency, shape, moving |
| `din.menus` | [menus.md](menus.md): the menu bar and menus that leave the window |
| `showOpenFilePicker` and the web's file handles, `launchQueue`, `din.files`, files cut, copied and pasted | [files.md](files.md) |
| `din.drag` | [drag-and-drop.md](drag-and-drop.md) |
| `navigator.share`, `din.app.share`, the manifest's `share_target` | [sharing.md](sharing.md) |
| `din.theme`, `window.nostr`, `Notification`, `navigator.setAppBadge`, the app's own toasts | [theme-and-account.md](theme-and-account.md) |
| `navigator.mediaSession`, `window.print()`, `din.desktop`, `SpeechRecognition`, `din.assistant` | [media-and-desktop.md](media-and-desktop.md) |
| `din.inputMethod`: being a keyboard | [input-method.md](input-method.md) |
| `navigator.permissions.query`, `din.system` | [permissions.md](permissions.md) |
| Service workers, `registration.periodicSync` | [background.md](background.md) |
| The manifest | [manifest.md](manifest.md) |

## The runtime, and the SDK

`window.din` is `src/sdk/runtime.ts`. In Electron the app preload
(`electron/din-app-preload.cjs`) runs it in the page's world with
`contextBridge.executeInMainWorld`, handing it only functions over the
ports it keeps, as `napp-preload.cjs` does for `window.napp`. A sandboxed
preload can't load other files, so `scripts/build-din-runtime.mjs` bundles
the runtime into it (`din-app-preload.built.cjs`, which Electron loads;
rerun it after changing the runtime in development). Framed outside
Electron (`npm run dev:browser`), `src/sdk/frame.ts` installs it, as the
first script the `din-apps` Vite plugin puts in each app page. The
runtime:

- is there at once; what the desktop's `hello` carries (the launch, the
  window's state, the theme, the permissions) reads as empty
  until `din.ready` resolves, and calls made before then queue;
- keeps a copy of pushed state and calls `onChange` listeners;
- applies the theme's tokens to `:root` and keeps them current, so
  Tailwind classes and shadcn/ui components look as they do on the
  desktop;
- installs `window.nostr` if the app has the `nostr` permission;
- wraps `din.system` bridges, which talk to Electron main over ports of
  their own ([permissions.md](permissions.md#dinsystem)), including their
  callbacks.

`src/sdk/` is optional sugar over the global, never the source of it:
`connect()` (from `@/sdk`) is `din.ready` then `window.din`, and an
app's `main.tsx` is usually one line, `startApp(() => <App />)` from
`@/sdk/start`, which loads the desktop's polyfills and base styles
(`src/sdk/app.css`: Din's Tailwind and tokens on a transparent page),
waits for `din.ready`, and renders with React Query, tooltips and
`<DinProvider>` around the app.

For React apps, `src/sdk/react` adds:

| Piece | Replaces | Does |
|---|---|---|
| `<DinProvider din>` / `useDin()` | `useWindowActions`, the window contexts | The connected `din`, anywhere in the tree |
| `<WindowDragRegion>` | the same, from `WindowHeader.tsx` | A stretch of header (`app-region: drag`) that moves the window, maximizes on double-click, opens the window menu on right-click |
| `<WindowControls>` | the same | Minimize, maximize, close, in the title bar's colors |
| `useWindowFocused()`, `useDocumentVisible()` | `useWindowIsTop`, `useWindowVisible` | `document.hasFocus()` and `document.visibilityState`, re-rendering on change ([window.md](window.md#state)) |
| `useWindowSize()`, `useSnapped()` | `useWindowFrame().win` | `outerWidth` and `outerHeight` (on every step of a resize), and `din.window.snapped` |
| `useFrameStyle()` | `useWindowFrame().muted/hover` | The title bar's accent and darkness (`frameControlClasses` turns it into classes) |
| `useWindowTitle(title)`, `useWindowIcon(url)`, `useWindowAccent(color)` | the same | The page's `document.title`, icon link and theme-color, which the window follows, for as long as it's mounted |
| `useCloseGuard(fn)` | `setCloseGuard` | A `beforeunload` listener for as long as it's mounted |
| `useMenuBar(menus, onAction)` | `<MenuBarMenus>` | A declarative menu bar ([menus.md](menus.md)) |
| `useDinTheme()` | reading the desktop's CSS | The theme snapshot |
| `useMediaQuery(query)` | `useTheme()` | Whether a media query matches (`prefers-color-scheme: dark`), re-rendering on change |
| `useCurrentDrag()` | `files/dnd.ts`' `activeFileDrag` | The drag going on, for drop zones ([drag-and-drop.md](drag-and-drop.md)) |

The pieces look and behave like the desktop's, and an app that lays out
its own header (Assistant, Settings) should move over by changing imports.

## How calls travel

```
 app (din://paint)                    desktop (app://din)
 ─────────────────                    ───────────────────
 document.title = 'x'      ──port──▶  DinAppFrame (window w7) → setTitle
 showOpenFilePicker(…)     ──port──▶  checks grants, shows the picker
                           ◀──port──  { type: 'reply', id: 12, result: [handle] }
                           ◀──port──  { type: 'state', state }   (focus changed)

 din.system.fs.readdir(p)  ──port──▶  Electron main, directly (granted bridges only)
```

- Messages are structured-cloned objects (`src/sdk/protocol.ts`): the
  desktop's `hello`, requests `{ type: 'request', id, method, params }`,
  replies `{ type: 'reply', id, result | error }`, and pushes `{ type, … }`.
  The protocol is internal to the runtime and versioned by `din.version`.
- **Where the port comes from.** In Electron the app's preload asks main,
  which checks the frame and hands one end to the preload and the other to
  the desktop ([../security-model.md](../security-model.md#how-a-port-is-made)).
  Outside Electron (`npm run dev:browser`) the app is an iframe on its own
  `<id>.localhost` origin: it posts `din:hello` to its parent, and the
  desktop posts a `MessageChannel` port back to that exact origin.
- Nothing is shared by reference: no DOM, no functions, no React
  context. That's what lets the app be another process, and later another
  host.
- Errors come back as rejected promises with `name`
  (`DinPermissionError`, `NotFoundError`, `AbortError`).

## What an app should still do with the web platform

- **Its own storage**: `localStorage`, IndexedDB, OPFS, all private to its
  origin.
- **Its own menus and dialogs inside the window**: Radix menus and
  dialogs work, clipped to the window. Use `din.menus.popup` only for a
  menu that has to escape the window (a small window's right-click menu).
- **The clipboard**: `navigator.clipboard` for text and images, and the
  `copy`, `cut` and `paste` events for files too. Only a menu's Copy or
  Paste of files goes through `din.clipboard`.
- **Fullscreen**: `element.requestFullscreen()`; the desktop fits it to
  the monitor.
- **Network**: `fetch` to the web, under the app's CSP.

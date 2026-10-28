# `window.din`: the app platform

> **Status: design.** Built-in apps are still React components in the
> desktop's tree today, using hooks like `useWindowTitle` and
> `useFilePicker`. The types for what replaces them are in
> [`src/sdk/din.d.ts`](../../src/sdk/din.d.ts).

`window.din` is everything an app can ask of Din. It's deliberately small
and web-shaped: an app is a web page with a manifest, and `window.din`
fills in what a page in a desktop needs that the web platform doesn't give
it (its window, a menu bar, files from the user, drag and drop with other
apps, the desktop's theme).

```ts
import { connect } from '@/sdk';

const din = await connect();

din.window.setTitle('Untitled.png');
din.window.onCloseRequest(() => {
  if (!dirty) return false;
  askToSave().then((ok) => ok && din.window.close());
  return true;
});

const [file] = await din.files.open({ types: [{ description: 'Pictures', extensions: ['.png', '.jpg'] }] });
if (file) load(await file.getFile());

din.app.ready();
```

## The areas

| | Page |
|---|---|
| `din.app` | [lifecycle.md](lifecycle.md): launch params, opening other apps, `ready` |
| `din.window` | [window.md](window.md): title, chrome, custom headers, transparency, shape, moving |
| `din.menus` | [menus.md](menus.md): the menu bar and menus that leave the window |
| `din.files`, `din.clipboard` | [files.md](files.md) |
| `din.drag` | [drag-and-drop.md](drag-and-drop.md) |
| `din.theme`, `din.account`, `din.notifications` | [theme-and-account.md](theme-and-account.md) |
| `din.permissions`, `din.system` | [permissions.md](permissions.md) |
| The manifest | [manifest.md](manifest.md) |

## The SDK

Apps don't use the raw port. `src/sdk/` is a small client bundled into
each app that:

- waits for the port and the desktop's `hello`: an app's entry point
  starts with `const din = await connect()` (from `@/sdk`), which also sets
  `window.din`, so `din.window.state` and `din.theme.current` are always
  filled in by the time app code reads them;
- keeps a copy of pushed state and calls `onChange` listeners;
- applies the theme's tokens to `:root` and keeps them current, so
  Tailwind classes and shadcn/ui components look as they do on the
  desktop;
- installs `window.nostr` if the app has the `nostr` permission;
- proxies `din.system` bridges, including their callbacks.

For React apps, `src/sdk/react` adds:

| Piece | Replaces | Does |
|---|---|---|
| `<DinProvider din>` / `useDin()` | `useWindowActions`, the window contexts | The connected `din`, anywhere in the tree |
| `<WindowDragRegion>` | the same, from `WindowHeader.tsx` | A stretch of header that moves the window, maximizes on double-click, opens the window menu on right-click |
| `<WindowControls>` | the same | Minimize, maximize, close, in the title bar's colors |
| `useWindowState()` | `useWindowIsTop`, `useWindowVisible` | The window's state, re-rendering on change |
| `useWindowTitle(title)` | `useWindowTitle` | `din.window.setTitle` for as long as it's mounted |
| `useCloseGuard(fn)` | `setCloseGuard` | `din.window.onCloseRequest` for as long as it's mounted |
| `useMenuBar(menus, onAction)` | `<MenuBarMenus>` | A declarative menu bar ([menus.md](menus.md)) |
| `useTheme()` | `useTheme` | The theme snapshot |

The pieces look and behave like the desktop's, and an app that lays out
its own header (Assistant, Settings) should move over by changing imports.

## How calls travel

```
 app (din://paint)                    desktop (app://din)
 ─────────────────                    ───────────────────
 din.window.setTitle('x')  ──port──▶  DinHost: window w7 → setTitle
 din.files.open(…)         ──port──▶  checks grants, shows the picker
                           ◀──port──  { id: 12, result: [handle] }
                           ◀──port──  { push: 'window', state }   (focus changed)
```

- Messages are structured-cloned objects: requests `{ id, method,
  params }`, replies `{ id, result | error }`, and pushes `{ push, … }`.
  The protocol is internal to the SDK and versioned by `din.version`.
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
- **Text and images on the clipboard**: `navigator.clipboard`. Only files
  go through `din.clipboard`.
- **Fullscreen**: `element.requestFullscreen()`; the desktop fits it to
  the monitor.
- **Network**: `fetch` to the web, under the app's CSP.

# Moving built-in apps out of the desktop

> **Status: done.** Moved: Calculator, Paint, Word Processor,
> Spreadsheet, Slides, Photo Editor, Vector Editor, Publisher, Text Editor,
> Terminal, Media Player, Preview, Assistant, CAD, Files.

Each app moves in its own commit: its folder goes from
`src/components/desktop/apps/` to `src/apps/<id>/`, it gets an
`index.html`, a `manifest.webmanifest` and a `main.tsx`
(`startApp(() => <App />)`), its `AppDefinition` in `src/lib/apps.ts`
becomes `dinApp('<id>')`, and its uses of the desktop's internals are
replaced as below. `src/apps/calculator/` is the model.

## Old → new

| Today (in the desktop) | In an app |
|---|---|
| `AppComponentProps.params` | `launchQueue`'s `targetURL` query (`windowLaunch().params`) |
| `AppComponentProps.windowId` | `din.window.id` (rarely needed) |
| `useWindowActions().open(id, params)` | `din.app.open(id, params)` |
| `open(appForFile(name), { path })` | `din.app.openFiles([handle])` |
| `useWindowActions().close(windowId)` | `window.close()` |
| `focus` | `window.focus()` |
| `minimize`, `maximize`, `toggleMaximize` | `window.minimize()`, `window.maximize()`, `window.restore()` |
| `resize(windowId, w, h)` | `window.resizeTo(w, h)` (and `moveTo`) |
| `setFrameless(windowId, true, geometry)` | `din.window.setChrome({ frame: 'none', … })` + `window.moveTo` and `resizeTo` |
| `useWindowTitle(title)` | `useWindowTitle(title)` from `@/sdk/react`, or `document.title` |
| `import '…/files/Dialogs'` for `Overlay`, `DialogButton` | `@/shared/dialogs` |
| `useWindowIcon(url)` | `useWindowIcon(url)` from `@/sdk/react`, or a `<link rel="icon">` |
| `useWindowAccent(color)` | `useWindowAccent(color)` from `@/sdk/react`, or a `<meta name="theme-color">` |
| `useWindowTitlebar(node)` (content in Din's title bar) | `frame: 'custom'` and the app's own header |
| `useOwnWindowHeader()` + `WindowDragRegion` + `WindowControls` | `frame: 'custom'` + the same pieces from `@/sdk/react` |
| `useWindowChrome().beginMove/beginResize` | `din.window.beginMove(e)` / `beginResize(edge, e)` |
| `useWindowIsTop()`, `useWindowVisible()` | `useWindowFocused()` / `useDocumentVisible()` (`document.hasFocus()`, `document.visibilityState`) |
| `useWindowManager().windows` | Not available. Ask for what's needed (`screen.availWidth`) |
| `useWorkAreas()`, `areaFor` | `screen.availLeft`, `availTop`, `availWidth`, `availHeight` |
| `setCloseGuard(windowId, fn)` | `useCloseGuard(fn)` / `din.window.onCloseRequest(fn)` |
| `<MenuBarMenus>` | `useMenuBar(menus, onAction)` |
| `portalContainer()` | The app's own `document.body`; `din.menus.popup` for menus that must leave the window |
| `useFilePicker().pickFile()` → path → `window.fs.readFile` | `showOpenFilePicker()` → handle → `getFile()` |
| `pickFile({ mode: 'save' })` → `window.fs.writeFile` | `showSaveFilePicker()` → `createWritable()` |
| `window.fs.*` (general) | `din.system.fs` with the `fs` permission; most apps need handles instead |
| `window.pty` | `din.system.pty` with `pty` |
| `printHtml(title, html)`, `printFile(path)` | `printDocument(html, title)`, `printFile(file)` from `@/shared/print`: the web's `print()` on a frame |
| `fileClipboard` | `din.clipboard` |
| `files/dnd.ts` (`startFileDrag`, `activeFileDrag`, `FILES_MIME`) | `din.drag.startFiles`, `din.drag.current`, `din.drag.accept` |
| `tabTransfer` | `din.drag.startTab`, `onTabDetached` |
| `useToast()` / `notify()` | `toast(…)` from `@/shared/toast`, drawn in the app's window, or `new Notification()` for one kept in the notification center |
| `useDesktopBackground().setBackground` | `din.desktop.setWallpaper(handle)` with `wallpaper` |
| `useOpenUrl()` | `window.open(url)` |
| `useAppContext().config` (theme, relays) | `din.theme`; the user's kind 10002 through `window.nostr`'s pubkey |
| `useCurrentUser`, `useNostrPublish` | `window.nostr` (permission `nostr`) with the app's own Nostrify pool |
| `registerMediaSource` (now playing) | `navigator.mediaSession` |
| `registerDictationTarget` | Nothing: dictation reaches a guest's focused field with `insertText`, as for web pages, and that includes xterm's, so Terminal needed no hook. An app's own mic button uses `din.dictation` |
| `useLocalStorage` | Unchanged; it's the app's own origin now. List old keys in `migrateStorage` |

## Code the apps share

Some code is imported across app folders today. It moves to
`src/shared/` (bundled into each app that uses it; it can't touch the
desktop) or splits:

- `src/shared/dialogs.tsx`: `Overlay` and `DialogButton`, from Files'
  dialogs (Calculator, Files).
- `src/shared/office/`: the office apps' look, file hook, OOXML/ODF
  helpers, fonts and themes. Each app's own format code moved in with it.
- `src/shared/photo/`: Photo Editor's widgets, used by Vector Editor and
  Publisher too. `src/shared/pdf/`: the general PDF reader/writer pieces;
  the Illustrator code stays with Vector Editor.
- `src/shared/TabStrip.tsx`, `TabContextMenu.tsx`: tabs in Terminal and
  Text Editor (in their custom headers) and in Files, the Web Browser and
  the Assistant on the desktop. Moving the window by a lone tab and moving
  tabs between windows are props (`moveWindow`, from
  `src/shared/dinWindowMove.ts` in an app; `transfer`), so the strip itself
  touches neither host.
- `src/shared/FileIcon.tsx`, `src/shared/codeTheme.ts`,
  `src/shared/FileViewerBody.tsx`: Text Editor, Preview, Files (and its
  quick look), the file picker, the Assistant.
- `src/shared/assistant/`: the Assistant's UI, used by the Assistant and
  CAD apps and by the desktop's menu-bar assistant and Settings. What it
  needs from where it's drawn (opening apps and URLs, the picker,
  notifications, dictation, the title bar's drag region) comes through
  `AssistantHostContext` (`host.tsx`): the desktop provides it from its
  own services, apps from `window.din` (`appHost.tsx`).
- Lib getters that work in both documents: `getFsBridge()` and
  `getPtyBridge()` return `window.din?.system.fs` in an app and
  `window.dinos?.fs` on the desktop, so code shared by both reaches the
  bridge the same way.
- `components/ui/` (shadcn/ui) is shared by everything, desktop and apps.

## Order

Each step is the first user of something new, so problems show up one at
a time.

| # | App | First to use |
|---|---|---|
| 1 | Calculator ✓ | The whole path: `din://`, the port, the manifest, `resizeTo`, `workArea` |
| 2 | Paint ✓ | Files by handle, close requests, the title |
| 3 | Word Processor, Spreadsheet, Slides ✓ | Shared office code, accent, printing, opening URLs |
| 4 | Photo Editor, Vector Editor, Publisher ✓ | Shared `photo/` code |
| 5 | Preview ✓ | Launch files, icon, wallpaper |
| 6 | Media Player ✓ | `frame: 'none'`, transparency, shapes, the menu bar, media session |
| 7 | Text Editor, Terminal ✓ | `custom` headers with tabs, `fs` and `pty`, tab drags |
| 8 | Files ✓ | Drag sources, the file clipboard, `wallpaper` |
| 9 | CAD ✓, Assistant ✓ | The `assistant` permission |

Staying in the desktop, as its own system UI rather than apps:

- **Web Browser, its pop-ups, Developer Tools**: they host guests
  themselves (`GuestSurface`), and an app can't embed a guest.
- **Native windows**: input injection into the embedded display; they're
  part of the window manager.
- **Screenshot**: draws over the whole desktop.
- **Installer**: runs before anyone is signed in.
- **Settings, System Monitor, App Store**: they manage the computer and
  the desktop itself (Wi-Fi, displays, sound, power, processes, installed
  apps, the signer and relays), so they'd need most of `window.dinos`.
  Isolating them would buy a process of their own and little else; they
  stay with the desktop, as Din's control panel.

## What moving changed, and how it was put back

Nothing an app did in the desktop should be lost by moving. What the moves
first broke, and what restored it:

| Lost | Restored by |
|---|---|
| Terminal tabs moving between windows | `din.system.pty.release`/`adopt` (main holds the pty's output meanwhile), the screen carried with `@xterm/addon-serialize`, `useDinTabTransfer` |
| Files' tab drops picking the right window, the drop marker | `din.window.tabDragMove`/`tabDragEnd` (the desktop finds the frontmost window of the app, shows the label), `onTabHover` |
| Files' undo history outliving its windows | `din.app.session` |
| Office and CAD Recent lists from before the move, Show in Files, Copy Path | `migrateRecentFiles`, `din.files.path(handle)` for every app, `din.files.release` |
| Links from apps opening in installed web apps, `nostr:` links | `window.open` answered with the desktop's `useOpenUrl` |
| Photo Editor's Quick Export beside the document | `file-folders` |
| A drag out of an app showing what's dragged | The desktop's drag overlay (`drag.over`) |
| Settling after a move begun in an app | `din.window.beginMove` resolves when the move ends |
| Media Player's play key while stopped | A `play` handler with no metadata |
| The Assistant's notifications (quiet only while you look at that conversation), its settings and model | `din.assistant` (`follow`, `setViewing`, settings) |
| Preview, Publisher, Media Player and CAD holding the whole filesystem | Scoped `fs`: `file-folders`, the manifest's `folders`; `requestAccess` and `migrateFiles` for paths their old state named |

Apps that keep the whole filesystem, because working on any folder by path
is their job: Files, Text Editor, Terminal (through its shell), the
Assistant.

## Checklist per app

- [ ] Folder moved to `src/apps/<id>/`, with `index.html` and
      `manifest.webmanifest`; `AppDefinition` removed.
- [ ] Nothing imports from `@/components/desktop/`, `@/contexts/Window*`,
      `@/hooks/useWindows` or `window.dinos`; a lint rule enforces this
      for `src/apps/`.
- [ ] Permissions in the manifest are the fewest that work.
- [ ] Old `localStorage` keys listed in `migrateStorage`.
- [ ] Launch params, file opening from Files, and Dock shortcuts work.
- [ ] Close with unsaved changes asks; force quit while busy works.
- [ ] Right-click menus still match the ⋯ menus.
- [ ] `npm test` passes.

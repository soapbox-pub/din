# Moving built-in apps out of the desktop

> **Status: under way.** Moved: Calculator, Paint, Word Processor,
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
| `AppComponentProps.params` | `din.app.launch.params` |
| `AppComponentProps.windowId` | `din.window.state.id` (rarely needed) |
| `useWindowActions().open(id, params)` | `din.app.open(id, params)` |
| `open(appForFile(name), { path })` | `din.app.openFiles([handle])` |
| `useWindowActions().close(windowId)` / `window.close()` | `din.window.close()` |
| `focus`, `minimize`, `maximize`, `toggleMaximize` | the same on `din.window` |
| `resize(windowId, w, h)` | `din.window.setBounds({ width, height })` |
| `setFrameless(windowId, true, geometry)` | `din.window.setChrome({ frame: 'none', … })` + `setBounds` |
| `useWindowTitle(title)` | `useWindowTitle(title)` from `@/sdk/react`, or `din.window.setTitle` |
| `import '…/files/Dialogs'` for `Overlay`, `DialogButton` | `@/shared/dialogs` |
| `useWindowIcon(url)` | `din.window.setIcon(url)` |
| `useWindowAccent(color)` | `din.window.setAccent(color)` |
| `useWindowTitlebar(node)` (content in Din's title bar) | `frame: 'custom'` and the app's own header |
| `useOwnWindowHeader()` + `WindowDragRegion` + `WindowControls` | `frame: 'custom'` + the same pieces from `@/sdk/react` |
| `useWindowChrome().beginMove/beginResize` | `din.window.beginMove(e)` / `beginResize(edge, e)` |
| `useWindowIsTop()`, `useWindowVisible()` | `useWindowState().focused` / `.visible` |
| `useWindowManager().windows` | Not available. Ask for what's needed (`state.workArea`) |
| `useWorkAreas()`, `areaFor` | `din.window.state.workArea` |
| `setCloseGuard(windowId, fn)` | `useCloseGuard(fn)` / `din.window.onCloseRequest(fn)` |
| `<MenuBarMenus>` | `useMenuBar(menus, onAction)` |
| `portalContainer()` | The app's own `document.body`; `din.menus.popup` for menus that must leave the window |
| `useFilePicker().pickFile()` → path → `window.fs.readFile` | `din.files.open()` → handle → `getFile()` |
| `pickFile({ mode: 'save' })` → `window.fs.writeFile` | `din.files.save()` → `write()` |
| `window.fs.*` (general) | `din.system.fs` with the `fs` permission; most apps need handles instead |
| `window.pty` | `din.system.pty` with `pty` |
| `printHtml(title, html)`, `printFile(path)` | `din.print.html(title, html)`, `din.print.file(handle)` with `printing` |
| `fileClipboard` | `din.clipboard` |
| `files/dnd.ts` (`startFileDrag`, `activeFileDrag`, `FILES_MIME`) | `din.drag.startFiles`, `din.drag.current`, `din.drag.accept` |
| `tabTransfer` | `din.drag.startTab`, `onTabDetached` |
| `useToast()` / `notify()` | `din.notifications.show(…, { transient })` |
| `useDesktopBackground().setBackground` | `din.desktop.setWallpaper(handle)` with `wallpaper` |
| `useOpenUrl()` | `din.app.openUrl(url)` |
| `useAppContext().config` (theme, relays) | `din.theme`, `din.account` |
| `useCurrentUser`, `useNostrPublish` | `window.nostr` (permission `nostr`) with the app's own Nostrify pool |
| `registerMediaSource` (now playing) | `din.media.setSession` / `onAction` with `media-session` |
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
| 1 | Calculator ✓ | The whole path: `din://`, the port, the manifest, `setBounds`, `workArea` |
| 2 | Paint ✓ | Files by handle, close requests, the title |
| 3 | Word Processor, Spreadsheet, Slides ✓ | Shared office code, accent, printing, opening URLs |
| 4 | Photo Editor, Vector Editor, Publisher ✓ | Shared `photo/` code |
| 5 | Preview ✓ | Launch files, icon, wallpaper |
| 6 | Media Player ✓ | `frame: 'none'`, transparency, shapes, the menu bar, media session |
| 7 | Text Editor, Terminal ✓ | `custom` headers with tabs, `fs` and `pty`, tab drags |
| 8 | Files ✓ | Drag sources, the file clipboard, `wallpaper` |
| 9 | CAD ✓, Assistant ✓, App Store | The `assistant` and `account`/`nostr` permissions |
| 10 | System Monitor, Settings | The most of `window.dinos`; last, while their design settles |

Staying in the desktop for now:

- **Web Browser, its pop-ups, Developer Tools**: they host webviews
  themselves, and need `GuestSurface` from inside an app first.
- **Native windows**: input injection into the embedded display.
- **Screenshot**: draws over the whole desktop.
- **Installer**: runs before anyone is signed in.

## What moving changed, and what's still owed

Behavior that changed when apps moved, to fix or to live with:

- **Terminal tabs don't move between windows.** Each window's ptys belong
  to its own bridge port, and main lets a port touch only the ptys it
  spawned. Owed: a pty hand-over between windows of the same app (a
  transfer token main honors), carried by `din.drag.startTab`.
- **Office apps' Recent lists** hold `persist()` tokens, not paths, so
  older entries were dropped and "Show in Files"/"Copy Path" are gone.
  Tokens are never released yet.
- **Links from apps open in the Web Browser**, not in an installed web app
  that owns the site, as `useOpenUrl` did on the desktop.
- **Photo Editor's Quick Export** asks where to save the first time, since
  it can't write beside the document by path.
- **Moving a window from inside an app** ends without the app hearing the
  pointer's release; a `beginMove` that resolves when the move ends would
  let tab strips settle at once.
- **Media Player's play key while stopped** no longer starts it: a session
  can't yet say "play me when idle" without being listed.
- **Files' undo history** lasts while a Files window is open (the windows
  share it over a BroadcastChannel), not as long as the desktop runs.
  Dropping a torn-off tab onto another Files window picks the window by
  position, so overlapping windows can take it in the wrong order.
- **The Assistant's notifications are approximate.** The desktop can't
  tell which conversation the app shows, so it holds back requests while
  the Assistant is in front and "done" notifications while it's open; a
  conversation the app started that finishes after its window closed
  isn't announced. Owed: main recording Din's sessions, and the app
  reporting what it views, so the desktop owns these again.
- **Din's assistant settings** ("Start conversations in", colorful
  replies) don't reach the apps yet, and the model chosen in the app is
  its own.
- **Preview, Media Player and Publisher have `fs`**: Preview steps through
  the file's folder and lists archives, Media Player's library and
  playlists are paths, Publisher links placed pictures by path.

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

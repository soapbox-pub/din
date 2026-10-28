# Moving built-in apps out of the desktop

> **Status: under way.** Moved: Calculator, Paint.

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
| `useDesktopBackground().setBackground` | `wallpaper` permission (API to come with Files/Preview) |
| `useOpenUrl()` | `din.app.openUrl(url)` |
| `useAppContext().config` (theme, relays) | `din.theme`, `din.account` |
| `useCurrentUser`, `useNostrPublish` | `window.nostr` (permission `nostr`) with the app's own Nostrify pool |
| `registerMediaSource` (now playing) | `media-session` permission (API to come with Media Player) |
| `registerDictationTarget` | Text fields need nothing: dictation reaches a guest's focused field with `insertText`, as for web pages. Terminal's pty target needs a hook, added when Terminal moves |
| `useLocalStorage` | Unchanged; it's the app's own origin now. List old keys in `migrateStorage` |

## Code the apps share

Some code is imported across app folders today. It moves to
`src/shared/` (bundled into each app that uses it; it can't touch the
desktop) or splits:

- `files/Dialogs`' `Overlay` and `DialogButton` are in
  `src/shared/dialogs.tsx` (Calculator was the first to need them);
  `FileIcon` and `FileViewerBody` (Text Editor, Media Player, the
  browser, native windows) follow when those apps move.
- `photo/` and `vector/pdf` (Vector Editor, Publisher) → `src/shared/`.
- `components/desktop/assistant/*` (Assistant, CAD, Settings) →
  `src/shared/assistant/`, with its `window.assistant` use behind a
  permission.
- `TabStrip` (Files, Terminal, Text Editor, Assistant) → `src/shared/`,
  drawn inside each app's custom header.
- `components/ui/` (shadcn/ui) is shared by everything, desktop and apps.

## Order

Each step is the first user of something new, so problems show up one at
a time.

| # | App | First to use |
|---|---|---|
| 1 | Calculator ✓ | The whole path: `din://`, the port, the manifest, `setBounds`, `workArea` |
| 2 | Paint ✓ | Files by handle, close requests, the title |
| 3 | Word Processor, Spreadsheet, Slides | Shared office code, accent, printing, opening URLs |
| 4 | Photo Editor, Vector Editor, Publisher | Shared `photo/` code |
| 5 | Preview | Launch files, icon, wallpaper |
| 6 | Media Player | `frame: 'none'`, transparency, shapes, the menu bar, media session |
| 7 | Text Editor, Terminal | `custom` headers with tabs, `fs` and `pty`, tab drags |
| 8 | Files | Drag sources, the file clipboard, `wallpaper` |
| 9 | CAD, Assistant, App Store | The `assistant` and `account`/`nostr` permissions |
| 10 | System Monitor, Settings | The most of `window.dinos`; last, while their design settles |

Staying in the desktop for now:

- **Web Browser, its pop-ups, Developer Tools**: they host webviews
  themselves, and need `GuestSurface` from inside an app first.
- **Native windows**: input injection into the embedded display.
- **Screenshot**: draws over the whole desktop.
- **Installer**: runs before anyone is signed in.

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

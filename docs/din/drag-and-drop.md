# `din.drag`: drag and drop between apps

> **Status: in place.** The broker is `src/lib/dinDrag.ts`. Drags the
> desktop's own Files starts (`files/dnd.ts`) register with it too, so
> apps can take them, and Files windows take files dragged from apps.
> Apps still in the desktop's tree move tabs with `src/lib/tabTransfer.ts`.

## The idea

The desktop brokers every drag between apps, as a Wayland compositor
does. The source registers what it's dragging; what crosses the screen is
an opaque token; the target trades the token for the goods at the drop,
and only then gets a grant to exactly those files.

```
 Files (source)                desktop                        Paint (target)
 dragstart ─ startFiles(e, handles) ─▶ registers token t, source, files
                                       pushes DragInfo{t, files, 2} to all apps
                               ◀────── (every app sees din.drag.current)
                                                              dragover: current.kind === 'files' → show drop zone
                                                              drop ─ accept(e) ─▶
                                       checks t, grants files to Paint
                                       ─────────────────────────────────▶ { kind: 'files', files: [h1, h2] }
 onEnd({ dropped: true, operation: 'copy' }) ◀─
```

## Dragging files out

```ts
row.addEventListener('dragstart', (e) => {
  din.drag.startFiles(e, selectedHandles, selected.length === 1 ? selected[0].name : `${selected.length} items`);
});
din.drag.onEnd(({ dropped, operation }) => {
  if (dropped && operation === 'move') refresh();
});
```

`startFiles` sets the DataTransfer: the token under
`application/x-din-drag`, the names as `text/plain` for targets that only
take text, and the label ("3 items") the desktop shows following the
pointer. A drag image set in a webview guest never reaches the screen, so
the SDK makes the engine's image empty and the desktop draws the label
itself (`DinDragOverlay`): while a drag from an app is on, each app reports
where it's over it (`drag.over`) and the desktop watches its own surfaces. The
DataTransfer has to be filled during `dragstart`, so the SDK mints the
token itself (a random UUID, which no other app can guess) and registers
it with the desktop alongside; the desktop refuses a token already in use.

Apps with `fs` can drag by path, `din.drag.startPaths(e, paths, label)`:
a `dragstart` can't wait for `din.files.fromPath`. Files does.

## Taking a drop

```ts
zone.addEventListener('dragover', (e) => {
  if (din.drag.current?.kind === 'files' || e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
zone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const result = await din.drag.accept(e, e.ctrlKey ? 'copy' : 'move');
  if (result?.kind === 'files') open(result.files);
  else if (e.dataTransfer?.files.length) openBlobs(e.dataTransfer.files);   // from a web page or native app
});
```

- During the drag, `din.drag.current` says what's coming (kind, count,
  whether they're all folders, the source app), which is what lets a
  target refuse early: a folder can't be dropped into itself, a sidebar
  favorite must be a folder. Names arrive only with the drop.
- `accept` resolves to null when the drop isn't a Din drag; the
  DataTransfer then holds whatever the web gave (files from a page, text,
  URLs), read as usual.
- Operations: `copy`, `move`, `link`. A target without `fs` can only
  receive (`copy`); `move` is honored only when the target can write where
  the files go (Files). The source learns what happened through `onEnd`.

## Dragging tabs

Tabs move between an app's windows (Terminal, Files), and tear off into new
ones. Tab strips drag with pointer events, which a strip keeps captured
while the pointer is outside its window, so tabs don't use HTML drag and
drop; the desktop helps instead:

- `din.window.tabDragMove(at, label)` while a tab is off the strip: the
  desktop shows the label under the pointer and answers with the app's
  frontmost window there and the point in it. That window hears
  `din.window.onTabHover(at)` and marks where the tab would land.
- `din.window.tabDragEnd(at)` when it's let go: the same answer, and the
  label and marker go.
- The tab itself travels with `din.app.postToWindow(windowId, payload)` to
  that window (`din.app.onWindowMessage`), or for a new window waits in
  `din.app.session` under a token passed in its launch params.

`useDinTabTransfer` (`src/shared/dinTabTransfer.ts`) does all of it and
returns the `TabTransfer` that `TabStrip` takes, as `useTabTransfer` does
on the desktop; the new window calls `adoptedTab(din)` when it starts. A
Terminal tab's payload carries its ptys as hand-over tokens
(`din.system.pty.release` / `adopt`), so its shells keep running.

`din.drag.startTab` (an HTML drag carrying a tab) stays for strips that
use HTML drag and drop.

## Into and out of other kinds of window

| From → to | How |
|---|---|
| App → app | The token, as above |
| App → web page or nsite | The desktop replays the drop into the page as real files through the DevTools protocol, as it does today for Files (`guestFileDrop` in `electron/main.mts`) |
| App → native window | The desktop hands the paths to the embedded display, as today |
| Web page → app | An ordinary web drag: `accept` returns null, read `e.dataTransfer` |
| Desktop (Screenshot's thumbnail) → app | The desktop starts a Din drag itself; targets can't tell the difference |

## How the drag crosses processes

Each app is its own webview, so the drag starts in one renderer and is
dropped in another. Chromium carries it: in the spike, a real mouse drag
under Din's compositor from one `din://` webview reached another webview
and the desktop page as ordinary drag events. The custom type
`application/x-din-drag` was in `dataTransfer.types` from `dragenter` on
(so targets can decide early), and the token and the `text/plain`
fallback were readable on `drop`. No covering or relaying is needed.

The source's own `dragend` fires with a `dropEffect`, but that doesn't
say which app took the drop, so the desktop still reports the outcome
through `onEnd`.

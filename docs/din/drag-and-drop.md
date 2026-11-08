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
 dragstart ─ items.add(handle) ──────▶ registers token t, source, files
                                       pushes DragInfo{files, 2} to all apps (no token)
                               ◀────── (every app sees din.drag.current)
                                                              dragover: current.kind === 'files' → show drop zone
                                                              drop ─ item.getAsFileSystemHandle() ─▶
                                       checks t, grants files to Paint
                                       ─────────────────────────────────▶ h1, h2
 dragend (dropEffect 'copy') ◀─
```

## Dragging files out

```ts
row.addEventListener('dragstart', (e) => {
  for (const handle of selectedHandles) e.dataTransfer?.items.add(handle);   // as in a copy
});
row.addEventListener('dragend', (e) => {
  if (e.dataTransfer?.dropEffect === 'move') refresh();   // the web's: where the drag went
});
```

In `dragstart`, `dataTransfer.items.add()` takes one of Din's handles (a
folder too) or a `File` read from one, as a `copy` event's does
(`installDraggedFiles` in `src/sdk/standards.ts`). The first one makes it
a drag of files: `window.din` puts the token under
`application/x-din-drag`, the names as `text/plain` for targets that only
take text (unless the page set its own), and registers the drag with the
desktop once the page's `dragstart` listeners have run, labelled with the
file's name or "3 items". A drag image set in a webview guest never
reaches the screen, so `window.din` makes the engine's image empty (and
ignores the page's `setDragImage`) and the desktop draws the label itself
(`DinDragOverlay`): while a drag from an app is on, each app reports where
it's over it (`drag.over`) and the desktop watches its own surfaces. The
DataTransfer has to be filled during `dragstart`, so `window.din` mints the
token itself (a random UUID, which no other app can guess); the desktop
refuses a token already in use.

Apps that reach files by path (`fs`, or `file-folders` within its folders)
can drag them as a native file manager does, by their `file:` URLs, since
a `dragstart` can't wait for handles. Files does:

```ts
e.dataTransfer.setData('text/uri-list', paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`).join('\r\n'));
```

Every URL in the list must be a local `file:` URL; any other list is left
as the page's own data.

## Taking a drop

```ts
zone.addEventListener('dragover', (e) => {
  if (din.drag.current?.kind === 'files' || e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
zone.addEventListener('dragover', (e) => {
  if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
});
zone.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types.includes('application/x-din-drag')) {
    // File System Access: read the items now, during the drop.
    const items = [...e.dataTransfer.items].filter((item) => item.kind === 'file');
    open(await Promise.all(items.map((item) => item.getAsFileSystemHandle())));
  } else if (e.dataTransfer?.files.length) openBlobs(e.dataTransfer.files);   // from a web page or native app
});
```

A drop of files from another app is the web's drop of files: its
DataTransfer's `items` hold a `file` item for each, and
`getAsFileSystemHandle()` resolves with a handle Din granted
(`installDroppedFiles` in `src/sdk/standards.ts` puts them there, in the
capture phase before the page's own listeners). Nothing is granted until a
handle is asked for; the first trades the drag's token for them all, as
the drop's `dropEffect` says. `getAsFile()` gives null: read the file
through its handle. `droppedHandles(e)` in `src/shared/fileHandles.ts`
does the reading.

- During the drag, `din.drag.current` (the one part of drag and drop the
  web has no word for) says what's coming (kind, count,
  whether they're all folders, the source app), which is what lets a
  target refuse early: a folder can't be dropped into itself, a sidebar
  favorite must be a folder. Names arrive only with the drop.
- The token isn't in `din.drag.current`: a target reads it from the
  drop's DataTransfer, which the engine shows only to where the drop
  lands, so no other app can take the drag.
- A drop that isn't a Din drag (no `application/x-din-drag` type) holds
  whatever the web gave (files from a page, text, URLs), read as usual;
  its file items' handles are the browser's, which `din.files` doesn't
  take.
- Operations: `copy`, `move`, `link`, the drop's `dropEffect`. A target
  without `fs` can only receive (`copy`); `move` is honored only when the
  target can write where the files go (Files). The source learns what
  happened from its `dragend`'s `dropEffect`.

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
- The tab itself travels on a `BroadcastChannel`, addressed to that
  window's id (the app's other windows ignore it), or for a new window waits in
  the app's SharedWorker (`src/shared/appSession.ts`) under a token passed in its launch params.

`useDinTabTransfer` (`src/shared/dinTabTransfer.ts`) does all of it and
returns the `TabTransfer` that `TabStrip` takes, as `useTabTransfer` does
on the desktop; the new window calls `adoptedTab()` when it starts. A
Terminal tab's payload carries its ptys as hand-over tokens
(`din.system.pty.release` / `adopt`), so its shells keep running.

A strip that uses HTML drag and drop instead needs nothing from Din: it
puts the tab under a type of its own (`dataTransfer.setData('application/x-my-tab', …)`),
which the app's other windows read in their `drop`, and a `dragend` whose
`dropEffect` is `none` was dropped outside every window, at its
`screenX` and `screenY`.

## Into and out of other kinds of window

| From → to | How |
|---|---|
| App → app | The token, as above |
| App → web page or nsite | The desktop replays the drop into the page as real files through the DevTools protocol (`guestFileDrop` in `electron/main.mts`): while a drag of files is registered, `GuestSurface` covers pages that take file drops and forwards the drag there |
| App → native window | The desktop hands the paths to the embedded display, which drags them on into the app: by Wayland's data device, or by XDND for an X app on Xwayland (`native/din-compositor/src/xdnd.rs`) |
| App → Dock tile | The desktop takes the drop and opens the files in the tile's app, if it opens them (`src/lib/dockDrop.ts`) |
| Web page → app | An ordinary web drag: read `e.dataTransfer` |
| Desktop (Screenshot's thumbnail) → app | The desktop starts a Din drag itself; targets can't tell the difference |

## How the drag crosses processes

Each app is its own webview, so the drag starts in one renderer and is
dropped in another. Chromium carries it: in the spike, a real mouse drag
under Din's compositor from one `din://` webview reached another webview
and the desktop page as ordinary drag events. The custom type
`application/x-din-drag` was in `dataTransfer.types` from `dragenter` on
(so targets can decide early), and the token and the `text/plain`
fallback were readable on `drop`. No covering or relaying is needed.

The source's own `dragend` fires with the `dropEffect` the target chose,
which is how the source learns where its drag went.

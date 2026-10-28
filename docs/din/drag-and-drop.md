# `din.drag`: drag and drop between apps

> **Status: design.** Today drags of files work because every app shares
> one document: `src/components/desktop/apps/files/dnd.ts` puts raw paths
> under `application/x-din-files` and keeps the active drag in a module
> variable that targets read while hovering. Tabs move between windows
> through `src/lib/tabTransfer.ts`, the same way. Neither survives apps in
> separate processes, and raw paths would let any app make Files move
> anything. Parts marked *spike* depend on what the spike finds.

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
take text, and a compact drag image ("3 items") like today's.

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

Terminal, Text Editor, Files and the Assistant move tabs between their
windows, and tear them off into new ones:

```ts
tab.addEventListener('dragstart', (e) => din.drag.startTab(e, 'terminal', { ptyId, title }, title));

strip.addEventListener('drop', async (e) => {
  const r = await din.drag.accept(e, 'move');
  if (r?.kind === 'tab' && r.tabType === 'terminal') adoptTab(r.state);
});

din.drag.onTabDetached(({ state, at }) => {
  closeTab(state.ptyId);
  void din.app.open(din.app.id, { tab: state, at });
});
```

`state` is structured-cloneable data the receiving window needs to adopt
the tab (a pty id, a document handle's persisted token). Only windows of
the same app can take a tab; other apps see `kind: 'tab'` and ignore it.
If the tab is dropped outside every window, the source gets
`onTabDetached` with the drop point and opens a new window there with
`din.app.open(id, { tab: state, at })`.

## Into and out of other kinds of window

| From → to | How |
|---|---|
| App → app | The token, as above |
| App → web page or nsite | The desktop replays the drop into the page as real files through the DevTools protocol, as it does today for Files (`guestFileDrop` in `electron/main.mts`) |
| App → native window | The desktop hands the paths to the embedded display, as today |
| Web page → app | An ordinary web drag: `accept` returns null, read `e.dataTransfer` |
| Desktop (Screenshot's thumbnail) → app | The desktop starts a Din drag itself; targets can't tell the difference |

## How the drag crosses processes *(spike)*

Each app is its own webview, so the drag starts in one renderer and is
dropped in another. Two ways to carry it:

1. **Chromium does it.** If a drag that starts in one webview arrives in
   another (and in the desktop) with its custom types intact, targets get
   normal `dragover`/`drop` events and read the token from the
   DataTransfer. Nothing extra.
2. **The desktop relays it.** If not, while a Din drag is registered the
   desktop covers every window but the source with a transparent overlay,
   takes the drag events itself, and sends `dragenter`/`dragover`/`drop`
   to the app under the pointer over its port; the SDK replays them in the
   app as synthetic events with a DataTransfer carrying the token. This is
   the cover-and-forward approach `BrowserView` already uses for web
   pages.

Either way, the API above doesn't change.

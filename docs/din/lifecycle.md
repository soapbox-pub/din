# Lifecycle: launching, ready, closing, hangs

> **Status: in place.** On the desktop's side the window manager still
> opens a window with launch params; `DinAppFrame` turns them into the
> app's launch context and answers its close requests through the
> desktop's close guards (`src/lib/closeGuards.ts`).

## Launching

A window opens, the desktop creates its webview at the manifest's
`start_url`, the port handshake runs ([../security-model.md](../security-model.md)),
and the app's code starts with everything in place:

```ts
await din.ready;  // window.din is Din's; ready resolves after the desktop's hello
const { reason, params, files, shortcut, state, opener } = din.app.launch;
```

| Field | |
|---|---|
| `params` | What `din.app.open(id, params)` or a shortcut passed: `{ width, height }` for Paint's File > New |
| `files` | Files the app was opened with, already granted: from Files, a drop on the Dock tile, Open With |
| `shortcut` | The manifest shortcut's `din.id`, for Dock and launcher jump lists |
| `reason` | `new`, `relaunch` for `onLaunch` below, or `restore` when Din reopened the window on starting again |
| `state` | What the window last gave `din.app.saveState`, on `restore` (and on **Reopen** after a crash); else null |
| `opener` | The app that opened it with `din.app.open`, by id, as the desktop saw it; null when the user or the desktop did. An app can't claim to be another, so it's what an app trusts a request by (the Assistant's intents) |

Launch params are structured-cloneable data. Paths an app puts in
`din.app.open` params are dropped: files travel as handles. On the
desktop's side, though, Files and the rest still open apps with
`{ path }` or `{ paths }` params, which `DinAppFrame` turns into granted
handles in `files` (and leaves out of `params`).

### Single-instance apps

With `"launch_handler": { "client_mode": "focus-existing" }` in the
manifest, launching a running app focuses its window and calls
`onLaunch` there instead of opening a new one:

```ts
din.app.onLaunch(({ params, files, shortcut }) => {
  if (shortcut === 'mini') showMini();
  for (const f of files) enqueue(f);
});
```

This replaces today's `actionAt` timestamps on dock action params.

### Restoring after a restart

Din keeps the windows open on file, on this device, and reopens them when
it starts again (Settings → Windows, `din settings set windows.reopen`):
after Restart Din, an update, a crash, logging out or a reboot. Each
window comes back on its monitor and workspace, at its size, maximized,
tiled or minimized as it was, with the launch params it was opened with
(less a shortcut, which would run again) and `reason: 'restore'`. Native
Linux apps are started again, and their windows go back where they were
as they map.

Din is stopped without warning, so there's no moment to save at quit.
An app that wants to come back as it was saves what it shows as that
changes, and reads it back from `launch.state`:

```ts
din.app.saveState({ folder: current.path, view });   // JSON, up to 512 KB; null forgets it
if (din.app.launch.reason === 'restore') openFolder(din.app.launch.state);
```

The Terminal saves its tabs and panes with each one's folder (its shells
start fresh there), and the Web Browser its tabs. If Din stops while
reopening windows twice in a row, the next start leaves them closed and
offers to reopen them (`din windows reopen`).

## `ready`

Until the app calls `din.app.ready()`, its window shows a splash in the
manifest's `background_color` with its icon, as installed nsites' windows
do today. Call it once the first useful frame is drawn (the document is
loaded, the canvas sized). `window.din` calls it on `load` if the app hasn't,
so a simple app needn't think about it.

## Opening other things

```ts
await din.app.open('paint', { width: 800, height: 600 });   // a new window, or the running one
await din.app.openFiles([handle]);                           // whichever app the desktop has for it
await din.app.openUrl('https://example.com');                // the Web Browser
await din.app.canOpen('assistant');                          // installed (and, the Assistant, switched on)?
```

An app's windows reach each other: `din.app.windows()` lists the others,
front to back, `din.app.postToWindow(id, data)` sends one a message, and
`din.app.session` keeps state the desktop holds for the app for as long as
it runs, across its windows opening and closing (Files' undo history).

`openFiles` runs a Windows program (`.exe`) through Wine instead of
opening it. `din.print.available` says whether there's a print service.

Apps can't open hidden system apps (the Installer) or pass files they
don't hold.

## Closing

Every way a window closes (its close button, Super+Q, the Dock's Quit)
goes through the app's `onCloseRequest`, if it set one
([window.md](window.md#closing)). The desktop then destroys the webview,
which ends the process. Logging out, restarting Din and shutting down
don't ask: Din stops with the windows open, and reopens them when it
starts again (see [Restoring after a restart](#restoring-after-a-restart)).

Quitting an app (Dock > Quit) closes each of its windows in turn and
stops at the first that's kept open.

## Hangs and crashes

Each app window is its own renderer process, so a stuck app stalls only
itself. The desktop treats it as not responding when either:

- main reports its webContents `unresponsive` (`dinos.apps.onUnresponsive`).
  Chromium only notices once input waits on the stuck page, about 16 s
  after it in the spike, so this alone is slow; or
- a request the desktop sent (a close request) goes unanswered for 5 s.

Its window then says "Paint isn't responding" over the app and offers
**Wait** or **Force Quit**. Force quit has main kill the renderer process
(`dinos.apps.kill`), and `render-process-gone` follows within about
100 ms. A window whose renderer is gone, killed or crashed, shows "Paint
stopped" with **Reopen**, which reloads the webview: a new process, the
same webContents, a fresh port, and the same launch context.

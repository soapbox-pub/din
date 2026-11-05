# Lifecycle: launching, ready, closing, hangs

> **Status: in place.** On the desktop's side the window manager still
> opens a window with launch params; `DinAppFrame` turns them into the
> launch's `targetURL` and files, and answers its close requests through the
> desktop's close guards (`src/lib/closeGuards.ts`).

## Launching

A window opens, the desktop creates its webview at the manifest's
`start_url`, the port handshake runs ([../security-model.md](../security-model.md)),
and the app's code starts with everything in place. Launches are the
web's Launch Handling: `launchQueue`'s consumer hears this window's launch,
then each launch after it.

```ts
await din.ready;  // window.din is Din's; ready resolves after the desktop's hello
launchQueue.setConsumer(({ targetURL, files }) => {
  const params = new URL(targetURL).searchParams;   // the launch parameters
  for (const handle of files) open(handle);          // the files it was opened with
});
```

| | |
|---|---|
| `targetURL` | The app's own URL (`din://<id>/`, wherever the page is served from), at the shortcut's `url` when a manifest shortcut launched it, with the launch parameters in its query |
| `files` | The launch's files, already granted ([files.md](files.md)) |
| `din.app.opener` | The app that opened it with `window.open` or `din.app.launch`, by id, as the desktop saw it; null when the user or the desktop did. An app can't claim to be another, so it's what an app trusts a request by (the Assistant's intents). It's the launch the consumer is hearing's |

The launch parameters are the query of the URL another app opened
(`window.open(appLink(id, params))`), or what the desktop passed (`{ width, height }` for Paint's File > New): a string as itself,
anything else as JSON, and a string that would read as JSON (`"2024"`,
`"true"`) quoted. `decodeLaunchParams(targetURL)` in `src/shared/launch.ts`
reads them back as they were. A manifest shortcut's `url` carries its own
(`"/?new"`), and its `din.params` are added to them. Paths an app puts in
a launch's params are dropped: files travel as handles. On the
desktop's side, though, Files and the rest still open apps with
`{ path }` or `{ paths }` params, which `DinAppFrame` turns into granted
handles for the launch's files (and leaves out of the query).

Launches that come before there's a consumer wait for it. Every launch is
heard, with no files too. `startApp` waits for the window's own launch
before the app first renders, so `windowLaunch()` from
`src/shared/launch.ts` has it at once (its `params` decoded), as
`windowLaunchFile()` and `windowLaunchFiles()` from
`src/shared/fileHandles.ts` have its files, to start with the document;
`onLaunch(cb)` and `useOnLaunch(cb)` (and `useLaunchFiles(cb)`,
`onLaunchFiles(cb)` for those with files) hear the launches after it.
They're the page's one consumer: an app uses them or `launchQueue`
itself, not both.

### Single-instance apps

With `"launch_handler": { "client_mode": "focus-existing" }` in the
manifest, launching a running app focuses its window and gives
`launchQueue`'s consumer the new launch there, instead of opening a new
window:

```ts
useOnLaunch(({ params }) => {
  if (params.show === 'mini') showMini();   // the Mini Player shortcut's url is "/?show=mini"
});
onLaunchFiles((files) => files.forEach(enqueue));
```

This replaces today's `actionAt` timestamps on dock action params.

### Restoring after a restart

Din keeps the windows open on file, on this device, and reopens them when
it starts again (Settings → Windows, `din settings set windows.reopen`):
after Restart Din, an update, a crash, logging out or a reboot. Each
window comes back on its monitor and workspace, at its size, maximized,
tiled or minimized as it was, with the launch params it was opened with
(less a shortcut, which would run again). Native Linux apps are started
again, and their windows go back where they were as they map.

Din is stopped without warning, so there's no moment to save at quit.
An app that wants to come back as it was saves what it shows as that
changes, as the window's Navigation API state, and reads it back from
there; the runtime passes it on to the desktop, and puts it back before
the window's launch reaches `launchQueue`:

```ts
navigation.updateCurrentEntry({ state: { folder: current.path, view } });   // JSON, up to 512 KB; null forgets it
const saved = navigation.currentEntry.getState();                           // undefined in a new window
```

A reopened window's entry always has state, null if it saved none, so
`getState() !== undefined` tells it from a new window; one-shot launch
parameters (an intent, a recording action) were carried out the first
time. `saveState`, `restoredState()` and `wasReopened()` in
`src/shared/launch.ts` do the same, as of the window's launch. **Reopen**
after a crash brings the saved state back too.

The Terminal saves its tabs and panes with each one's folder (its shells
start fresh there), and the Web Browser its tabs.

A window that brings Din down mustn't keep it down:

- If Din stops within two minutes of reopening windows, twice in a row,
  the next start leaves them closed.
- `touch ~/.config/din/skip-restore` (from a text console, Ctrl+Alt+F2)
  has the next start leave them closed; in a browser, `?norestore` does.

Each way, a notification offers to reopen them (`din windows reopen`).

## `ready`

Until the app calls `din.app.ready()`, its window shows a splash in the
manifest's `background_color` with its icon, as installed nsites' windows
do today. Call it once the first useful frame is drawn (the document is
loaded, the canvas sized). `window.din` calls it on `load` if the app hasn't,
so a simple app needn't think about it.

## Opening other things

```ts
window.open('din://paint/?width=800&height=600');   // a new window, or the running one
window.open(appLink('paint', { width: 800, height: 600 }));   // the same, from src/shared/launch.ts
window.open(appLink(null));                          // a new window of this app (its own URL)
await din.app.launch(appLink(null), [handle]);      // the same, handed files for its launchQueue
await din.app.openFiles([handle]);                   // whichever app the desktop has for it
await din.app.openWithApps(handle);                  // the installed apps for its type (fs)
await din.app.openFiles([handle], app.id);           // in one of those
window.open('https://example.com');                  // as links open anywhere on the desktop
await navigator.getInstalledRelatedApps();          // the related apps installed (and, the Assistant, switched on)
```

An app's URL is `din://<id>/` with the launch parameters in its query, as
the opened app's `targetURL` has them; any URL of the app's own origin
opens a new window of it. `window.open` can't carry file handles, so
`din.app.launch(url, files)` takes the same URLs and hands the files on.

Whether another app is there to open is the web's
`navigator.getInstalledRelatedApps()`, which answers only for the apps the
manifest lists in `related_applications`, each by its manifest's URL:

```json
"related_applications": [{ "platform": "webapp", "url": "din://assistant/manifest.webmanifest" }]
```

Those installed (and, the Assistant, set up and switched on) come back as
listed. `canOpenApp('assistant')` in `src/shared/launch.ts` asks for one.

The web's `window.open(url)` opens a link into an installed app that owns
the site, `mailto:` in Mail, `nostr:` in its viewer, and anything else in
the Web Browser. Like a `noopener` open, it returns no window; `_self`,
`_parent` and `_top` navigate the app's own page.

An app's windows reach each other: a `BroadcastChannel` carries messages
between them, reaching every window of the app (each app is an origin of
its own) and nothing else, so a message for one names it by its
`din.window.id`, and which others are open they say there when asked (as
`useDinTabTransfer` does, for "Move to window"); and a
`SharedWorker` keeps state they share for as long as one of them is open
(Files' undo history, a torn-off tab waiting for its new window):
`sessionGet` and `sessionSet` in `src/shared/appSession.ts`.

`openFiles` runs a Windows program (`.exe`) through Wine instead of
opening it, for an app with the `fs` permission; any other gets a
`DinPermissionError`, so an app that can write a folder can't make a
program there and run it. Opening a file in an installed app (a Linux
app, a Windows program), which reaches whatever the user can, takes `fs`
too: `openWithApps` lists them for a file's type, Windows programs' own
types first, for an Open With menu, and `openFiles(files, app)` opens in
one. For an app with `fs`, a kind of file Din has no app of its own for
opens in the first of them (a Windows program's project file in the
program), and in Preview where there's none.

Apps can't open hidden system apps (the Installer) or pass files they
don't hold.

## Closing

Every way a window closes (its close button, Super+Q, the Dock's Quit)
fires the app's `beforeunload`, if it listens for one
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
same webContents, a fresh port, and the same launch.

# Lifecycle: launching, ready, closing, hangs

> **Status: design.** Today the window manager renders an app component
> with `{ windowId, params }` props (`AppComponentProps` in
> `src/lib/apps.ts`), and close guards live in `src/lib/closeGuards.ts`.

## Launching

A window opens, the desktop creates its webview at the manifest's
`start_url`, the port handshake runs ([../security-model.md](../security-model.md)),
and the app's code starts with everything in place:

```ts
const din = await connect();  // from @/sdk: resolves after the desktop's hello
const { reason, params, files, shortcut } = din.app.launch;
```

| Field | |
|---|---|
| `params` | What `din.app.open(id, params)` or a shortcut passed: `{ width, height }` for Paint's File > New |
| `files` | Files the app was opened with, already granted: from Files, a drop on the Dock tile, Open With |
| `shortcut` | The manifest shortcut's `din.id`, for Dock and launcher jump lists |
| `reason` | `new`, or `relaunch` for `onLaunch` below |

Launch params are structured-cloneable data. File paths in params don't
grant anything; files travel as handles in `files`.

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

## `ready`

Until the app calls `din.app.ready()`, its window shows a splash in the
manifest's `background_color` with its icon, as installed nsites' windows
do today. Call it once the first useful frame is drawn (the document is
loaded, the canvas sized). The SDK calls it on `load` if the app hasn't,
so a simple app needn't think about it.

## Opening other things

```ts
await din.app.open('paint', { width: 800, height: 600 });   // a new window, or the running one
await din.app.openFiles([handle]);                           // whichever app the desktop has for it
await din.app.openUrl('https://example.com');                // the Web Browser
```

Apps can't open hidden system apps (the Installer) or pass files they
don't hold.

## Closing

Every way a window closes (its close button, Super+Q, the Dock's Quit,
logging out) goes through the app's `onCloseRequest`, if it set one
([window.md](window.md#closing)). The desktop then destroys the webview,
which ends the process.

Quitting an app (Dock > Quit) closes each of its windows in turn and
stops at the first that's kept open.

## Hangs and crashes

Each app window is its own renderer process, so a stuck app stalls only
itself. The desktop treats it as not responding when either:

- main reports the webview `unresponsive` (its main thread hasn't
  answered for several seconds), or
- a request the desktop sent (a close request) goes unanswered for 5 s.

Its window then dims, the title says "(Not Responding)", and the desktop
offers **Wait** or **Force Quit**. Force quit kills the renderer
(`dinos.apps.kill`). A window whose renderer is gone, killed or crashed,
shows "Paint stopped" with **Reopen**, which reloads it with the same
launch context. System Monitor lists app windows by their processes and
can end them the same way.

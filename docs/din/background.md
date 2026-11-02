# Working in the background

> **Status: in place** for apps on `din://` and `din+file://`, installed
> nsites, and installed web apps.

An app does work while none of its windows is open the web's way: a
service worker, woken by Din with the
[Periodic Background Sync](https://wicg.github.io/periodic-background-sync/)
API. A worker written for Chrome or Tenna runs unchanged.

```ts
// The page, once din is ready:
const registration = await navigator.serviceWorker.register('/sw.js', { type: 'module' });
await registration.periodicSync.register('inbox', { minInterval: 60 * 60_000 });

// sw.ts
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'inbox') event.waitUntil(checkInbox());
});
```

`getTags()` and `unregister(tag)` work in the page and the worker, and
`navigator.permissions.query({ name: 'periodic-background-sync' })` answers
`granted`, `denied` or `prompt`.

## The rules

The same for every kind of app (`electron/periodic-sync.mts`):

- A new tag comes from the page, where the user is. A worker can register
  again, or drop, only a tag its app already holds.
- At most 10 tags per app, each run at most every 15 minutes: a shorter
  `minInterval` is raised to that.
- Registering a tag again keeps its place in the schedule, so calling
  `register()` on every load is fine. Its first run is one interval after it
  was first registered.
- Nothing runs while the computer is offline. A run missed while it slept
  or was off happens once, soon after, never once per interval missed.
- One event at a time per app, five minutes at most for what it hands
  `waitUntil()`.
- An app whose worker is gone for three runs in a row loses its tags, as a
  registration's go with it in Chrome.

## Who may

| | Asks for it with | Registers from |
|---|---|---|
| Din app | `background` in its manifest's `din.permissions` (an app that isn't built in asks the user on screen, with its other permissions) | any of its windows, once `din` is ready |
| Installed nsite | the "Refresh in the background" prompt, on its first `register()` | its window or a browser tab |
| Installed web app | the same prompt | its app window only, as in Chrome (a browser tab gets `NotAllowedError`) |

A Din app runs in the background only while Din still has it: a built-in
app, a folder the desktop opened since it started, an app `din apps run` is
running. Uninstalling an app drops its schedule.

## What the worker can do

Din apps' workers get, from `electron/din-app-workers.mts` through
`electron/din-app-worker-preload.cjs`:

- `registration.showNotification()` and `getNotifications()`, into Din's
  notification center, with `notifications` in the manifest too. A click
  raises `notificationclick` in the worker and a dismissal
  `notificationclose`.
- `clients.openWindow(url)`, for a minute after a click: a new window of the
  app, with `url` in its launch params (`din.app.launch.params.url`), and
  `WindowClient.focus()`, which brings the app's frontmost window forward.
- The web's own worker APIs: `fetch`, IndexedDB, the Cache API,
  `clients.matchAll()` and `postMessage` to open windows.

A worker has no `window.din`: the account, the signer and `din.system` are
the page's.

Installed nsites' workers have the napp runtime (Tenna's NAPP.md,
`electron/napp.mts`), and web apps' have Web Push (`electron/web-push.mts`).

## A built-in app's worker

`src/apps/<id>/sw.ts` is built to `src/apps/<id>/sw.js` (the `din-apps`
plugin in `vite.config.ts`), served at `din://<id>/sw.js`; in development
it's the dev server's `sw.ts`. Register it as a module. It can import shared
code like any module; type its global with
`declare const self: ServiceWorkerGlobalScope` from a `/// <reference
lib="webworker" />` file of its own. An app from a folder ships its
`sw.js` as it is.

## Seeing and stopping it

Settings → Background Activity lists every app with a schedule, its tags,
how often they run and how the last run went. One switch turns all of it
off; each app can be paused (it keeps its schedule), run now, or removed
(a site has to ask again; a Din app can schedule itself again the next time
it's open). `din background list|enabled|pause|resume|run|remove` does the
same.

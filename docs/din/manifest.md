# The manifest

> **Status: in place**, except `file_handlers` and maskable icons, which
> aren't read yet: which app opens which file is still `appForFile` in
> `src/lib/fileTypes.ts`. Apps still in the desktop's tree keep their
> `AppDefinition` entries in `src/lib/apps.ts` until they move.

Every app ships `manifest.webmanifest` beside its `index.html`: a
standard [W3C web app manifest](https://www.w3.org/TR/appmanifest/) with
one extra member, `din`. Using the standard means the same file works
when the app is published as an nsite, and Din reads ordinary members
(name, icons, shortcuts, file handlers) the way browsers do. The type is
`DinManifest` in [`src/sdk/din.d.ts`](../../src/sdk/din.d.ts).

## An example

```json
{
  "name": "Paint",
  "description": "Pictures and pixel art, MS Paint style with Kid Pix's toys.",
  "icons": [{ "src": "/icon.png", "sizes": "512x512", "type": "image/png" }],
  "start_url": "/",
  "background_color": "#f4f4f5",
  "launch_handler": { "client_mode": "navigate-new" },
  "file_handlers": [
    {
      "action": "/",
      "accept": { "image/png": [".png"], "image/bmp": [".bmp"], "image/gif": [".gif"] }
    }
  ],
  "shortcuts": [
    { "name": "New Pixel Art", "url": "/", "din": { "id": "pixel", "params": { "width": 64, "height": 64, "zoom": 8 } } }
  ],
  "din": {
    "window": { "size": { "width": 960, "height": 700 }, "frame": "standard" },
    "keywords": ["mspaint", "kid pix", "draw", "pixel art", "sprite"],
    "migrateStorage": ["din:paint:*"]
  }
}
```

## Standard members Din uses

| Member | Replaces | Use |
|---|---|---|
| `name`, `short_name` | `AppDefinition.name` | Launcher, Dock, title bar |
| `icons` | `AppDefinition.icon` | The largest square one, as a root path of Din's public files (`/icons/apps/<id>.png`), which both the desktop and the app can load |
| `start_url` | | The page each window loads; default `/` |
| `background_color` | | The splash until `din.app.ready()` |
| `theme_color` | | The title bar's default accent |
| `launch_handler.client_mode` | `singleInstance` | `focus-existing`: one window, re-launches go to `onLaunch` |
| `shortcuts` | `actions` | Dock and launcher jump lists; `din.id` and `din.params` reach the app as `launch.shortcut` and `launch.params` |
| `file_handlers` | `appForFile` | Not read yet. Which files Files opens here; `din.default: true` makes it the default over other handlers of the same type |
| `protocol_handlers` | | Which `nostr:` links open here, and which event kinds; see below |

## Opening `nostr:` links

> **Status: works for installed nsites and web apps** (read when they're
> installed, `src/lib/nostrUri.ts`). Built-in apps will read it the same
> way once they have manifests.

An app that shows Nostr events says so with a `protocol_handlers` entry
for `nostr` ([NIP-21](https://github.com/nostr-protocol/nips/blob/master/21.md)),
plus one key Din adds, `kinds`: the event kinds it shows. Without `kinds`
it's offered for every kind. Only `nostr` counts; `web+nostr` is ignored.

```json
"protocol_handlers": [
  { "protocol": "nostr", "url": "/open?uri=%s", "kinds": [0, 1, 6, 30023] }
]
```

`url` is resolved against the manifest and must stay on the app's own
origin. `%s` becomes the whole link, percent-encoded
(`nostr%3Anevent1…`), as `registerProtocolHandler` does it. A profile is
kind 0.

Clicking a `nostr:` link anywhere (a web page, an app, a native app's
`xdg-open`) opens it in the app the user chose for its kind with "Always",
or else as a preview in the Web Browser with **Open in…** and **Open
with…** buttons. Native apps whose desktop entry lists
`x-scheme-handler/nostr` and takes a `%u` are offered for every kind.
Defaults are listed, and reset, in Settings > Nostr & Storage.

## The `din` member

| Member | Replaces | |
|---|---|---|
| `permissions` | | What the app needs beyond the basics ([permissions.md](permissions.md)) |
| `window.size` | `defaultSize` | The first window's size |
| `window.floating` | `floating` | Floats above tiling, for small tools |
| `window.frame` | | The frame the window opens with, until `setChrome` ([window.md](window.md)) |
| `keywords` | `keywords` | Launcher search terms |
| `hidden` | `hidden` | Openable by id, not listed (Preview, Developer Tools) |
| `dockAs` | `dockAs` | Windows go under another app's Dock tile |
| `migrateStorage` | | See below |
| `migrateRecentFiles` | | Recent lists of `{ path, time }` turned into persisted handles once ([files.md](files.md#recent-files)) |
| `folders` | | Fixed folders `din.system.fs` reaches by path, without `fs` ([files.md](files.md#some-folders-by-path)) |

## Moving settings out of the desktop

Apps that ran in the desktop kept their settings in its `localStorage`
(`app://din`). A new origin starts empty, so `migrateStorage` lists the
keys (a trailing `*` matches a prefix) the desktop should copy into the
app's own storage before its first launch. It happens once per app; the
desktop then deletes its copies. Remove the field a release or two later.

## Where manifests live and how Din finds them

Built-in apps live in `src/apps/<id>/` with `index.html`,
`manifest.webmanifest` and `main.tsx`. The build (the `din-apps` plugin in
`vite.config.ts`) makes each `index.html` a page of its own, so it lands
in `dist/src/apps/<id>/`, served at `din://<id>/`. The id is the
directory name.

The desktop bundles the manifests (`import.meta.glob` in
`src/lib/dinApps.ts`), and `src/lib/apps.ts` turns each into the
`AppDefinition` the window manager knows, with `DinAppFrame` as its
window body: `dinApp('calculator')` in the `APPS` list puts it in
launcher order, and apps not in the list come last.

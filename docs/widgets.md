# Widgets

> **Status: in place.** Eight built-in widgets; widgets from Nostr by
> `naddr` or from the gallery, and from folders on this computer, which
> reload as they're edited and can be published to Nostr; with
> Android-style permissions; the `shell`,
> `theme`, `identity`, `storage` and `resource` domains. Not yet: `relay`,
> `notify`, `link`, `media` and `intent`, updating a widget to a newer
> manifest, and syncing the layout between computers.

Widgets sit on the desktop, over the wallpaper and under every window. Each
is a **napplet**: a small, single-purpose page described by
[NIP-5D](https://github.com/nostr-protocol/nips/pull/2303), which reaches
the desktop only through the capabilities ("NAP domains",
[napplet/naps](https://github.com/napplet/naps)) the desktop gives it on
`window.napplet`. Users only ever see the word "widget", the way nsites are
"apps".

Right-click the desktop for **Add Widgets…** and **Edit Widgets** (drag to
arrange, the handles on the edges to resize, × to remove). Right-click a
widget for Edit Widgets, Size (Small, Medium, Large), Reload, About This
Widget… (who made it, and its permissions, each with a switch), Publish to
Nostr… (a folder's widget only) and Remove Widget.

## The grid

Widgets sit on a grid, like a phone's home screen (`src/lib/widgetGrid.ts`):
each work area has its own, of 76px cells 16px apart, as many as fit,
centered. A widget covers a block of cells, at least 2×2, and never overlaps
another. Small is 2×2, Medium 4×2 and Large 4×4, but those are only where it
starts: in edit mode a widget resizes to any number of cells from any edge,
and a drag or resize shows where it will land (red where it can't), snaps
there on release, or goes back if the cells are taken. A widget whose
monitor is gone shows on the primary one, fitted to its grid.

The gallery lists the built-in widgets down the side; each shows live, in
every size it comes in, on the user's own wallpaper, and clicking a size
adds it. **From Nostr** lists kind 35129 widgets from the user's relays (or
finds one by `naddr`), and picking one opens its permission screen: its
icon and name, then a row for each permission it asks for (`identity`,
`resource`, `storage`), each with a switch, then Add Widget or Cancel. What
the user turns off is kept on that copy (`PlacedWidget.denied`) and can be
turned back on in About This Widget; the widget reloads with the new set.

## Transparency

Din draws nothing behind a widget: no card, no border, no blur. The
webview, its host page and the srcdoc iframe are all transparent, so a
widget is exactly as transparent as its own page. Din does cut it to
rounded corners (24px, both the webview and the iframe), and hides its
scrollbars, as Safari does: what overflows still scrolls, but no scrollbar
is drawn (`scrollbar-width: none`, `!important`). One catch, from
Chromium: a frame whose used `color-scheme` differs from its parent's gets
an opaque backdrop, so a widget that wants to stay see-through should leave
`color-scheme` unset (or `normal`) rather than setting `dark`.

## Where a widget runs

```
┌ the desktop (app://din) ───────────────────────────────────────────┐
│  WidgetFrame: the menu, edit mode, the NAP host (useNappletHost)   │
│      ▲ MessagePort (main made it; bound to the guest's URL)        │
│ ┌────┴ <webview> in persist:widgets, a process of its own ───────┐ │
│ │ widget://clock/, napplet://<hash>/ or widget+file://<hash>/    │ │
│ │ an empty host page with NIP-5D's CSP, and widget-preload.cjs   │ │
│ │      ▲ postMessage, checked by event.source                    │ │
│ │ ┌────┴ <iframe sandbox="allow-scripts" srcdoc> ──────────────┐ │ │
│ │ │ CSP meta + @napplet/shim's prelude + the widget's bytes    │ │ │
│ │ └────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

- **The inner frame is exactly NIP-5D's web projection**: the verified bytes
  in a `srcdoc` iframe with `sandbox="allow-scripts"` and no
  `allow-same-origin`, so its origin is opaque (no `localStorage`, cookies
  or IndexedDB), with the CSP meta element and `window.napplet` injected
  ahead of the bytes. The napplet talks to `window.parent` with
  `postMessage`, and anything written for NIP-5D runs unchanged.
- **The webview around it is Din's**: it gives every widget a process of
  its own (a busy widget can't stall the desktop) and keeps the desktop's
  own CSP untouched. Its host page carries the NIP-5D CSP as a header, so
  the srcdoc inherits it too.
- **No network of its own.** `connect-src 'none'`, `img-src data: blob:`
  and the rest, and the `persist:widgets` session cancels every http(s) and
  ws(s) request besides. Downloads, pop-ups, permissions and navigation
  away are refused (`attachWidgetGuest`). A widget granted `resource` asks
  the desktop, and main fetches for it.
- **Nothing but `window.napplet`.** Widgets never get `window.din`,
  `window.nostr` or `window.dinos`; lint keeps `src/widgets/` from
  importing anything outside it.

`widget-preload.cjs` asks main for the widget's bytes (`widget:artifact`,
answered for the frame's own URL, never for anything it names), waits for
the desktop's `init` (which domains), builds the srcdoc, and relays: an
envelope from that iframe (`event.source`) goes to the desktop as
`{ message }`, and the desktop's `{ message }` goes back to it.

## Built-in widgets: `widget://<id>/`

`src/widgets/<id>/` holds `index.html` (with NIP-5D's HTML metadata),
`main.ts`, its CSS and `manifest.json`:

```json
{
  "name": "Clock",
  "description": "The time and date, on an analog face.",
  "icon": "clock",
  "domains": ["theme"],
  "size": "small",
  "sizes": ["small", "medium", "large"]
}
```

`icon` names one of the gallery's lucide icons (`WIDGET_ICONS` in
`src/components/desktop/widgets/widgetMeta.ts`), `domains` what the widget
may use (reviewed like an app's permissions), `size` where it starts and
`sizes` the presets the gallery and the Size menu offer. A widget can be
resized to any block of cells, so it lays itself out for whatever box it's
in (`followShape`: `small`, `wide` or `large`).

| Widget | Looks | Uses |
|---|---|---|
| Clock | clear: an analog face, or big digits when medium | `theme` |
| Calendar | glass: today, the month beside it, or a month to page through | `theme` |
| Weather | sky gradient: now, the next hours, the next days, for a place you search for (Open-Meteo) | `resource`, `storage`, `theme` |
| World Clock | clear: day and night faces, or a list, of cities you choose | `storage`, `theme` |
| Battery | clear: a ring with the charge, and time left | `theme` (and `navigator.getBattery()`) |
| Timer | glass: a ring, presets, a chime when done | `storage`, `theme` |
| Sticky Note | paper in five colors | `storage` |
| Profile | glass: your picture, name, address, bio and follows | `identity`, `resource`, `theme` |

"Clear" widgets are white over the wallpaper with a soft shadow; "glass"
ones a pane tinted light or dark with the desktop's theme (`.glass` and
`data-scheme` in `src/widgets/shared/`). A widget can't blur what's behind
it: that's another process's pixels.

`scripts/build-widgets.mjs` builds each into one self-contained file,
`dist/widgets/<id>/index.html`, script, styles and fonts inlined (a napplet
loads nothing), and copies the prelude beside them. It runs in `npm run
build`, `npm test`, `npm run dev` and the Nix build; rerun it after changing
a widget, since widgets aren't hot-reloaded. Built-in widgets go through
the same frame, CSP and domains as any other: if one needs something, the
others get it too. They share `src/widgets/shared/`: `napplet.ts` (typed
`window.napplet`, `followTheme`, `followShape`, `instanceStore`), `dom.ts`
(no framework, just `h()` and `s()` for elements) and `base.css`.

## Widgets from Nostr: `napplet://<hash>/`

The gallery lists kind 35129 manifests from the user's relays, or finds one
by `naddr1…`. `parseNappletManifest` (`src/lib/widgets.ts`) checks what
NIP-5D asks: a manifest kind (5129, 15129, 35129), a valid signature,
exactly one `x` tag, a description, a `d` tag only on 35129. Before adding
one, the user sees its permission screen (and what it asks for that Din
doesn't offer yet). Its `icon` tag is fetched the same way as the artifact
(`dinos.widgets.icon`, 1 MB at most), checked against its hash, and shown
only if it decodes as an image.

The desktop asks main to `dinos.widgets.fetch(sha256, servers)`: main
fetches the artifact from the manifest's `server` hints and Din's Blossom
servers (https only, 8 MB at most), keeps it in `<userData>/Widgets/` only
if its sha256 is the `x` tag, and checks it again each time it's served.
The host of `napplet://` *is* that hash (base32, 52 characters), so the
bytes behind a URL can only ever be the bytes it names. A placed widget is
pinned to the version it was added at.

## Widgets from folders: `widget+file://<hash>/`

**From a Folder** in the gallery opens Din's file picker for a folder with
an `index.html`, and shows the same permission screen as a widget from
Nostr. It's how a widget is made: point Din at the folder you're working
in and it shows on the desktop as you edit.

- **Metadata** comes from the page's `<head>`, as NIP-5D's "HTML Metadata
  for Publishing" has it: `<title>`, `<meta name="description">`,
  `napplet-id`, `napplet-requires` and `napplet-optional` (whitespace
  separated domains), `napplet-source`, `napplet-server` and
  `<link rel="icon">` (`parseFileWidget`, with `DOMParser`, which runs and
  loads nothing). It's read again on every load; a domain the page newly
  asks for starts off, for the user to turn on in About This Widget.
- **One page.** A napplet is a single file, so main
  (`folderArtifact`) inlines what the page names from inside the folder:
  classic `<script src>` (`defer` and `async` ones moved to the end of the
  body), `<link rel="stylesheet">`, and `<link rel="icon">` and `<img>`
  files as `data:` URLs. Nothing outside the folder, no module `import`s,
  and nothing from the web: that runs under the same CSP as any widget.
  Bundle anything bigger (Vite with `vite-plugin-singlefile`, say) and
  point Din at the output.
- **Live.** `dinos.widgets.folder(path)` (the desktop only) serves the
  folder at `widget+file://<host>/`, the host being the sha256 of its path
  in base32, and watches it: a change sends `dinos-widgets:changed`, and
  each copy of it reads the folder again and reloads. A placed copy keeps
  its path (`FileSource`) and opens the folder again when Din starts.
  Main only ever serves folders the desktop opened.
- Its identity, for storage, is `file:<path>`.
- **`din widgets add-folder <folder>`** does the same from a terminal (`docs/din-command.md`):
  the widget's permission screen comes up on its own, or, if it asks for no
  permissions, it goes straight on the desktop.

**Publish to Nostr…** (its menu, or About This Widget) shares it as a
napplet: the page, byte for byte as it runs here, goes to the user's
Blossom servers (and its icon, decoded from the `data:` URL, if it's PNG,
JPEG or WebP), then the user signs a kind 35129 manifest
(`nappletManifestTemplate`): `d` (its `napplet-id`, or the folder's name),
`x`, `title`, `R`, `O`, `icon`, `server` for each Blossom server and
`source` if it's a location NIP-5D accepts, with the description as the
content. Publishing the same identifier again replaces it; copies already
placed stay pinned to the version they were added at. The dialog gives the
`naddr` to share.

## The domains Din answers

`grantedDomains`: what the widget declared (`R` and `O` tags, or a built-in's
`domains`), of `SUPPORTED_DOMAINS`, plus `shell`, less what the user turned
off. Declarations never widen that. Messages for any other domain are
dropped, as NIP-5D asks.

| Domain | What Din does |
|---|---|
| `shell` | `shell.ready` → `shell.init` with the granted domains, once per load |
| `theme` | `theme.get` and `theme.changed`: Din's `background`, `foreground` and `primary` tokens as hex |
| `identity` | `getPublicKey` (`""` signed out) and `identity.changed`, `getRelays` (NIP-65), `getProfile` (kind 0, through the desktop's profile cache), `getFollows` (kind 3). The rest answer `not supported` |
| `storage` | `get`, `set`, `remove`, `keys`, shared (the widget) or `scope: "instance"` (this copy), 512 KB each, in the desktop's `localStorage` under `din:widget-storage:`. Removing a copy forgets its instance storage |
| `resource` | `bytes(url)` for https URLs (`data:` the shim decodes itself), fetched by main (`dinos.widgets.resource`) from a cookieless in-memory session, never from a private or local address (checked again on every redirect), 10 MB at most. `info` and `bytesMany` answer `unsupported` |

A widget's identity, for storage, is `builtin:<id>`, `35129:<pubkey>:<d>`,
`15129:<pubkey>`, a snapshot's event id, or `file:<path>`: from the
verified manifest (or the folder the user chose), never from the widget.

## Where things live

| Path | What |
|---|---|
| `electron/widgets.mts` | The schemes, the session and its policy, artifacts and their cache, folders, ports |
| `electron/widget-preload.cjs` | The host page: the srcdoc frame and the relay |
| `src/lib/widgetGrid.ts` | The grid: cells, fitting, free space |
| `src/lib/widgets.ts` | Sizes, built-in manifests, manifest parsing, `dinos.widgets`, ports |
| `src/lib/widgetStorage.ts` | NAP-STORAGE's areas |
| `src/contexts/WidgetsContext.ts`, `src/components/desktop/widgets/` | The layout (`din:widgets`), the layer, each frame and its NAP host, the menu, the gallery, permissions and icons, publishing |
| `src/widgets/` | The built-in widgets |

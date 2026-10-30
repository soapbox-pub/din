# Widgets

> **Status: in place.** The built-in Clock, Sticky Note and Profile; widgets
> from Nostr by `naddr` or from the gallery; the `shell`, `theme`,
> `identity` and `storage` domains. Not yet: `relay`, `notify`, `resource`,
> `link`, `media` and `intent`, updating a widget to a newer manifest, and
> syncing the layout between computers.

Widgets sit on the desktop, over the wallpaper and under every window. Each
is a **napplet**: a small, single-purpose page described by
[NIP-5D](https://github.com/nostr-protocol/nips/pull/2303), which reaches
the desktop only through the capabilities ("NAP domains",
[napplet/naps](https://github.com/napplet/naps)) the desktop gives it on
`window.napplet`. Users only ever see the word "widget", the way nsites are
"apps".

Right-click the desktop for **Add Widgets…** (the gallery) and **Edit
Widgets** (drag to arrange, × to remove). Right-click a widget for Edit
Widgets, Size (Small, Medium, Large), Reload, About This Widget… and
Remove Widget.

## Where a widget runs

```
┌ the desktop (app://din) ───────────────────────────────────────────┐
│  WidgetFrame: the card, the menu, the NAP host (useNappletHost)    │
│      ▲ MessagePort (main made it; bound to the guest's URL)        │
│ ┌────┴ <webview> in persist:widgets, a process of its own ───────┐ │
│ │ widget://clock/ or napplet://<sha256 in base32>/               │ │
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
- **No network.** `connect-src 'none'`, `img-src data: blob:` and the rest,
  and the `persist:widgets` session cancels every http(s) and ws(s)
  request besides. Downloads, pop-ups, permissions and navigation away are
  refused (`attachWidgetGuest`).
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

`icon` is a lucide name for the gallery, `domains` what the widget may use
(reviewed like an app's permissions), `size` where it starts. A widget lays
itself out for whatever box it's in.

`scripts/build-widgets.mjs` builds each into one self-contained file,
`dist/widgets/<id>/index.html`, script, styles and fonts inlined (a napplet
loads nothing), and copies the prelude beside them. It runs in `npm run
build`, `npm test`, `npm run dev` and the Nix build; rerun it after changing
a widget, since widgets aren't hot-reloaded. Built-in widgets go through
the same frame, CSP and domains as any other: if one needs something, the
others get it too. They share `src/widgets/shared/` (`napplet.ts`, typed
`window.napplet`, and `base.css`).

## Widgets from Nostr: `napplet://<hash>/`

The gallery lists kind 35129 manifests from the user's relays, or finds one
by `naddr1…`. `parseNappletManifest` (`src/lib/widgets.ts`) checks what
NIP-5D asks: a manifest kind (5129, 15129, 35129), a valid signature,
exactly one `x` tag, a description, a `d` tag only on 35129. Before adding
one, the user sees what it will be able to do (and what it asks for that
Din doesn't offer yet).

The desktop asks main to `dinos.widgets.fetch(sha256, servers)`: main
fetches the artifact from the manifest's `server` hints and Din's Blossom
servers (https only, 8 MB at most), keeps it in `<userData>/Widgets/` only
if its sha256 is the `x` tag, and checks it again each time it's served.
The host of `napplet://` *is* that hash (base32, 52 characters), so the
bytes behind a URL can only ever be the bytes it names. A placed widget is
pinned to the version it was added at.

## The domains Din answers

`grantedDomains`: what the widget declared (`R` and `O` tags, or a built-in's
`domains`), of `SUPPORTED_DOMAINS`, plus `shell`. Declarations never widen
that. Messages for any other domain are dropped, as NIP-5D asks.

| Domain | What Din does |
|---|---|
| `shell` | `shell.ready` → `shell.init` with the granted domains, once per load |
| `theme` | `theme.get` and `theme.changed`: Din's `background`, `foreground` and `primary` tokens as hex |
| `identity` | `getPublicKey` (`""` signed out) and `identity.changed`, `getRelays` (NIP-65), `getProfile` (kind 0, through the desktop's profile cache), `getFollows` (kind 3). The rest answer `not supported` |
| `storage` | `get`, `set`, `remove`, `keys`, shared (the widget) or `scope: "instance"` (this copy), 512 KB each, in the desktop's `localStorage` under `din:widget-storage:`. Removing a copy forgets its instance storage |

A widget's identity, for storage, is `builtin:<id>`, `35129:<pubkey>:<d>`,
`15129:<pubkey>`, or a snapshot's event id: from the verified manifest,
never from the widget.

## Where things live

| Path | What |
|---|---|
| `electron/widgets.mts` | The schemes, the session and its policy, artifacts and their cache, ports |
| `electron/widget-preload.cjs` | The host page: the srcdoc frame and the relay |
| `src/lib/widgets.ts` | Sizes, built-in manifests, manifest parsing, `dinos.widgets`, ports |
| `src/lib/widgetStorage.ts` | NAP-STORAGE's areas |
| `src/contexts/WidgetsContext.ts`, `src/components/desktop/widgets/` | The layout (`din:widgets`), the layer, each frame and its NAP host, the menu, the gallery |
| `src/widgets/` | The built-in widgets |

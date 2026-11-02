# Din Nostr Schemas

This document describes how Din uses Nostr to store desktop state and share
what a desktop looks like. Din builds on existing NIPs, and defines three
kinds of its own, for cursor themes, icon themes and Media Player skins, in a
range it keeps for itself:
**346xx**, "DIN" on a phone keypad. The last two digits spell the type the
same way.

| Kind | Keypad | What |
|---|---|---|
| 34628 | DIN-**CU** | [Cursor theme](#cursor-themes-kind-34628) |
| 34642 | DIN-**IC** | [Icon theme](#icon-themes-kind-34642) |
| 34675 | DIN-**SK** | [Media Player skin](#media-player-skins-kind-34675) |

Browser extensions are [NIP-82](#browser-extensions-nip-82) software instead.

## Encrypted App Data (NIP-78, kind 30078)

Din stores per-user desktop state as [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md)
"Arbitrary custom app data" events (kind 30078, addressable). All of Din's
`d` tags live under the reverse-DNS namespace `computer.din.*`, per NIP-78's
uniqueness recommendation.

### Encryption

The `content` field is always **NIP-44 encrypted to the user's own pubkey**
(encrypt-to-self). Relays only ever see opaque ciphertext. The plaintext is a
versioned JSON envelope:

```json
{ "v": 1, "data": <arbitrary JSON value> }
```

- `v` — envelope version, currently always `1`.
- `data` — the stored value; its schema depends on the `d` tag (see below).

If the user's signer does not support NIP-44, Din keeps the data local-only
and never publishes plaintext.

### Synchronization semantics

- **Addressable / last-write-wins:** relays keep only the latest event per
  `pubkey + kind + d`. Din reconciles local and remote copies by comparing
  the event `created_at` to the local cache timestamp; the newer copy wins.
- **Author-filtered reads:** Din only ever queries these events with
  `authors: [user.pubkey]` — the `d` tag alone is never treated as a trust
  boundary.
- Din also caches each value locally (keyed by pubkey) so the desktop works
  offline; sync is opportunistic.

### Keys currently in use

| `d` tag | `data` schema | Purpose |
|---|---|---|
| `computer.din.settings` | `{ "theme": "light" \| "dark" \| "system", "useAppBlossomServers": boolean }` | Desktop settings that roam across devices |
| `computer.din.web-apps` | `{ "id": string, "name": string, "url": string, "icon"?: string, "themeColor"?: string, "nostr"?: { "url": string, "kinds": number[] \| null } }[]` | Websites installed as desktop apps (PWA-style); `url` and `icon` are https URLs. `nostr` is how the site opens `nostr:` links, from its manifest's `protocol_handlers`: `url` is on the site's origin with `%s` for the link, `kinds` null for every kind |
| `computer.din.nostr-link-defaults` | `{ [kind: string]: string }` | The app (by desktop app id) each kind's `nostr:` links open in without asking, chosen with "Always" in the Open with dialog |
| `computer.din.nsite-apps` | `{ "host": string, "installedAt": number, "name"?: string }[]` | [NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md) nsites installed as desktop apps. `host` is the site's canonical host (`npub1…` for a root site, `<pubkeyB36><d>` for a named one), never a NIP-05 name; `installedAt` is Unix seconds; `name` is set only when the user renamed the app. Only addresses roam: each device keeps the signed manifests and files itself, and installs whatever the list names that it doesn't have |
| `computer.din.themes` | `{ "a": string, "addedAt": number }[]` | Other people's named themes the user added from the App Store, listed under Your Themes in Settings → Themes. `a` is the theme's `36767:<pubkey>:<d>` coordinate; `addedAt` is Unix seconds. Only addresses roam: each device reads the newest version of each theme from relays |
| `computer.din.extension-keys` | `{ [d: string]: string }` | The keys (PKCS#8 PEM) the user's browser extensions are signed with when Din packages them, by the `d` of their NIP-82 app; each is its extension's id, so publishing it again from another computer keeps it ([Browser extensions](#browser-extensions-nip-82)) |
| `computer.din.signer-permissions` | `{ [origin: string]: { "status": "connected" \| "blocked", "name"?: string, "methods": { [method: string]: "allow" \| "deny" }, "kinds": { [kind: string]: "allow" \| "deny" }, "createdAt": number, "lastUsed": number } }` | Sites and installed apps connected to the account through Din's NIP-07 signer, and what each may do without asking: `methods` holds `nip04.encrypt` / `nip04.decrypt` / `nip44.encrypt` / `nip44.decrypt`, `kinds` holds `signEvent` per event kind; times are Unix ms |

### Retired keys

Din used to sync these keys but now keeps them on the device only. On login
it deletes any existing events for them with a NIP-09 kind 5 event carrying
an `a` tag per address (`30078:<pubkey>:<d>`), an `e` tag for each version of
those events it found (some relays only delete addressable events named by
id), and `["k", "30078"]`.

| `d` tag | Was |
|---|---|
| `computer.din.pinned-apps` | Apps pinned to the dock (`string[]` of app IDs) |
| `computer.din.browser-history` | Web browser history |

### Example event

```json
{
  "kind": 30078,
  "pubkey": "<user pubkey>",
  "created_at": 1767225600,
  "tags": [["d", "computer.din.settings"]],
  "content": "<NIP-44 ciphertext of {\"v\":1,\"data\":{\"theme\":\"dark\",\"useAppBlossomServers\":true}}>",
  "sig": "..."
}
```

## Cursor themes (kind 34628)

An [XCursor](https://www.x.org/releases/current/doc/man/man3/Xcursor.3.xhtml)
theme, the kind Linux desktops use, as its `cursors/` directory: one
[Blossom](https://github.com/hzrd149/blossom) blob per cursor file, and a tag
for each other name a file goes by (the symlinks in that directory).
Addressable, so publishing it again under the same `d` updates it.

| Tag | Required | Meaning |
|---|---|---|
| `["d", <id>]` | yes | The theme's directory name, which is what XCursor calls it |
| `["title", <name>]` | yes | Its name, as people see it |
| `["summary", <text>]` | no | A description |
| `["alt", "Cursor theme: <name>"]` | yes | NIP-31 |
| `["cursor", <name>, <sha256>, <bytes>]` | yes, one or more | A cursor file, e.g. `left_ptr`: the sha256 of its XCursor file (a Blossom blob) and its size |
| `["link", <alias>, <name>]` | no, many | Another name for a cursor, e.g. `["link", "arrow", "left_ptr"]` |
| `["inherits", <id>]` | no, many | A theme it falls back to for cursors it lacks, as in `index.theme`'s `Inherits=` |
| `["image", <url>]` | no | A PNG of a few of its cursors, for showing it |
| `["server", <url>]` | yes, one or more | Blossom servers holding its files |
| `["t", "cursor-theme"]` | yes | |

A theme must have `left_ptr` among its cursors or links. `content` is empty.

## Icon themes (kind 34642)

A [freedesktop icon theme](https://specifications.freedesktop.org/icon-theme-spec/latest/)
as one gzipped tarball of its directory, since a big set has tens of
thousands of files, more than an event can list. Addressable like cursor
themes.

| Tag | Required | Meaning |
|---|---|---|
| `["d", <id>]` | yes | The theme's directory name, which is what other themes' `Inherits=` call it |
| `["title", <name>]` | yes | Its name, as people see it |
| `["summary", <text>]` | no | A description |
| `["alt", "Icon theme: <name>"]` | yes | NIP-31 |
| `["archive", <sha256>, "application/gzip", <bytes>]` | yes | The theme as a `.tar.gz` blob, and its size, which the App Store shows |
| `["icon", <name>, <sha256>, <mime>]` | no, many | A few of its icons (`image/svg+xml` or `image/png` blobs), for showing it |
| `["inherits", <id>]` | no, many | The themes it builds on, as its `index.theme`'s `Inherits=` |
| `["server", <url>]` | yes, one or more | Blossom servers holding its files |
| `["t", "icon-theme"]` | yes | |

The archive's paths are relative to the theme's directory (`index.theme`,
`48x48/apps/firefox.png`), and it must hold `index.theme`. Each file is in it
once; other names for the same file are symlinks, relative, to a file in the
archive. Din leaves out `icon-theme.cache` both ways. `content` is empty.

### Publishing, finding and installing

Settings → Cursors and Icons publish an installed theme from its menu, and
the `din cursors|icons publish` commands do the same. The App Store's Cursors
and Icons list themes by its catalog publishers, the people the user follows,
and the user, honoring NIP-09 deletions (kind 5 with `e`, `a` and `["k",
"34628"]` or `["k", "34642"]`) by the theme's own author.

Installing downloads every blob from the event's servers, then its author's
BUD-03 list (kind 10063), then Din's own, checks each against its hash, and
writes the theme into `~/.local/share/icons/<d>` (with a number after it if
something else has that name). Its `index.theme` gets
`X-Din-Source=<kind>:<pubkey>:<d>` and `X-Din-Published=<created_at>`, which
is how Din knows a newer version is out, and `X-Din-Imported=true`, which
lets it remove the theme again. Din writes an archive's symlinks itself, each
to a file it wrote, so none can lead out of the theme, and installs the
parents an icon theme names but the computer lacks when the same author
published them.

## Media Player skins (kind 34675)

A skin for Din's Media Player: a classic Winamp skin (`.wsz`) or a Windows
Media Player skin (`.wmz`), each already one zip file, as one Blossom blob.
Addressable like cursor and icon themes.

| Tag | Required | Meaning |
|---|---|---|
| `["d", <id>]` | yes | The skin's file name without its extension |
| `["title", <name>]` | yes | Its name, as people see it |
| `["summary", <text>]` | no | A description |
| `["alt", "Media Player skin: <name>"]` | yes | NIP-31 |
| `["skin", <sha256>, "winamp" \| "wmp", <bytes>]` | yes | The skin file (a Blossom blob), which player it's for, and its size, which the App Store shows |
| `["image", <url>]` | no | A PNG of the skin, as the Media Player's skin chooser draws it |
| `["server", <url>]` | yes, one or more | Blossom servers holding its file |
| `["t", "media-player-skin"]` | yes | |

A `winamp` skin is a zip of Winamp 2.x bitmaps and text files; a `wmp` skin
is a zip holding a `.wms` file, or a bare `.wms`. `content` is empty.

The Media Player's Skins tab publishes a skin from its toolbar and
right-click menu, by handing it to the App Store, which signs and uploads it;
`din skins publish` does the same. The App Store's Skins tab lists them as it
does cursor and icon themes, honoring deletions with `["k", "34675"]`.
Installing downloads the blob as for themes, checks its hash and that it is
a skin of the format it says, and writes it into the player's skins folder,
`~/.local/share/din/skins/<d>.wsz` (or `.wmz`), numbered if another file has
that name. A file has no `index.theme`, so `.nostr.json` in that folder
records, by file name, the `coordinate` (`<kind>:<pubkey>:<d>`) and
`publishedAt` (`created_at`) each came from, for Update and Remove. Use opens
the Media Player wearing it.

## Browser extensions (NIP-82)

Extensions for Din's Web Browser are published as NIP-82 software
([draft](https://github.com/nostr-protocol/nips/pull/2526)): an
application (kind 32267), a release per version (kind 30063), and the
release's asset (kind 3063), a Chrome extension package (`.crx`, version 3,
`application/x-chrome-extension`) on the publisher's Blossom servers. Din
follows the draft, and adds:

- **The platform `chromium`** (`["f", "chromium"]`): a Chromium-based
  browser, which is what runs a `.crx`, in place of the operating systems
  and architectures NIP-82's platform identifiers list. Like `wasm32`, it
  names a runtime, and NIP-82 already takes `min_platform_version` on a
  `.crx` to be the Chrome version. It's on the application, release and
  asset, so `{"kinds": [32267], "#f": ["chromium"]}` finds extensions and
  nothing else, one event each.
- **`permission` and `host` tags on the asset**: the API permissions its
  manifest asks for, and the sites it can read and change (from
  `host_permissions`, the match patterns in `permissions`, and content
  scripts' `matches`), for showing before downloading it. Installing reads
  them again from the package.

| Event | Din's tags |
|---|---|
| 32267 | `d` (the `d` it was installed under, its Web Store id, or its name made a slug), `name`, `["f", "chromium"]`, `summary`, `icon` (the biggest icon its manifest names), `alt`; content is its description |
| 30063 | `i`, `version` (the manifest's), `d` (`<i>@<version>`), `["c", "main"]`, the same `f`, `e` (the asset) |
| 3063 | `i`, `x`, `version`, `m`, the same `f`, `url`, `size`, `filename`, `min_platform_version` (the manifest's `minimum_chrome_version`), `permission`, `host`, `alt` |

The package's signing key is the extension's id. A Web Store extension is
published as Google's own package of it, which keeps its id; one installed
from Nostr as the package it came in; and one loaded from a folder (or no
longer in the Web Store) is signed by Din with an ECDSA P-256 key of its own,
which Din keeps in the user's encrypted app data (`computer.din.extension-keys`,
`{ [d: string]: string }` of PKCS#8 PEM) so the same extension has the same id
from any of the user's computers.

**Finding them.** `about:extensions`, an internal page of the browser, lists
the extensions Din's publishers, the people the user follows, and the user
publish. Din keeps those authors' applications with `["f", "chromium"]`,
one event per extension, and their deletions (kind 5 with `["k", "32267"]`,
`"30063"` or `"3063"`), in IndexedDB. The page draws from that at once, then
syncs: an author new to it is asked for everything, the rest for what's newer
than their last sync, and what comes back is merged in. Releases and assets,
which pile up with every version, aren't synced: an app's newest `main`
release (`{"kinds": [30063], "#i": [<d>], "#c": ["main"], "limit": 1}`, the
newest by `created_at`, which NIP-82 makes the release date) and its asset by
id are fetched, and kept, when its page is opened or it's got, and for every
installed extension after each sync, in one request, to tell which have an
update (its newest package's hash differs from the installed one's). A `nostr:` link to an app the page knows to
be an extension opens its page there.

**Installing.** Get downloads the package from the asset's servers, the
author's BUD-03 list (kind 10063) and Din's, checks its hash, checks every
signature in it and that one is by the key its id comes from, then asks the
user with what its manifest asks for, as Web Store installs do (an update
asks again only when it wants more). Din unpacks it into the browser's
`NostrExtensions/<d>` (numbered if taken) with its key set as the manifest's
`key`, as Chrome does, so it has the id it was published with, keeps the
package in `NostrExtensions/.crx/`, and records the app's coordinate, the
release's `created_at` and the asset's hash in `NostrExtensions/.nostr.json`,
for Update and Remove. A copy of the same extension already installed
another way is replaced. Deleting one of the user's own from Nostr deletes
its app, releases and assets.

## Other kinds Din reads/writes (standard usage, no extensions)

| Kind | NIP | Usage |
|---|---|---|
| 0 | NIP-01 | Profile metadata (published on signup) |
| 10002 | NIP-65 | Relay list; read on login, published from Settings → Nostr & Storage |
| 10063 | BUD-03 | Blossom server list; read on login, published from Settings → Nostr & Storage |
| 32267, 30063, 3063 | NIP-82 (draft) | Browser extensions: published from the browser's Settings, listed on `about:extensions` from a synced copy kept on the device ([Browser extensions](#browser-extensions-nip-82)) |
| 15128, 35128 | NIP-5A | nsite manifests; read to serve `nsite://` sites, and kept (signature-checked) in the device's nsite store for sites that were opened or installed |
| 16767 | Profile Themes | Active profile theme; applied as the OS theme, and published when a synced custom theme changes. A theme worn from a named one carries Ditto's credit tags: `["a", "36767:<pubkey>:<d>"]`, plus `["p", <pubkey>]` when someone else made it. Editing someone else's theme drops both |
| 36767 | Profile Themes | Named themes, in the same `c`/`f`/`bg` tags as 16767 plus `d`, `title`, optional `description`, `alt` and `["t", "theme"]`, as Ditto writes them. The App Store's Themes lists those by its catalog publishers, the people the user follows, and the user; Settings → Themes saves the custom theme as one, updates one under its `d`, and deletes one with a NIP-09 kind 5 carrying `e`, `a` and `["k", "36767"]` |
| 3 | NIP-02 | Follow list; read to list what the people the user follows publish in the App Store |
| 5 | NIP-09 | Deletions of the user's own named themes, cursor and icon themes, Media Player skins, and browser extensions (their NIP-82 app, releases and assets) |
| 22242 | NIP-42 | Relay authentication |

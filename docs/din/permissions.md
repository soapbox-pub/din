# Permissions and `din.system`

> **Status: in place** for apps on `din://`.

## What every app has

No permission needed:

- its own window, menus, and child windows;
- files the user hands it, with read and (unless read-only) write access
  to just those ([files.md](files.md));
- drag and drop, and the file clipboard (receiving grants files the same
  way);
- the theme;
- opening other apps, files it holds, and URLs;
- printing (`window.print()`);
- its own origin's storage and the network.

## What an app asks for

In its manifest's `din.permissions` ([manifest.md](manifest.md)). For
built-in apps the list is reviewed in code review; there's no prompt.
When nsites get `window.din`, the user approves the list at install.

| Permission | Grants | Built-in apps that need it |
|---|---|---|
| `nostr` | `window.nostr` (NIP-07): the signed-in user's pubkey, and signing as them | Calendar |
| `fs` | `din.system.fs`: the whole filesystem by path; `path` on handles | Files, Text Editor |
| `pty` | `din.system.pty`: terminals | Terminal |
| `notifications` | `new Notification()` and `navigator.setAppBadge()`; with `background`, `registration.showNotification()` from the app's service worker | Assistant, Terminal |
| `background` | `registration.periodicSync`: the app's service worker woken on a schedule while no window is open, at most every 15 minutes ([background.md](background.md)). Listed in Settings → Background Activity, where the user can pause or remove it | — |
| `wallpaper` | `din.desktop.setWallpaper`: make a picture the desktop's background | Preview |
| `cursor` | `din.desktop.setCursor`: install a cursor theme and make it the pointer | Preview |
| `assistant` | `din.system.assistant`: the Assistant's OpenCode service. Only the Assistant reaches all of it (Claude Code's install and sign-in, and git for its Git panel, `assistant:git`, among it); any other app talks only to conversations it started, in `~/.cache/din/<id>-assistant/`, hears only their events, and can't answer sudo | Assistant, CAD |
| `assistant-sudo` | `din.system.assistant`'s `passwords`, `answerPassword` and `approve`: answering sudo when a conversation's command asks. An app with `assistant` alone hears no requests and can't answer one. Built-in apps only: an app from a folder or the `din` command can't ask for it | Assistant |
| `indd` | `din.system.indd`: InDesign conversion | Publisher |
| `volumes` | `din.system.volumes`: removable disks and USB phones. Files can also mount and unmount fixed volumes. Mounting or unlocking a fixed volume may ask for administrator authentication | Files |
| `drive` | `din.system.drive`: whether Din Drive (the encrypted drive at ~/Drive) is on, and turning it on; its trash and the rest stay in Settings | Files |
| `mail` | `din.system.mail`: the user's IMAP and SMTP accounts (`src/lib/mail.ts`), run in main by `electron/mail.mts`. Passwords stay in main, sealed with the keyring; the app never sees them. Mail already seen is kept in `userData/mail/<account>.db`, so it reads offline. Conversations are put together from the server's thread id (Gmail's X-GM-THRID, OBJECTID's THREADID) or each message's Message-ID, In-Reply-To and References, and `conversation` finds the rest of one in the inbox, Sent and Archive (All Mail on Gmail). Senders' pictures are looked up in main (`electron/mail-avatars.mts`), only for senders whose DKIM passed, from their domain's NIP-05 profile or BIMI logo, never Gravatar, and kept for weeks; Settings can turn it off. Subscriptions reads the inbox's List-Unsubscribe headers and leaves lists: a one-click POST from main only to public https hosts, or an email from the account. The inbox has Gmail's tabs (Primary, Promotions, Social, Updates, Forums): Gmail's own sorting on Gmail (asked for with X-GM-RAW `category:` searches), a guess from a few headers, the sender and the subject elsewhere (`electron/mail-categories.mts`, sorted again when its rules change), and the senders the user moved to a tab, kept with the account; mail from someone the user has written to (the addresses in Sent) stays in Primary unless it's a list's; and sign-ins (codes, links, new sign-in alerts) and a service's notices of threads the user is part of (GitHub's and GitLab's stated reasons: author, comment, mention, review requested…) are Primary wherever the guess would put them. Updates is shown by default as well as Promotions and Social. Main watches each inbox from the moment Din starts, and the desktop announces new mail (`MailHost`) and puts the unread count on Mail's tile, Mail open or not; only Primary's, unless the user asks for all of it | Mail |
| `phone` | `din.system.phone`: the texts on the user's phones (`src/lib/phone.ts`), run in main by `electron/phone.mts`: conversations, their messages, contacts, sending, marking read, deleting a conversation here. Adding and forgetting phones are Settings → Phone's, not the app's | Messages, Contacts |
| `passwords` | `din.system.passwords`: the password vault's items, locking and unlocking it, generating passwords, copying a field (cleared from the clipboard after 90 seconds), importing a KeePass file or another app's export. Not the browser's autofill, which is the desktop's | Passwords |
| `capture` | The camera, the microphone and the whole screen in the app's own page (`getUserMedia`; `getDisplayMedia` gives the screen as the shell draws it, with no picker), and `din.system.capture`: projects in `~/Videos/Studio` and their takes, written as they're recorded, and clips the app hands it, the screen recorded with its pointer by wf-recorder, transcripts, and live streams over RTMP through FFmpeg (`electron/capture.mts`). Stream keys stay in main, sealed with the keyring | Studio |
| `camera` | The camera and the microphone in the app's own page (`getUserMedia`), never the screen. No bridge: main's permission handlers check it (`grantCamera` in `electron/din-apps.mts`) | Camera |
| `microphone` | The microphone alone in the app's own page (`getUserMedia` asking for audio only), never the camera or the screen. No bridge: main's permission handlers check it (`grantMicrophone`) | Assistant |
| `preview` | Frames of web pages beside the app's own: a server on this computer (`http://localhost`, `127.0.0.1` or `[::1]`, any port) and HTML files through `din.files.pageUrl(handle)`, a `din-file://<token>/<name>` URL whose token serves only the page's own folder ([files.md](files.md#web-pages)). Never a top frame, and never a folder holding home or Din's own files. A file's page is served under a CSP `sandbox` (an opaque origin, readable by itself through `*` CORS), and a framed page gets none of the app's permissions. The app's CSP names them in `frame-src`. No bridge: main checks frame navigation against it (`grantPreview`, `previewable` in `electron/din-apps.mts`) | Assistant |
| `vms` | `din.system.vms`: QEMU virtual machines in `~/VMs` (`src/lib/vms.ts`), run in main by `electron/vms.mts`: creating, starting and stopping them, installing a system on a new one (downloaded by main from the system's own servers, `electron/vm-installers.mts`), their settings and snapshots, and their screens as RFB streams (the bytes go only to the window that opened one). A machine's CD drive takes any path, so this reaches what `fs` reads | Virtual Machines |
| `games` | `din.system.games`: the games in `~/roms` (`src/lib/games.ts`), read and played by `electron/games.mts`: the library (systems, games and their copies, box art from libretro-thumbnails, favorites, play time), playing a game full screen in RetroArch as an app of its own, quitting it, and where each was left. A game is named by its id and a copy by one of its own paths: the app can't run a file or program of its choosing | Games |
| `flasher` | `din.system.flasher`: USB drives and memory cards plugged in, and erasing one and writing a disk image to it (`src/lib/flasher.ts`), by `electron/usb-flasher.mts`: a file by path (which it reads as the user, so this reaches what `fs` reads, but only onto a drive), or DinOS built from the commit running. Main lists only removable drives with nothing of the system's on them, and its root helper (`electron/din-flash.sh`) checks the drive again itself. The job runs in main, pushed as `flasher:changed`, and goes on with the window closed. Built-in apps only: it erases drives | USB Flasher |
| `torrents` | `din.system.torrents`: BitTorrent transfers (`src/lib/torrents.ts`), by a Transmission daemon of Din's own that `electron/torrents.mts` runs as the user and talks to over a Unix socket only the user can reach: adding a magnet link or a `.torrent` file by path (read as the user) into any folder, pausing, resuming, checking and removing transfers, which files of one to download, moving one, and Transmission's settings Din shows (speed limits, Turtle, seeding ratio, encryption, the port). Each is an operation main checks, never RPC passed through, so nothing sets the daemon's scripts or what it watches. Removing one with its data moves only what's in its folder to the Trash. Transfers run in main, pushed as `torrents:changed`, and go on with the window closed. Built-in apps only: it writes into any folder | Torrents |
| `features` | `din.system.features`: the optional features (Settings → Optional Features, `electron/features.mts`), whether one is installed, and installing it: DinOS's own, or the system's packages elsewhere, which asks for the password. Not removing them. Built-in apps only: an app from a folder can't ask for it, since it would start downloads of gigabytes, or password prompts, whenever it liked. `FeatureInstallButton` (`src/shared/FeatureInstall.tsx`) is the button, given the feature's id by what failed; it shows only while that feature can be installed and isn't | Files, Preview, Studio, Virtual Machines |
| `store` | `din.store`: what the App Store shows of this computer (who's signed in, the relays to read, what's installed and in use), pushed as it changes; installing nsites, Linux apps, cursor themes, icon sets and skins, using and removing them, and trying cursors, icons and themes on. Everything is named by where it's published (an nsite's host, an `naddr1…`): the desktop looks it up on the user's relays itself, keeping only its author's events, and installs what it finds, so nothing the app says about it is trusted. A Linux app asks on screen first, as deleting one of the user's own from Nostr does; publishing and adding an app from a folder are the desktop's own dialog and window (`publishSkin`, `addFolderApp`), since they sign and grant permissions. What a window tried on comes off when it closes. The app signs nothing. Built-in apps only | App Store |
| `file-folders` | `din.system.fs` scoped to the folders of files the user hands the app, and `din.files.parent(handle)` ([files.md](files.md#some-folders-by-path)) | Preview, Publisher |
| `input-method` | `din.inputMethod`: being a keyboard, shown where one goes, typing into whatever field has focus in any app, and hearing what's copied anywhere ([input-method.md](input-method.md)). Only hosts that show keyboards answer it (Din Phone); Din's desktop has none yet | Din Keyboard (in Din Phone) |

A manifest's `din.folders` scopes `din.system.fs` to fixed folders instead
(Media Player's music, videos and skins). Neither reaches anything else.

## `din.fetch`

A server that sends no CORS headers can't be read by an app's page, even
where its CSP allows it. A manifest's `din.fetch` names hosts (`"fetch":
["thumbnails.libretro.com"]`, Games, which keeps box art in its own
IndexedDB) that `din.fetch(input, init)` reaches anyway, with `fetch`'s
signature and a real streaming `Response` whose body and headers are the
app's to read. It's the request installed nsites get as `napp.fetch`
(`electron/napp-fetch.mts`), over a `fetch` bridge port of its own: https
only, anonymous (no cookies sent or kept), never the local network (checked
on the address connected to), 8 requests in flight per window, and only the
named hosts, exactly, redirects included. Names only: no ports or
wildcards. Built-in apps only, reviewed with the manifest; an app from a
folder or the `din` command doesn't get it. Without it, `din.fetch` rejects
with `DinPermissionError`; a host it doesn't name, with `TypeError`, as
`fetch` does.

Check at runtime with the web's Permissions API, which takes Din's names
as well as its own: `(await navigator.permissions.query({ name: 'fs' })).state`
is `granted` or `denied` (never `prompt`: the manifest decided), and the
web's names a permission grants answer the same way: `notifications`,
`periodic-background-sync` for `background`, `camera` and `microphone`
for `camera` or `capture`, and `display-capture` for `capture`. `usePermission('fs')` from
`@/sdk/react` is the same for a component. Calling something without its
permission rejects with `DinPermissionError`.

## `din.store`

The App Store's piece of the desktop, for the one app that shows
strangers' catalogs (`src/apps/app-store/`), answered by the desktop's
`StoreHost` (`src/components/desktop/dinHost/StoreHost.tsx`):

```ts
const state = await din.store.state();     // pubkey, relays, what's installed and worn
din.store.onChange((next) => render(next));
await din.store.install({ type: 'package', address: 'naddr1…' });
await din.store.tryOn('naddr1…');           // a cursor theme or icon set, until endTryOn()
await din.store.themes.use('naddr1…');      // then themes.revert() or themes.done()
```

The app reads the catalog itself, from the relays `state.relays` names,
with its own pool, and decodes what it shows (icons, screenshots, cursor
files, release notes) in its own process. The desktop never takes its word
for what something is: each request names an address, and the desktop
fetches what's published there, from its author, before it installs or
wears it. Nothing is signed for the app: deleting from Nostr asks on screen
and signs in the desktop, and publishing (`publishSkin`) is the desktop's
own Publish to Nostr dialog.

## `din.system`

The few apps whose job is the machine get a piece of the desktop's own
bridge ([../dinos/README.md](../dinos/README.md)):

```ts
const fs = din.system.fs;          // present only with 'fs'
const listing = await fs?.readdir('/home/din/Documents');
const off = fs?.onChange((path) => refresh(path));
```

These are the same interfaces the desktop uses (`FsBridge`,
`PtyBridge`, `PrintingBridge`), so code moves over unchanged.

They don't go through the desktop. When the app connects, the desktop
checks its grants and asks main for a port from the app straight to each
granted bridge ([../security-model.md](../security-model.md#how-a-port-is-made)):

Bridges with ports of their own: `fs`, `pty`, `assistant`, `assistant-sudo`, `indd`, `volumes`, `drive`, `mail`, `phone`, `passwords`, `vms`, `games`, `flasher`, `torrents`, `capture`, `features`, and `fetch` for `din.fetch`
(`SYSTEM_PERMISSIONS` in `electron/din-apps.mts`, mirrored in
`src/lib/dinApps.ts` and `src/sdk/runtime.ts`). A bridge's pushes reach the apps
granted it: a pty's output goes to the app that spawned it, and what main
sends the shell on `fs:changed` or `assistant:*` goes to granted apps too.

```
Terminal ──port──▶ Electron main (pty)      one hop, as window.pty is today
Terminal ──port──▶ desktop                  window, menus, files, drag
```

So a `cat` of a big log streams at the speed it does today, and a busy or
hung desktop doesn't make the terminal stutter. Calls cost the same as
`ipcRenderer.invoke`: the same Chromium pipe and structured clone, plus
the one copy `contextBridge` already makes for today's globals. Callbacks
(`onChange`, a pty's data) come back on the same port.

Main binds each port to the app and permission it was made for and
enforces the limits itself: `din.system.fs` can't reach Din's own Electron
profile (where the desktop's storage, and outside DinOS the signed-in
account's key, live), even for Files. On DinOS nostrd's keys belong to
another Unix user anyway. A pty port can touch only the terminals it
spawned, and they end with the grant. The desktop can revoke a grant,
which closes the port.

Printing needs neither: an app's `window.print()` goes to Din's print
dialog as a web page's does ([media-and-desktop.md](media-and-desktop.md)).

New system pieces are added as the apps that need them move over
(Settings needs most of `window.dinos`, and moves last). Each one gets a
permission here first.

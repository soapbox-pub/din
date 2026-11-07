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
| `nostr` | `window.nostr` (NIP-07): the signed-in user's pubkey, and signing as them | App Store, Calendar |
| `fs` | `din.system.fs`: the whole filesystem by path; `path` on handles | Files, Text Editor |
| `pty` | `din.system.pty`: terminals | Terminal |
| `notifications` | `new Notification()` and `navigator.setAppBadge()`; with `background`, `registration.showNotification()` from the app's service worker | Assistant, Terminal |
| `background` | `registration.periodicSync`: the app's service worker woken on a schedule while no window is open, at most every 15 minutes ([background.md](background.md)). Listed in Settings → Background Activity, where the user can pause or remove it | — |
| `wallpaper` | `din.desktop.setWallpaper`: make a picture the desktop's background | Preview |
| `cursor` | `din.desktop.setCursor`: install a cursor theme and make it the pointer | Preview |
| `assistant` | `din.system.assistant`: the Assistant's OpenCode service. Only the Assistant reaches all of it (Claude Code's install and sign-in, and git for its Git panel, `assistant:git`, among it); any other app talks only to conversations it started, in `~/.cache/din/<id>-assistant/`, hears only their events, and can't answer sudo | Assistant, CAD |
| `assistant-sudo` | `din.system.assistant`'s `passwords`, `answerPassword` and `approve`: answering sudo when a conversation's command asks. An app with `assistant` alone hears no requests and can't answer one. Built-in apps only: an app from a folder or the `din` command can't ask for it | Assistant |
| `indd` | `din.system.indd`: InDesign conversion | Publisher |
| `volumes` | `din.system.volumes`: removable disks and phones plugged in by USB, mounting, unlocking and ejecting | Files |
| `mail` | `din.system.mail`: the user's IMAP and SMTP accounts (`src/lib/mail.ts`), run in main by `electron/mail.mts`. Passwords stay in main, sealed with the keyring; the app never sees them. Mail already seen is kept in `userData/mail/<account>.db`, so it reads offline. Conversations are put together from the server's thread id (Gmail's X-GM-THRID, OBJECTID's THREADID) or each message's Message-ID, In-Reply-To and References, and `conversation` finds the rest of one in the inbox, Sent and Archive (All Mail on Gmail). Senders' pictures are looked up in main (`electron/mail-avatars.mts`), only for senders whose DKIM passed, from their domain's NIP-05 profile or BIMI logo, never Gravatar, and kept for weeks; Settings can turn it off. Subscriptions reads the inbox's List-Unsubscribe headers and leaves lists: a one-click POST from main only to public https hosts, or an email from the account. The inbox has Gmail's tabs (Primary, Promotions, Social, Updates, Forums): Gmail's own sorting on Gmail (asked for with X-GM-RAW `category:` searches), a guess from a few headers, the sender and the subject elsewhere (`electron/mail-categories.mts`, sorted again when its rules change), and the senders the user moved to a tab, kept with the account; mail from someone the user has written to (the addresses in Sent) stays in Primary unless it's a list's. Updates is shown by default as well as Promotions and Social. Main watches each inbox from the moment Din starts, and the desktop announces new mail (`MailHost`) and puts the unread count on Mail's tile, Mail open or not; only Primary's, unless the user asks for all of it | Mail |
| `phone` | `din.system.phone`: the texts on the user's phones (`src/lib/phone.ts`), run in main by `electron/phone.mts`: conversations, their messages, contacts, sending, marking read, deleting a conversation here. Adding and forgetting phones are Settings → Phone's, not the app's | Messages, Contacts |
| `passwords` | `din.system.passwords`: the password vault's items, locking and unlocking it, generating passwords, copying a field (cleared from the clipboard after 90 seconds), importing a KeePass file or another app's export. Not the browser's autofill, which is the desktop's | Passwords |
| `capture` | The camera, the microphone and the whole screen in the app's own page (`getUserMedia`; `getDisplayMedia` gives the screen as the shell draws it, with no picker), and `din.system.capture`: projects in `~/Videos/Studio` and their takes, written as they're recorded, and clips the app hands it, the screen recorded with its pointer by wf-recorder, transcripts, and live streams over RTMP through FFmpeg (`electron/capture.mts`). Stream keys stay in main, sealed with the keyring | Studio |
| `camera` | The camera and the microphone in the app's own page (`getUserMedia`), never the screen. No bridge: main's permission handlers check it (`grantCamera` in `electron/din-apps.mts`) | Camera |
| `vms` | `din.system.vms`: QEMU virtual machines in `~/VMs` (`src/lib/vms.ts`), run in main by `electron/vms.mts`: creating, starting and stopping them, installing a system on a new one (downloaded by main from the system's own servers, `electron/vm-installers.mts`), their settings and snapshots, and their screens as RFB streams (the bytes go only to the window that opened one). A machine's CD drive takes any path, so this reaches what `fs` reads | Virtual Machines |
| `games` | `din.system.games`: the games in `~/roms` (`src/lib/games.ts`), read and played by `electron/games.mts`: the library (systems, games and their copies, box art from libretro-thumbnails, favorites, play time), playing a game full screen in RetroArch as an app of its own, quitting it, and where each was left. A game is named by its id and a copy by one of its own paths: the app can't run a file or program of its choosing | Games |
| `file-folders` | `din.system.fs` scoped to the folders of files the user hands the app, and `din.files.parent(handle)` ([files.md](files.md#some-folders-by-path)) | Preview, Publisher |

A manifest's `din.folders` scopes `din.system.fs` to fixed folders instead
(Media Player's music, videos and skins). Neither reaches anything else.

Check at runtime with the web's Permissions API, which takes Din's names
as well as its own: `(await navigator.permissions.query({ name: 'fs' })).state`
is `granted` or `denied` (never `prompt`: the manifest decided), and the
web's names a permission grants answer the same way: `notifications`,
`periodic-background-sync` for `background`, `camera` and `microphone`
for `camera` or `capture`, and `display-capture` for `capture`. `usePermission('fs')` from
`@/sdk/react` is the same for a component. Calling something without its
permission rejects with `DinPermissionError`.

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

Bridges with ports of their own: `fs`, `pty`, `assistant`, `assistant-sudo`, `indd`, `volumes`, `mail`, `phone`, `passwords`, `vms`, `games`, `capture`
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

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
- toasts;
- its own origin's storage and the network.

## What an app asks for

In its manifest's `din.permissions` ([manifest.md](manifest.md)). For
built-in apps the list is reviewed in code review; there's no prompt.
When nsites get `window.din`, the user approves the list at install.

| Permission | Grants | Built-in apps that need it |
|---|---|---|
| `account` | `din.account`: pubkey, relays, Blossom servers | Assistant, App Store |
| `nostr` | `din.account.nostr` and `window.nostr`, signing as the signed-in user. Implies `account` | App Store |
| `fs` | `din.system.fs`: the whole filesystem by path; `path` on handles | Files, Text Editor |
| `pty` | `din.system.pty`: terminals | Terminal |
| `printing` | `din.print`: Din's print dialog for HTML or a file the app holds | Word Processor, Publisher, Preview |
| `notifications` | Notification center entries, the Dock badge | Assistant |
| `media-session` | `din.media`: report what's playing; hear the media keys and Din's media controls | Media Player |
| `wallpaper` | `din.desktop.setWallpaper`: make a picture the desktop's background | Preview |
| `cursor` | `din.desktop.setCursor`: install a cursor theme and make it the pointer | Preview |
| `assistant` | `din.system.assistant`: the Assistant's OpenCode service | Assistant, CAD |
| `indd` | `din.system.indd`: InDesign conversion | Publisher |
| `volumes` | `din.system.volumes`: removable disks, mounting and ejecting | Files |
| `mail` | `din.system.mail`: the user's IMAP and SMTP accounts (`src/lib/mail.ts`), run in main by `electron/mail.mts`. Passwords stay in main, sealed with the keyring; the app never sees them | Mail |
| `passwords` | `din.system.passwords`: the password vault's items, locking and unlocking it, generating passwords, copying a field (cleared from the clipboard after 90 seconds). Not the browser's autofill, which is the desktop's | Passwords |
| `file-folders` | `din.system.fs` scoped to the folders of files the user hands the app, and `handle.parent()` ([files.md](files.md#some-folders-by-path)) | Preview, Publisher |

A manifest's `din.folders` scopes `din.system.fs` to fixed folders instead
(Media Player's music, videos and skins). Neither reaches anything else.

Check at runtime with `din.permissions.has('fs')`. Calling something
without its permission rejects with `DinPermissionError`.

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

Bridges with ports of their own: `fs`, `pty`, `assistant`, `indd`, `volumes`, `mail`, `passwords`
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

Printing isn't a bridge: the print dialog is the desktop's, so
`din.print` goes to the desktop.

New system pieces are added as the apps that need them move over
(Settings needs most of `window.dinos`, and moves last). Each one gets a
permission here first.

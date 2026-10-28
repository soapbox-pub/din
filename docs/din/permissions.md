# Permissions and `din.system`

> **Status: design.** Today every built-in app can use every desktop
> global (`window.fs`, `window.pty`, `window.wifi`, …).

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
| `nostr` | `din.account.nostr` and `window.nostr`, through Din's prompts. Implies `account` | App Store |
| `fs` | `din.system.fs`: the whole filesystem by path; `path` on handles | Files, Text Editor |
| `pty` | `din.system.pty`: terminals | Terminal |
| `printing` | `din.system.printing` | Word Processor, Publisher, Preview |
| `notifications` | Notification center entries, the Dock badge | Assistant |
| `media-session` | Report what's playing; hear the media keys | Media Player |
| `wallpaper` | Set the desktop's wallpaper | Files, Preview |

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
enforces the limits itself: `din.system.fs` can't reach Din's own
configuration (`~/.config/din`) or nostrd's keys, even for Files. The
desktop can revoke a grant, which closes the port.

Files' contents are better read through handles than through
`fs.readFile`: a handle's `getFile()` streams from the local-file scheme
(as Preview and thumbnails do today) rather than sending a 200 MB file as
one message.

New system pieces are added as the apps that need them move over
(Settings needs most of `window.dinos`, and moves last). Each one gets a
permission here first.

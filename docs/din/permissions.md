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
`PtyBridge`, `PrintingBridge`), so code moves over unchanged. The SDK
proxies each call to the desktop, which forwards it to `window.dinos`;
callbacks (`onChange`, a pty's data) come back as pushes on the port.

A few things stay desktop-only even with `fs`: `din.system.fs` can't
reach Din's own configuration (`~/.config/din`) or nostrd's keys.

New system pieces are added as the apps that need them move over
(Settings needs most of `window.dinos`, and moves last). Each one gets a
permission here first.

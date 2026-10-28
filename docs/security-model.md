# Security model

> **Status: design.** Today every built-in app shares the desktop's origin
> and has all of its powers. This page describes the boundaries the app
> platform puts in place.

## What we defend against

- **A compromised app.** A document app parses untrusted files (DOCX,
  PSD, DWG, skins, playlists). A bug there must not reach anything beyond
  the files the user gave that app.
- **A hung or crashing app.** One app's infinite loop or out-of-memory
  must not stop the desktop, or any other app.
- **A hostile web page or nsite.** Unchanged from today: it gets what a
  browser gives it, plus what Din's guest preloads add (`window.nostr`
  with prompts, napp APIs for installed nsites).

We don't defend against a compromised desktop. The desktop holds the
signer and `window.dinos`, so an XSS there is game over; the rules in
`AGENTS.md` (no `innerHTML` with untrusted data, the CSP, sanitized URLs)
still apply, and moving apps out shrinks what code runs there.

## Origins and sessions

| Who | Origin | Session (partition) | Preload | Process |
|---|---|---|---|---|
| The desktop | `app://din` | default | `preload.cjs` → `window.dinos` | the shell window's renderer |
| Built-in apps | `din://<id>` | `persist:din-apps` | `din-app-preload.cjs` → ports only | one per app window |
| Browser tabs, installed web apps, nsites | their own | `persist:webbrowser` | nostr, napp, web push, … | one per site |
| Private and Tor tabs | their own | in-memory sessions | fewer | one per site |

- **Each scheme is served by its own handler.** `app:` serves only the
  desktop's files (`dist/`); `din:` serves only `dist/apps/<host>/`, and
  only in the `persist:din-apps` session. Neither can be made to serve the
  other's files.
- **Each built-in app is its own origin**, so its `localStorage`,
  IndexedDB and caches are its own. `din://paint` can't read
  `din://terminal`'s storage.
- **Built-in apps don't share a session with the web.** No cookies,
  extensions, ad blocking or permission grants in common with tabs.
- **The desktop's CSP** allows frames only from `din:` and the guest
  schemes, never from `app:` itself.

## Who trusts whom

**Electron main trusts the desktop, and ports the desktop asked for.**
Every `window.dinos` handler checks `assertShellSender` (the shell's main
frame at `app://din`), as today. Apps never get an `ipcRenderer` channel
of their own; the app preload's only job is to receive ports. The one
exception to "everything goes through the desktop" is `din.system`: for an
app with the `fs` or `pty` permission, the desktop asks main for a port
straight from that app to that bridge (below), so terminal output and file
reads cost what `window.fs` costs today and don't wait on the desktop's
main thread. Main records on each such port which app and which
permission it was made for, checks every call against that, and enforces
the bridge's own limits (no `~/.config/din`, no nostrd keys) itself. The
desktop decides who gets one and can have main close it.

**The desktop trusts an app only as far as its manifest's grants.**
`DinHost` keeps, per port: which app it is (from the origin main verified
when it made the port, not from anything the app says), which window, and
which permissions. Each request is checked against those.

**An app trusts nothing it hasn't been handed.** File handles, drag
tokens and launch files are capabilities: unguessable ids that the desktop
issued to that app's port. A handle forged or copied from another app
resolves to nothing.

### How a port is made

1. The webview starts loading `din://paint/`. Its preload asks main for a
   port (`ipcRenderer.invoke`).
2. Main checks the sender: the main frame, a webview whose host is the
   shell window, in the `persist:din-apps` session, and takes the app id
   from the host of `senderFrame.origin` (`din://paint`).
3. Main makes a `MessageChannelMain`, sends one end to the desktop with
   `{ webContentsId, appId }` and the other to the app's preload.
4. The desktop matches the webContents id to the window it created, and
   answers with a `hello` carrying the window state, theme and grants.
5. For each `din.system` bridge the app was granted, the desktop calls
   `dinos.apps.grant(webContentsId, permission)`; main makes a second
   channel, sends one end to the app's preload and keeps the other, bound
   to that app and permission.

The preload keeps the ports. It exposes only functions through
`contextBridge` (send a message, hear messages), so page script never
holds a raw `MessagePort` it could transfer elsewhere. The app can't
choose its id, can't get a second port, and can't reach another app's
port. A reload repeats the handshake (the webContents id survives it and
the preload reconnects, as the spike showed) and invalidates the old
port's handles.

**In main, compare scheme and host, never origin strings.** Node's
`new URL('din://x').origin` is `'null'` for every custom scheme, so an
origin comparison treats `din://paint` and `app://din` as equal; the
spike's first navigation check let an app through to the desktop that
way. `senderFrame.origin` itself is correct (`din://paint`).

## Permissions

An app's manifest lists what it needs beyond the basics
([din/permissions.md](din/permissions.md)). Built-in apps' manifests are
part of Din's source, so the grant is reviewed in code review, not
prompted for. When nsites get `window.din`, the same list becomes what the
user approves at install.

Document apps (Paint, Word Processor, …) ask for nothing: they reach only
the files the user picks, drops on them, or opens them with. That's the
main gain over today, where every app could read the whole home folder.

## Navigation and content

- An app's webview is pinned to its origin, checked by scheme and host in
  `will-frame-navigate` (which sees top-level and subframe navigations).
  Navigations elsewhere open in the Web Browser, as installed nsites' do
  today. Frames of other `din://` apps are blocked the same way; they
  wouldn't get `window.din` anyway, since the preload only connects the
  main frame.
- `window.open` and links go through `din.app.openUrl`; the webview's own
  pop-ups are denied.
- Apps can't frame `app://` and can't fetch it: the apps' session has no
  `app:` handler at all, and Chromium allows cross-origin requests only on
  http(s)-like schemes, so one `din://` app can't fetch another's files
  either.

## Hangs and crashes

Every app window has its own renderer process, a second window of the
same app included; while one app spun in `while(true){}`, the desktop and
the other apps ran at full speed. The desktop notices a hung one two
ways: main's `unresponsive` event on its webContents (the `<webview>`
element gets none), and an unanswered request on its port (a close
request, for instance). Either offers "Wait / Force quit"; force quit has
main kill the renderer process, and the window
shows a "stopped" state with Reopen ([din/lifecycle.md](din/lifecycle.md)).

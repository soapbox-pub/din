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
| Built-in apps | `din://<id>` | `persist:din-apps` | `din-app-preload.cjs` → the port only | one per app window |
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

**Electron main trusts exactly one sender: the desktop.** Every
`window.dinos` handler checks `assertShellSender` (the shell's main frame
at `app://din`), as today. Apps never get an IPC channel of their own to
main; the app preload's only job is to receive the MessagePort.

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
2. Main checks the sender: a top frame, a webview whose host is the shell
   window, in the `persist:din-apps` session, and takes the app id from
   `senderFrame.origin`.
3. Main makes a `MessageChannelMain`, sends one end to the desktop with
   `{ webContentsId, appId }` and the other to the app's preload.
4. The desktop matches the webContents id to the window it created, and
   answers with a `hello` carrying the window state, theme and grants.

The app can't choose its id, can't get a second port, and can't reach
another app's port. A new navigation in the webview (a reload) repeats
the handshake and invalidates the old port's handles.

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

- An app's webview is pinned to its origin. Navigations elsewhere open in
  the Web Browser, as installed nsites' do today.
- `window.open` and links go through `din.app.openUrl`; the webview's own
  pop-ups are denied.
- Apps can't frame `app://` and can't fetch it: different scheme, no CORS
  privileges granted, and the `app:` handler checks the requesting session.

## Hangs and crashes

Every app window has its own renderer process. The desktop notices a hung
one two ways: main's `unresponsive` event on its webContents, and an
unanswered request on its port (a close request, for instance). Either
offers "Wait / Force quit"; force quit kills the renderer, and the window
shows a "stopped" state with Reopen ([din/lifecycle.md](din/lifecycle.md)).

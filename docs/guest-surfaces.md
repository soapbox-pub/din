# Guest surfaces: embedding apps and pages

> **Status: in place.** Every `<webview>` is created by `src/platform/`, and
> the `custom/no-guest-engine` lint rule keeps it that way.

Everything Din shows from another process (a built-in app, an nsite, a
web page, an extension popup, DevTools) is a **guest**. Two files know
what a guest is made of (Electron's `<webview>` today); everything else
talks about guests by element or by id:

| File | What |
|---|---|
| `src/platform/GuestSurface.tsx` | The one component that embeds a guest |
| `src/platform/guest.ts` | Creating, finding and driving guest elements: `findGuest(id)`, `guestId(el)`, `isGuestElement(el)`, `guestWindowId(id)`, `guestFrame(el)`, `guest.reload(el)` … |

## The component

```tsx
<GuestSurface
  ref={handle}                       // GuestSurfaceHandle
  src="din://calculator/"
  partition="persist:din-apps"       // fixed for the surface's lifetime
  allowPopups                        // fixed; main routes window.open
  pageZoom={1}                       // on top of the interface zoom
  hidden={backgroundTab}             // with the window's visibility, drives document.visibilityState
  acceptFileDrops                    // Files drags arrive as real files (web pages)
  onAttach={(id) => …}               // the guest id, once attached
  onDomReady onLoadStart onLoadEnd onLoadError onTitle onFavicons onThemeColor onNavigate onGone
/>
```

`GuestSurfaceHandle` has the imperative side: `element()`, `id()`,
`loadURL`, `reload`, `reloadIgnoringCache`, `goBack`/`goForward`, `focus`,
and `executeJavaScript` (for Din's own probes of web pages, like the
browser's icon collection; never used on apps). The id is what the
desktop passes to `window.dinos` calls that act on a guest (fullscreen,
file drop, devtools, visibility, app ports).

The surface keeps the guest in step with the desktop on its own:

| Concern | How |
|---|---|
| Zoom | The interface zoom times `pageZoom`, reapplied on every `dom-ready` (the engine resets it, and a mismatch offsets hit-testing) |
| Visibility | `dinos.guestVisibility`, from the window's visibility and `hidden` |
| File drops | With `acceptFileDrops`, a cover during a Files drag forwards it to `dinos.guestFileDrop` |

Other guest plumbing goes through `guest.ts` helpers rather than the
element: `GuestInputHost` (pointer forwarding, `findGuest`),
`PageFullscreenHost` (`guestFrame`, `guestId`), `SystemNotificationsHost`
(`guestWindowId`), dictation (`guestId`), the Dock (`isGuestElement`).

## Users

| Who | Partition | Notes |
|---|---|---|
| `BrowserView` (browser tabs, installed web apps and nsites) | `persist:webbrowser`, private, Tor | Adds the crash page and the browser's URL handling |
| `ExtensionPopupHost` | `persist:webbrowser` | Measures the popup on `dom-ready` |
| `DevToolsPane` | `persist:devtools` | Opens the tab's DevTools once attached |

## The iframe fallback

Outside Electron (`npm run dev:browser`), `guestsAvailable()` is false.
`BrowserView` falls back to an `<iframe>` (subject to sites' framing
headers).

## Swapping the engine

Everything that would change is in `src/platform/`: `createGuest` and the
`guest` helpers, `GUEST_EVENTS`, and how `GuestSurface` listens. Main's
side (sessions, preloads, `will-attach-webview`, the bridges keyed by
guest id) would need the same replacement in `electron/`.

# Guest surfaces: embedding apps and pages

> **Status: design.** Today `BrowserView`
> (`src/components/desktop/apps/BrowserView.tsx`) wraps `<webview>` with an
> iframe fallback, but `<webview>` is also created or queried directly in
> `ExtensionPopupHost`, `DevToolsPane`, `GuestInputHost`,
> `PageFullscreenHost`, `SystemNotificationsHost` and others.

Everything Din shows from another process (a built-in app, an nsite, a
web page, an extension popup, DevTools) is a **guest**. `GuestSurface`
is the one component that embeds a guest, so the engine behind it
(Electron's `<webview>` today) is an implementation detail of one folder.

## The component

```tsx
<GuestSurface
  ref={handle}                         // GuestSurfaceHandle
  src="din://paint/"
  kind="app"                           // 'app' | 'site' | 'site-app' | 'extension' | 'devtools'
  partition="din-apps"                 // named, not Electron's 'persist:…' strings
  transparent                          // let unpainted pixels show the desktop
  shape={rects}                        // clip drawing and hit-testing
  visible={windowVisible}              // drives document.visibilityState
  zoom={interfaceZoom}
  onReady={…} onTitle={…} onIcon={…} onThemeColor={…}
  onNavigate={…} onCrash={…} onUnresponsive={…}
/>
```

`GuestSurfaceHandle` has the imperative side: `loadURL`, `reload`,
`goBack`/`goForward`, `focus`, `kill`, `getSelectionText`, and `id`, an
opaque guest id the desktop passes to `window.dinos` calls that act on a
guest (fullscreen, file drop, devtools). Nothing outside `src/platform/`
sees a webContents id or a `<webview>` element.

## Backends

| Backend | Where | Notes |
|---|---|---|
| `webview` | Electron | Every guest. Own process, session preloads, main-process control (input, navigation pinning, crash and hang events) |
| `iframe` | `npm run dev:browser`, a future non-Electron host | Built-in apps work (the port is posted to the frame); sites mostly don't (framing headers). No process guarantee |

A backend implements one interface in `src/platform/guestSurface/` and
owns everything engine-specific that today is spread around:

| Concern | Today | Behind the surface |
|---|---|---|
| Pointer forwarding for raising and closing popovers | `GuestInputHost.tsx`, `guestInput` | The backend raises `onPointerDown` |
| Fullscreen fit | `PageFullscreenHost.tsx`, `pageFullscreen` | `fullscreen` state and a fit call |
| Visibility | `guestVisibility` | The `visible` prop |
| File drop replay | `BrowserView.tsx`, `guestFileDrop` | The backend takes Din drags |
| Zoom sync | `BrowserView.tsx` `dom-ready` | The `zoom` prop |
| Notifications' source | `SystemNotificationsHost.tsx` | `id` → window lookup |
| Context menu routing | `main.mts` | `onContextMenu` |

A lint rule in `eslint-rules/` forbids the `webview` element, `Electron`
types and `getWebContentsId` outside `src/platform/`.

## Adding a backend

1. Implement `GuestBackend` (create, destroy, the props above, the
   handle's methods, the events).
2. Implement the app port handshake for it: how the desktop gets one end
   of a `MessageChannel` and the app's preload or bootstrap the other.
3. Register it in `src/platform/guestSurface/index.ts`, chosen at startup
   from what the host supports.

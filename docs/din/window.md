# `din.window`: the app's window

> **Status: in place** (`DinAppFrame` on the desktop's side, standing in
> for the per-window React contexts apps in the desktop's tree use).
> Transparency, shapes and moving from inside the app were first tried in
> a standalone spike (Electron 43); notes below say what it showed.

Every app window is a Din window: the desktop places it, tiles it,
snaps it, minimizes it into the Dock, lists it in the switcher. The app
decides what's inside, and how much of the frame it draws itself.

## On a phone

An app asks whether it's on a phone as a web page would:
`navigator.userAgentData.mobile` (User-Agent Client Hints). There the app
has a phone's whole screen and the phone does what a window manager would
(Din Phone: each app is an Android task of its own). The host says so in
its hello, and the runtime makes `mobile` true then, whatever the engine
says of itself (`installMobile` in `src/sdk/standards.ts`), with
`getHighEntropyValues(['formFactors'])` answering `Mobile`. In Din's own
windows it's Electron's, false. It's set before the app renders and doesn't
change.

On a phone there's no window to move, resize, maximize or snap. The
runtime starts no gestures from `app-region: drag`, `WindowDragRegion` is
just the bar, `<WindowControls>` draws nothing, and the shared `TabStrip`
shows the tab you're in with a count of tabs that opens a sheet of them all.
What an app asks of the window that a phone doesn't have (bounds, a shape,
a menu bar) is taken and forgotten. An app whose header holds only its
tabs and the window controls needs nothing else to look right there.

## State

The window's state is the web's own. A page in a webview would otherwise
see the host's window, so the runtime answers each from what the desktop
pushes (`installWindowState` in `src/sdk/standards.ts`), and reading never
waits:

| | The web's | React (`@/sdk/react`) |
|---|---|---|
| Keyboard input goes to it | `document.hasFocus()`, window `focus` and `blur` | `useWindowFocused()` |
| Some of it can be seen (not minimized, not on another workspace) | `document.visibilityState`, `visibilitychange` | `useDocumentVisible()` |
| Maximized, minimized, fullscreen | `matchMedia('(display-state: maximized)')` (`minimized`, `fullscreen`, `normal`), from the Additional Windowing Controls draft | `useMediaQuery('(display-state: maximized)')` |
| Where it is, its size with the frame | `screenX`, `screenY`, `outerWidth`, `outerHeight`; `resize` | `useWindowSize()` |
| The work area of its monitor (the screen minus the menu bar and Dock) | `screen.availLeft`, `availTop`, `availWidth`, `availHeight` | |

Window `focus` and `blur` follow the desktop's focus: the page's own, which
a click on the menu bar would send, are held back. `display-state` works
in script only; a stylesheet's `@media` doesn't know it. For CSS, `<html>`
has `data-window-flush` while the window fills its part of the screen
(maximized, snapped to a half or quarter, or full screen), and
`data-screen-right` and `data-screen-bottom` while those edges of it are the
screen's rather than another window's. `ContentPane`
(`src/shared/appChrome.tsx`) runs to those edges, square there, and keeps its
rounded inset where it meets the sidebar, the title bar or the window
beside it: `[[data-screen-right]_&]:…` in Tailwind. For a width
breakpoint, `useMediaQuery('(min-width: 680px)')` re-renders only when
it's crossed.

Two things the web has no word for are `din.window`'s:

```ts
din.window.id;        // unique on this desktop, for the app's other windows to address it by
din.window.snapped;   // 'left', 'right', 'top-left', …, or null (useSnapped())
din.window.onSnappedChange((snap) => …);
```

## Title, icon, accent

The window follows the page's head, as a browser's tab does:

```ts
document.title = 'Budget 2027.xlsx';                         // the title
iconLink.href = thumbnailDataUrl;                            // <link rel="icon">: the icon
themeColorMeta.content = '#1e7145';                          // <meta name="theme-color">: tints the title bar
```

React apps use the SDK's hooks, which do that while mounted and put back
the app's own when they unmount or are given null:

```tsx
useWindowTitle(dirty ? `• ${name}` : name);   // null: the app's name
useWindowIcon(thumbnailDataUrl);               // null: the app's icon
useWindowAccent('#1e7145');                    // null: the default
```

The title shows in the title bar (for `standard` frames), the Dock's
window list and the switcher. The accent is sanitized by the desktop,
which also decides whether the title bar reads as dark; the menu bar
takes it on while the window is maximized.

What the page's HTML starts with is taken as the app's own (its name, its
icon, its manifest's color): only changes from it are passed on, and
going back to it is the same as having none. Where the head has several
icon links or theme-colors, the last wins. An icon that isn't a data: or
https URL (the app's own files, Din's `/icons/…`, a blob:) is read by the
SDK into a data: URL, up to 512 KB (`src/sdk/standards.ts`).

## How much Din draws: frame modes

```ts
din.window.setChrome({ frame: 'custom' });
```

The manifest's `din.window` gives the first value, so the window opens
right and doesn't flash ([manifest.md](manifest.md)).

### `standard`

```
╭─────────────────────────────────────────────╮
│ 🖌 Untitled.png                    –  □  ✕ │  ← Din
├─────────────────────────────────────────────┤
│                                             │
│                 the app                     │
│                                             │
╰─────────────────────────────────────────────╯
```

Din's title bar, frame, shadow, rounded corners and resize handles. The
app sets the title, icon and accent. Most document apps.

### `custom`

```
╭───────────────┬─────────────────────────────╮
│ 🔍 Search   ＋│ ▸ Tab one  Tab two     – □ ✕│  ← the app, with Din's pieces
│ Recent        ├─────────────────────────────┤
│  • Fix tabs   │                             │
│  • Docs       │        conversation         │
╰───────────────┴─────────────────────────────╯
```

Din keeps the frame, corners, shadow and resize handles; the page runs
to the top edge and the app lays out the whole header. This is today's
`useOwnWindowHeader` (Assistant, Settings) and replaces putting content
into Din's title bar (tab strips in Files, Terminal, Text Editor, the
Web Browser).

The app builds its header from the SDK's pieces, which look and act like
Din's own title bar:

```tsx
import { WindowControls, WindowDragRegion } from '@/sdk/react';

function Header() {
  return (
    <div className="flex">
      <WindowDragRegion className="flex h-9 w-64 items-center gap-2 px-2">
        <SearchBox />            {/* fields, buttons and tabs keep their clicks */}
      </WindowDragRegion>
      <WindowDragRegion className="flex h-9 flex-1 items-center pr-3">
        <TabStrip />
        <WindowControls />
      </WindowDragRegion>
    </div>
  );
}
```

- **`<WindowDragRegion>`**: a `div` with CSS `app-region: drag`, from the
  Window Controls Overlay draft, which is what makes a title bar in any
  page, React or not (`touch-action: none` and `user-select: none` suit
  it too). The runtime answers for it, since the engine doesn't inside a
  webview: dragging its empty space moves the window
  (`din.window.beginMove`, once the pointer has moved 3 px, so clicks and
  double-clicks still reach the app: the desktop takes over the whole
  gesture once it has it); double-click maximizes or restores; right-click
  opens Din's window menu. Presses on buttons, links, fields, `[role="tab"]`,
  `[data-window-no-drag]` and anything `app-region: no-drag` are the app's,
  as in Din's title bar. Each runs after the page's own listeners, and a
  listener that cancels the event (`preventDefault()`) keeps it.
- **`<WindowControls>`**: minimize, maximize/restore and close, colored
  from `din.window.frameStyle` (the accent, and whether it's dark).
  Close goes through the window's close request like any other close.

`frameStyle` is plain data (`{ accent, dark }`), so non-React apps can
draw their own controls to match.

### `none`

```
            ╭──────────────╮
     ╭──────┤  ▶  ❚❚  ■    │      ← only the app's pixels; the desktop
     │ ≋≋≋≋ │  00:42       │        shows through everywhere else
     ╰──────┴──────────────╯
```

Nothing from Din: no frame, shadow or handles. The page is the window.
For skins (Media Player's Winamp and WMP skins) and anything with its
own shape. Today's `setFrameless`.

```ts
din.window.setChrome({ frame: 'none' });
din.window.setShape([
  { x: 0, y: 12, width: 120, height: 90 },
  { x: 110, y: 0, width: 160, height: 110 },
]);
```

- **Transparency**: wherever the page doesn't paint, the desktop (and
  windows behind) shows through. App webviews are created transparent
  (Din forces web pages opaque, apps not) and `src/sdk/app.css` makes
  `html` and `body` transparent; in the spike the desktop showed through in
  every light/dark combination of desktop and app. A `standard` or
  `custom` window has the desktop's frosted window background behind the
  page, so the app looks like any Din window without painting one.
  Scrollbar tracks are still drawn opaque.
- **`setShape(rects)`**: the window exists only inside these rectangles.
  Outside them it neither draws nor takes clicks: a click there goes to
  whatever's behind. Without a shape, transparent pixels still take
  clicks, which is right for soft shadows and wrong for odd shapes. The
  desktop applies the shape as `clip-path` on the window's **outermost**
  element: on the `<webview>` alone it clips the app's clicks, but the
  window's container still swallows them. `mask-image` clips drawing but
  not clicks, so it isn't used.
- Moving and resizing are the app's job: `beginMove` from its own grab
  areas, `beginResize(edge, e)` from its own grips, or the web's
  `window.moveTo` and `resizeTo`.

Minimum and maximum sizes, aspect ratios and windows the user can't
resize aren't in the API yet; they'll come with the first app that needs
one.

## Moving and resizing

```ts
grip.addEventListener('pointerdown', (e) => din.window.beginMove(e));
corner.addEventListener('pointerdown', (e) => din.window.beginResize('se', e));
window.resizeTo(1160, 720);                          // Calculator switching to Advanced
```

- `beginMove` and `beginResize` hand the gesture to the desktop, which
  runs it exactly as its own title bar does: snapping to edges, tearing a
  maximized window off, workspaces, wobble. The app gets no more pointer
  events for the gesture (not even its `pointerup`); `window.din` resolves the
  gesture when the desktop says it ended, and `screenX` and the rest have
  changed.

  How the desktop follows a pointer that's over another process: main
  already forwards a webview's mouse moves to the desktop
  (`forwardGuestInput`, within a millisecond), so the window moves from
  the first event. Those stop once the pointer leaves the app, even with
  pointer capture, so `beginMove` also puts a cover over the whole
  desktop, which takes the pointer over while the button is still down
  (a frame or two later; 120–160 ms headless) and follows it anywhere.
  After a move, clicks can land at the webview's old spot for about a
  frame.
- The web's `window.moveTo`, `moveBy`, `resizeTo` and `resizeBy` move
  and size the window, in the desktop's CSS pixels with its frame included
  (as `outerWidth` and `outerHeight` are), clamped to the monitor's work
  area and the min/max size. A move and a resize made together go as one.
  A tiled or maximized window ignores them until restored.
- The page's own `window.minimize()`, `window.maximize()` and
  `window.restore()`, from the web's Additional Windowing Controls draft,
  do what the title bar's buttons do: `restore` brings a minimized window
  back, and un-maximizes or un-tiles one that isn't. `window.focus()`
  does what a click does. To toggle, look at `matchMedia('(display-state: maximized)')`.

## Closing

Closing the window fires the web's `beforeunload`, as a browser does
before closing a tab:

```ts
addEventListener('beforeunload', (e) => {
  if (!dirty) return;                  // let it close
  e.preventDefault();                  // keep it open; we're asking
  confirmSave().then((save) => {
    if (save === 'cancel') return;
    if (save === 'save') void saveFile().then(() => window.close());
    else window.close();
  });
});
```

Cancelling it (`preventDefault()`, a `returnValue`, or an
`onbeforeunload` that returns a string) keeps the window open, and Din
shows no dialog of its own: the app asks its question after. The desktop
asks only while the page has a `beforeunload` listener (or
`onbeforeunload`), so a window without one closes at once. Listeners must
answer at once; an app that doesn't within five seconds is shown as not
responding ([lifecycle.md](lifecycle.md)). The web's `window.close()` from
the app itself never fires it; `din.window.requestClose()` closes as the
user would, through it (`<WindowControls>`' close button does that).

A real unload (the app navigating itself, or reloading) fires the
engine's own `beforeunload` at the same listeners, as on the web.

In React, `useCloseGuard(() => dirty && (askToSave(), true))` from
`@/sdk/react` installs the handler while mounted.

## The window menu

Right-clicking a stretch of `app-region: drag` opens Din's window menu
(Minimize, Maximize, tiling, workspaces, displays, Close) where it was
clicked, drawn by the desktop, unless the page's own `contextmenu`
listener cancelled it.

# `din.window`: the app's window

> **Status: design.** Today's equivalents are the per-window React
> contexts in `src/contexts/` (`WindowTitleContext`,
> `WindowFrameContext`, `WindowChromeContext`, …) and `setFrameless` in
> `src/hooks/useWindows.ts`. Transparency, shapes and moving from inside
> the app were tried in a standalone spike (Electron 43, webviews on
> `din://`); notes below say what it showed.

Every app window is a Din window: the desktop places it, tiles it,
snaps it, minimizes it into the Dock, lists it in the switcher. The app
decides what's inside, and how much of the frame it draws itself.

## State

```ts
din.window.state;  // { id, focused, visible, minimized, maximized, snapped, fullscreen, bounds, workArea }
din.window.onChange((s) => setDimmed(!s.focused));
```

The desktop pushes every change, so reading `state` never waits. Use
`visible` to pause animation and polling while nobody can see the window;
the page's own `document.visibilityState` follows it too.

## Title, icon, accent

```ts
din.window.setTitle('Budget 2027.xlsx');   // null: the app's name
din.window.setIcon(thumbnailDataUrl);      // null: the app's icon
din.window.setAccent('#1e7145');           // tints the title bar; null: default
```

The title shows in the title bar (for `standard` frames), the Dock's
window list and the switcher. The accent is sanitized by the desktop,
which also decides whether the title bar reads as dark; the menu bar
takes it on while the window is maximized.

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

- **`<WindowDragRegion>`**: pressing on its empty space moves the window
  (`din.window.beginMove`); double-click maximizes; right-click opens
  Din's window menu (`din.menus.popup` with the window's items). Presses
  on `button`, `input`, `textarea`, `[role="tab"]` and
  `[data-window-no-drag]` are the app's, as in Din's title bar today. Plain
  HTML can opt in with `data-din-region="drag"`; the SDK handles it the
  same way. CSS `app-region: drag` does nothing inside a webview.
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
din.window.setChrome({ frame: 'none', background: 'transparent', resizable: false });
din.window.setShape([
  { x: 0, y: 12, width: 120, height: 90 },
  { x: 110, y: 0, width: 160, height: 110 },
]);
```

- **`background: 'transparent'`**: wherever the page doesn't paint, the
  desktop (and windows behind) shows through. The page's own `html` and
  `body` must be transparent. App webviews are created transparent (Din
  forces web pages opaque, apps not); in the spike the desktop showed
  through in every light/dark combination of desktop and app, with none
  of the opaque-canvas trouble iframes have. A `standard` or `custom`
  window's opaque background is painted by the desktop behind the
  webview, so those windows need do nothing. Scrollbar tracks are still
  drawn opaque.
- **`setShape(rects)`**: the window exists only inside these rectangles.
  Outside them it neither draws nor takes clicks: a click there goes to
  whatever's behind. Without a shape, transparent pixels still take
  clicks, which is right for soft shadows and wrong for odd shapes. The
  desktop applies the shape as `clip-path` on the window's **outermost**
  element: on the `<webview>` alone it clips the app's clicks, but the
  window's container still swallows them. `mask-image` clips drawing but
  not clicks, so it isn't used.
- Moving and resizing are the app's job: `beginMove` from its own grab
  areas, `beginResize(edge, e)` from its own grips, or `setBounds`.

### Other chrome options

| Option | Default | |
|---|---|---|
| `background` | `opaque`; `transparent` for `none` | See above |
| `shadow` | true; false for `none` | Din's soft shadow |
| `resizable` | true | Hides the resize handles and disables Super+drag resizing |
| `minSize`, `maxSize` | Din's minimum | Enforced by the desktop's resize and tiling |
| `aspectRatio` | none | Kept while resizing (video, calculators) |

## Moving and resizing

```ts
grip.addEventListener('pointerdown', (e) => din.window.beginMove(e));
corner.addEventListener('pointerdown', (e) => din.window.beginResize('se', e));
din.window.setBounds({ width: 380, height: 620 });   // Calculator switching modes
```

- `beginMove` and `beginResize` hand the gesture to the desktop, which
  runs it exactly as its own title bar does: snapping to edges, tearing a
  maximized window off, workspaces, wobble. The app gets no more pointer
  events for the gesture (not even its `pointerup`); the SDK resolves the
  gesture when the desktop says it ended, and the window's `state`
  changes.

  How the desktop follows a pointer that's over another process: main
  already forwards a webview's mouse moves to the desktop
  (`forwardGuestInput`, within a millisecond), so the window moves from
  the first event. Those stop once the pointer leaves the app, even with
  pointer capture, so `beginMove` also puts a cover over the whole
  desktop, which takes the pointer over while the button is still down
  (a frame or two later; 120–160 ms headless) and follows it anywhere.
  After a move, clicks can land at the webview's old spot for about a
  frame.
- `setBounds` is clamped to the monitor's work area and the min/max
  size. A tiled or maximized window ignores it until restored.
- `minimize()`, `maximize()`, `restore()`, `toggleMaximize()`, `focus()`
  do what the title bar's buttons and a click do.

## Closing

```ts
din.window.onCloseRequest(() => {
  if (!dirty) return false;            // let it close
  confirmSave().then((save) => {
    if (save === 'cancel') return;
    if (save === 'save') void saveFile().then(() => din.window.close());
    else din.window.close();
  });
  return true;                         // keep it open; we're asking
});
```

The handler must answer at once (true or false); the asking happens after.
An app that doesn't answer within a few seconds is shown as not
responding ([lifecycle.md](lifecycle.md)). `din.window.close()` from the
app itself never asks its own handler.

## Child windows

`din.window.openChild(params, size)` opens another window of the same
app that stays with this one: it closes with it, minimizes with it, and
floats above it. For tool palettes and pop-ups (a Paint color picker, the
browser's undocked inspector). The child is its own document with its own
port; the two talk through `params` and their own `BroadcastChannel`
(same origin).

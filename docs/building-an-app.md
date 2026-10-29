# Building a built-in app

> **Status: in place.** `src/apps/calculator/` is a real, small example.

A small example: **Stopwatch**, a floating window with a custom header.

## 1. The folder

```
src/apps/stopwatch/
  index.html
  manifest.webmanifest
  icon.png
  main.tsx
  Stopwatch.tsx
```

The id is the folder's name. It's served at `din://stopwatch/` and built
to `dist/apps/stopwatch/`.

## 2. The manifest

```json
{
  "name": "Stopwatch",
  "icons": [{ "src": "/icon.png", "sizes": "512x512", "type": "image/png" }],
  "background_color": "#18181b",
  "launch_handler": { "client_mode": "focus-existing" },
  "din": {
    "window": { "size": { "width": 320, "height": 220 }, "floating": true, "frame": "custom", "resizable": false },
    "keywords": ["timer", "clock", "lap"]
  }
}
```

No permissions: it needs nothing but its window. See
[din/manifest.md](din/manifest.md).

## 3. The page

```html
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Stopwatch</title>
        <meta name="description" content="A stopwatch with laps.">
        <meta property="og:type" content="website">
        <meta property="og:title" content="Stopwatch">
        <meta property="og:description" content="A stopwatch with laps.">
        <meta http-equiv="content-security-policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'none'">
        <link rel="manifest" href="./manifest.webmanifest">
    </head>
    <body>
        <div id="root"></div>
        <script type="module" src="./main.tsx"></script>
    </body>
</html>
```

The repo's lint rules for HTML apply: no inline scripts, a description
and Open Graph tags, a manifest link. The CSP is the app's own, and
strict: widen it (a `connect-src` for the relays an app talks to,
`'wasm-unsafe-eval'` for WebAssembly) only as far as the app needs. In
development the build adds `ws://localhost:*` to `connect-src` for Vite's
hot reloading.

## 4. Connecting

```tsx
// main.tsx
import { startApp } from '@/sdk/start';
import { Stopwatch } from './Stopwatch';

void startApp(() => <Stopwatch />);
```

`startApp` loads Din's base styles and polyfills, waits for `din.ready`
(`window.din` is Din's, there before the app's scripts run; `ready`
resolves once the desktop has said hello, with the theme already applied) and renders the app inside `<DinProvider>`, React Query and the
tooltip provider. An app that needs something else can call `connect()`
from `@/sdk` and render itself.

## 5. The app

```tsx
// Stopwatch.tsx
import { useEffect } from 'react';
import { WindowControls, WindowDragRegion, useDin, useMenuBar, useWindowState } from '@/sdk/react';

export function Stopwatch() {
  const din = useDin();
  const { visible } = useWindowState();
  const [ms, running, toggle, reset] = useStopwatch({ paused: !visible });

  useMenuBar(
    [{ label: 'Timer', items: [
      { id: 'toggle', label: running ? 'Stop' : 'Start', accelerator: 'Space' },
      { id: 'reset', label: 'Reset', accelerator: 'Ctrl+R' },
    ] }],
    (id) => (id === 'toggle' ? toggle() : reset()),
  );

  useEffect(() => din.window.setTitle(running ? format(ms) : null), [din, running, ms]);

  return (
    <div className="flex h-full flex-col text-foreground">
      <WindowDragRegion className="flex h-9 items-center px-3">
        <span className="flex-1 text-sm text-muted-foreground">Stopwatch</span>
        <WindowControls />
      </WindowDragRegion>
      <button className="flex-1 font-mono text-5xl tabular-nums" onClick={toggle}>
        {format(ms)}
      </button>
    </div>
  );
}
```

## 6. Run it

- `npm run dev`: Din in Electron; the app is served by Vite at
  `din://stopwatch/` through the dev server.
- `npm run dev:browser`: the app runs at `stopwatch.localhost:8080` in an
  iframe, a different origin from the desktop, so the same isolation
  holds.

The app appears in the launcher once its folder exists, after the apps
listed in `src/lib/apps.ts`; add `dinApp('stopwatch')` there to give it a
place in the launcher's order.

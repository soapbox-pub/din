# Building a built-in app

> **Status: design.** This is how it will go once the app host lands
> (step 4 of the plan in [README.md](README.md)). Until then, built-in
> apps are components registered in `src/lib/apps.ts`.

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
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>Stopwatch</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

The repo's lint rules for HTML apply: no inline scripts, a manifest link.
Each app page gets a strict CSP from its `din:` response headers.

## 4. Connecting

```tsx
// main.tsx
import { createRoot } from 'react-dom/client';
import { connect } from '@/sdk';
import { DinProvider } from '@/sdk/react';
import '@/sdk/app.css';                      // Tailwind with Din's tokens
import { Stopwatch } from './Stopwatch';

const din = await connect();
createRoot(document.getElementById('root')!).render(
  <DinProvider din={din}>
    <Stopwatch />
  </DinProvider>,
);
```

`connect()` resolves once the desktop has said hello; the theme is
already applied.

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
    <div className="flex h-full flex-col bg-background text-foreground">
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

The app appears in the launcher once its folder exists; there's no
registry to edit.

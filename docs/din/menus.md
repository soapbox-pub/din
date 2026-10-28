# `din.menus`: the menu bar and menus that leave the window

> **Status: design.** Today Media Player portals React menus into the
> menu bar with `<MenuBarMenus>` (`src/components/desktop/MenuBarMenus.tsx`),
> and apps portal dropdowns and dialogs onto the desktop's `#shell` layer
> with `portalContainer()`. Neither can cross into another process.

## The menu bar

Din's menu bar shows the focused app's name and, beside it, its menus.
An app describes them as data; the desktop draws them:

```ts
din.menus.setMenuBar([
  {
    label: 'File',
    items: [
      { id: 'new', label: 'New', accelerator: 'Ctrl+N' },
      { id: 'open', label: 'Open…', accelerator: 'Ctrl+O' },
      { id: 'recent', label: 'Open Recent', type: 'submenu', items: recentItems },
      { type: 'separator' },
      { id: 'save', label: 'Save', accelerator: 'Ctrl+S', enabled: dirty },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'grid', label: 'Pixel Grid', type: 'checkbox', checked: showGrid },
      { id: 'zoom-1', label: '100%', type: 'radio', group: 'zoom', checked: zoom === 1 },
      { id: 'zoom-2', label: '200%', type: 'radio', group: 'zoom', checked: zoom === 2 },
    ],
  },
]);

din.menus.onAction((id) => commands[id]?.());
```

- Call `setMenuBar` again whenever something changes (a checkbox, an
  enabled state, the recent list). It replaces the whole set; it's cheap.
- The desktop shows the menus only while one of the app's windows is
  focused, and switches them as focus moves between its windows. Each
  window has its own menu bar; an app with several windows sets it in
  each.
- **Accelerators** are bound by the desktop while the window is focused,
  whatever has focus inside it, and they're shown in the menu. An app
  that also handles the same key itself (a text field's Ctrl+A) should
  leave it out of the accelerator, as desktop apps do.
- Item `icon` is a lucide icon name or an image URL.

In React, `useMenuBar(menus, onAction)` from `@/sdk/react` does both and
re-sends on change.

## Menus that leave the window

An app's own menus (Radix dropdowns, context menus) work inside its
window and are clipped to it. For a menu that has to extend past the
window (a right-click near a small window's edge, a skin's tiny menu
button), ask the desktop to draw it:

```ts
el.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const id = await din.menus.popup(items, { x: e.clientX, y: e.clientY });
  if (id) commands[id]?.();
});
```

`at` is in the window's coordinates; the desktop places the menu as its
own menus are placed. The promise resolves with the chosen item's id, or
null if it was dismissed.

The right-click rules in `AGENTS.md` still hold: anything the user can act
on gets a right-click menu mirroring its ⋯ menu, and text fields keep
their native one.

## The window menu

Right-clicking a `<WindowDragRegion>` opens Din's window menu (Minimize,
Maximize, tiling, Move to Workspace, Move to Display, Close), drawn by the
desktop.
The app doesn't build it.

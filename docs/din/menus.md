# `din.menus`: the menu bar and menus that leave the window

> **Status: in place.** The desktop draws an app's data menus with its own
> menu components (`src/components/desktop/dinHost/DataMenus.tsx`). Apps
> still in the desktop's tree portal React menus with `<MenuBarMenus>`.

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
- In the taskbar layout (Settings → Dock & Taskbar) there is no menu bar,
  so the menus aren't shown at all; their accelerators still work. An app
  should offer its commands another way too (buttons, right-click menus).
- **Accelerators** work wherever focus is in the window, and they're shown
  in the menu. Keys go to the app's document, not the desktop's, so
  `window.din` matches them there (`src/sdk/accelerators.ts`; Ctrl and Meta count
  as one) and reports the item through `onAction`, before the page's own
  handlers see the key. An app that also handles the same key itself (a
  text field's Ctrl+A, a search box's Ctrl+F) marks the item
  `notInFields: true`: shown in the menu, but left to a focused text
  field.
- Item `icon` is an image URL: a data: URL, https, or a root path of
  Din's public files.

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
their own Cut, Copy and Paste menu. That one, like a web page's right-click
menu, is built by Din's main process and drawn by the desktop as one of
its own menus (`electron/menus.mts`, `src/components/desktop/MenuHost.tsx`),
so the app doesn't build it and it looks like every other menu on Din.

## The window menu

Right-clicking a title bar the app draws (anything `app-region: drag`, as
`<WindowDragRegion>` is) opens Din's window menu (Minimize,
Maximize, tiling, Move to Workspace, Move to Display, Close), drawn by the
desktop.
The app doesn't build it.

## Text fields' menus

A text field's right-click menu is Din's: spelling's guesses for a
misspelled word, the fixes for a grammar issue (electron/grammar.mts), then
Cut, Copy, Paste and Select All. Grammar is checked as you type in every
field Chromium spell-checks, with a blue wavy underline under what's
wrong. A field that isn't prose (an address, a name, code) should say
`spellcheck="false"`, which turns off both; to keep spelling but not
grammar, put `data-din-grammar="off"` on it or on anything around it.
Code editors (CodeMirror, Monaco, Ace) and terminals (xterm.js) are left
alone already.

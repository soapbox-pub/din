# Desktop icons

> **Status: in place.** What's in ~/Desktop shows on the wallpaper, with
> app shortcuts as `.desktop` launchers. Not yet: syncing where icons sit
> between computers, a default app per file type, Home and Trash icons,
> and icons in a plain browser (there's no filesystem there).

Desktop icons are the files and folders in the user's Desktop folder:
`~/Desktop`, or wherever `~/.config/user-dirs.dirs` says (`XDG_DESKTOP_DIR`).
They're real files, so Files, the Terminal and other programs see the same
thing, and anything that saves into the folder adds an icon. Hidden files
(names starting with `.`) don't show.

They sit over the wallpaper and under every window, beside the widgets
(`src/components/desktop/icons/`). Settings → Desktop turns them off and on
and picks their size (Small, Medium, Large); so do `din settings set
desktop.icons` and `desktop.icon-size`.

## The grid

Each work area has a grid of its own (`src/lib/desktopIcons.ts`), with cells
of the icon size's width and height, from the top-left corner. The primary
monitor's leaves room at the foot for the Dock. Icons fill it down the first
column, then the next (widgets fill from the right), and skip any cell a
widget covers.

Where each icon sits is kept on this computer, by file name, in
localStorage (`din:desktop-icons`), like the widgets' layout. A new icon
takes the first free cell and keeps it. One whose cell is taken (a widget
moved there, the grid shrank) goes to the first free cell. One whose monitor
is gone shows on the primary monitor. Renaming an icon on the desktop keeps
its place.

## Using them

- **Select:** click; Ctrl-click to add or remove one; Shift-click to add; drag
  a box on the wallpaper. Arrow keys move between icons, Ctrl+A selects them
  all, and Escape clears the selection.
- **Open:** double-click or Enter. A folder opens in Files, a launcher opens
  its app, a Windows program runs through Wine, and anything else opens in
  the app for its kind (`src/lib/openPath.ts`, which `din open` uses too).
- **Drag:** the icons follow the pointer as a see-through ghost, drawn by
  the desktop over everything (`IconDragGhost`; the engine's own drag image
  is empty), and fade where they were until they're dropped.
  - onto the wallpaper, to move icons; a group keeps its shape. While over
    the wallpaper, an outline shows the cells they'll land on, worked out
    the same way the drop places them (`resolve`).
  - onto a folder icon, to move them into it (Ctrl copies).
  - into a window or onto a Dock tile, which hands them over as files from
    Files do (`startFileDrag`, [din/drag-and-drop.md](din/drag-and-drop.md)).
- **Drop onto the wallpaper:** files from Files or the desktop move into the
  Desktop folder where they're dropped (Ctrl copies). An app dragged out of
  the apps menu leaves a shortcut.
- **Right-click an icon:** Open, Open With (the apps whose Dock tile would
  take it), Show in Files, Copy Path, Rename… (F2), Move to Trash (Delete).
  With several selected, it acts on all of them.
- **Right-click the desktop:** New Folder, New Text File, Sort By (Name,
  Kind, Date Modified, Size), Clean Up (closing the gaps, in their order),
  Show Desktop in Files, and Show Desktop Icons.
- **Add to Desktop** is in the apps menu's and the Dock's and taskbar's
  right-click menus.

## Shortcuts

A shortcut is a freedesktop desktop entry in the folder. Din writes its own
with an `X-Din-App` key naming the app by its registry id, and an `Exec`
line for other desktops:

```ini
[Desktop Entry]
Type=Application
Name=Files
Exec=din apps open file-browser
X-Din-App=file-browser
```

Any app works: built-in apps, installed web apps and nsites, folders' apps,
and the computer's Linux apps (`native:…`). A launcher copied in from
`/usr/share/applications` opens the installed Linux app of the same file
name, and a `Type=Link` entry opens its `URL` as a clicked link does. Its
icon is its app's, and its label the entry's `Name`. Entries with
`Hidden=true` or `NoDisplay=true` don't show.

## The `din` command

`din desktop-icons` does what the menus do: `list` (with each one's
monitor and cell), `open`, `add-app`, `add` (copies files and folders in, or
moves them with `--move`), `new-folder`, `rename`, `remove` (to the Trash)
and `arrange` (`--by name|kind|modified|size`, or closing the gaps). The
commands call the same `DesktopIconsContext` the layer and menus do.

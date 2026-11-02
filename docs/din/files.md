# Files: the web's handles, and `din.files` and `din.clipboard`

> **Status: in place.** Apps still in the desktop's tree pick paths with
> `useFilePicker()` and read them with `window.dinos.fs`.

## Handles, not paths

An app without the `fs` permission never sees the filesystem. It sees the
web's **file handles**, `FileSystemFileHandle` and
`FileSystemDirectoryHandle`, each of which is a grant to one file (or
folder) that the user handed it:

- picked in Din's open or save dialog (`showOpenFilePicker`,
  `showSaveFilePicker`, `showDirectoryPicker`);
- dropped on the app ([drag-and-drop.md](drag-and-drop.md));
- launched with: opened from Files, Open With, dropped on its Dock tile
  (`launchQueue`, [lifecycle.md](lifecycle.md));
- pasted from Din's clipboard (`din.clipboard.readFiles`);
- restored from an earlier `din.files.persist`.

```ts
const [file] = await showOpenFilePicker({
  types: [{ description: 'Pictures', accept: { 'image/*': ['.png', '.jpg', '.gif'] } }],
});                                      // an AbortError when cancelled
const blob = await file.getFile();       // a File, with name, size, type
// …
const writable = await file.createWritable();
await writable.write(await canvas.convertToBlob());
await writable.close();                  // the file is replaced now
```

The pickers are the web's, opening Din's dialogs (`src/sdk/standards.ts`):
they take `types` (Din goes by the extensions), `multiple`,
`suggestedName`, `mode` and `startIn` (a handle, or `documents`,
`pictures`, `music`, `videos`, `downloads`), and two options of Din's,
`title` and `confirmLabel` ("Attach"). `mode: 'read'` picks files the app
won't write back (the web has it for folders only); files are picked
`readwrite` by default, folders `read`.

The handles pass `instanceof FileSystemFileHandle` (or
`…DirectoryHandle`, and `FileSystemHandle`) and have `getFile`,
`createWritable` (with `write`, `seek`, `truncate`, and
`keepExistingData`), `isSameEntry`, and `queryPermission` and
`requestPermission`, which answer what the grant allows and never ask
(`denied` for `readwrite` on a file picked to read). A folder's `entries`,
`keys`, `values`, `getFileHandle`, `getDirectoryHandle` and `resolve`
reach what's in it, granted with it. They can't create or remove a
folder's entries (`NotAllowedError`), and can't be kept in IndexedDB,
since they aren't the browser's own: `din.files.persist` keeps them.

`src/shared/fileHandles.ts` has the few helpers Din's apps share over
these: the pickers resolving with nothing when cancelled (`pickFiles`,
`pickSaveFile`, `pickFolder`), `writeFile`, `canWrite`, `fileTypes` for
types listed by extension, and the launch's files (`windowLaunchFile`,
`useLaunchFiles`).

To hear when something else changes a file (reload prompts), use the
web's `FileSystemObserver`: `observe(handle)` reports `modified`, and
`disappeared` when it's removed.

```ts
const observer = new FileSystemObserver((records) => {
  if (records.some((r) => r.type === 'modified')) offerReload();
});
await observer.observe(handle);
```

### What the web's handles can't do: `din.files`

| Call | |
|---|---|
| `path(handle)` | The full path, to show (a Recent list's folder, Copy Path), and stable for the same file, to compare handles by. Knowing it grants nothing |
| `parent(handle)` | With `file-folders`, a file's folder as a handle (null for a folder) |
| `url(handle)` | A `din-file://<token>/<name>` URL to load it from instead of `getFile()` (`<img>`, `<audio>`, `<video>`, `fetch` with Range), streamed by main. For media and anything big |
| `persist(handle)` | A token that `restore(token)` turns back into the handle after a restart, for Recent Files and reopening last session's documents |

## Saving

```ts
const target = await showSaveFilePicker({
  suggestedName: 'Untitled.png',
  types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
});
await writeFile(target, blob);           // createWritable, write, close
```

Save As is the save picker again; Save writes to the handle you already
have. A handle from the open picker is writable unless the app picked it
with `mode: 'read'`, or the file isn't writable:
`await handle.queryPermission({ mode: 'readwrite' })` says which.

## Recent files

An app keeps its own recent list: `din.files.persist(handle)` gives a token, kept
in the app's storage, that `din.files.restore(token)` turns back into a
handle after a restart (or null if the file is gone), and
`din.files.release(token)` forgets one the app drops. The office apps do
this. Din's own Recent (Files', the Dock's) doesn't take entries from apps
yet.

An app that kept a recent list on the desktop's origin before it moved,
as `{ path, time }` entries, lists the keys in its manifest's
`migrateRecentFiles`: on its first launch the desktop turns each entry it
can still find into `{ token, key, name, path, time }` and merges them into
the app's own list under the same key.

## The file clipboard

Text and images use `navigator.clipboard`, as on the web. Files use Din's
own clipboard, which Files, Media Player and native apps share:

```ts
din.clipboard.writeFiles(selected, /* cut */ false);
din.clipboard.onFilesChange((has) => setCanPaste(has !== null));
const pasted = await din.clipboard.readFiles();   // handles, granted on read
```

Cut is a hint for the app that pastes: Files moves; an app without `fs`
gets copies (it can't delete the originals).

The clipboard holds files the user meant for wherever they paste, so an
app without `fs` reads it only on a paste: its window must be focused, and
the user must have pressed a key or clicked in it (main watches the
guest's input) or picked from its menus in the last few seconds. Otherwise
`readFiles` rejects with `NotAllowedError`. `onFilesChange` says whether
anything is there at any time.

## Streaming and paths

`din.files.url(handle)` asks main for an unguessable URL bound to that file and to
the app's window; main serves it on the apps' session with Range support
(the same code as the desktop's own `din-file://localhost/…` URLs, which
don't exist there). The URL lasts as long as the page: a reload or a
closed window ends it. The app's CSP must allow `din-file:` where it
loads it (`img-src`, `media-src`, `connect-src`).

### Some folders by path

`fs` is the whole filesystem. An app that only needs some folders by path
gets `din.system.fs` scoped to them: main refuses any path outside them
(symlinks resolved), the calls that reach files by other means (the
Trash's names, recent files, search) are refused, and change events come
only from those folders.

- **`file-folders`** (permission): the folders of the files the user
  hands the app (opened, saved, dropped, launched with), and what's below
  them. Preview steps through the folder of the picture it shows and lists
  archives beside it; Publisher finds pictures linked next to its
  document. A folder is writable only if the file that brought it is (a
  read-only handle's `din.files.parent`, brings it read-only). Never `/`,
  home or a folder above it, nor one holding Din's own profile: a file
  handed over from there brings only itself.
- **`folders`** (manifest): fixed folders, made if missing: Media Player's
  `~/Music`, `~/Videos` and skins folder.

`din.permissions.has('fs')` is false for these; `din.system.fs` is there.

### Paths nothing granted

Some state names files by path that the user never handed over this time:
songs a playlist lists elsewhere, the folders a library watches.
`din.files.requestAccess(paths, reason)` asks for them and resolves with
handles for those granted (with `file-folders`, their folders come into
reach). Paths the app's own saved state named when it moved out of the
desktop are granted without asking, on that first launch (the state it
kept in the desktop's storage, and files its manifest's `migrateFiles`
copied in): the app had them then. That state must name the path
exactly, as a whole string (JSON is looked into, `~/` read as home); a
prefix of a longer path doesn't count. Anything else not already in the
app's reach, the desktop asks the user, showing the paths and `reason`.

The desktop doesn't decide what's in reach itself: it asks main
(`dinos.apps.reaches`), which checks a path as it checks the app's own
calls on `din.system.fs`, with `..` and symlinks resolved. The same goes
for `din.files.fromPath` and `din.drag.startPaths` in an app with a scoped
grant: a path from a read-only folder gives a read-only handle, and a drag
of one can only be copied.

Apps with `fs` reach files by path through `din.system.fs` anyway.
`din.files.fromPath(path)` gives one of them a handle for a path, to hand
the file to another app with `din.app.open`. To load a file by path,
`din.files.pathUrl(path)` costs no round trip, so a folder of thumbnails
is cheap: when the desktop grants `fs`, main gives the window a URL base
(`din-file://<token>`) that serves any path but Din's own profile, for as
long as the grant lasts.

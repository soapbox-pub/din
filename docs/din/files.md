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
- pasted from Din's clipboard (a `paste` event's items, or `din.clipboard.readFiles`);
- read back from IndexedDB, where the app kept it ([Recent files](#recent-files)).

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
folder's entries (`NotAllowedError`). They can be kept in IndexedDB, as
the web's can, to open again after a restart.

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

An app keeps its own recent list, and the handles in it go in IndexedDB,
as on the web:

```ts
store.put(handle, 'last-document');            // in any object store, in any value
const kept = await get('last-document');       // a handle again, after a restart too
if ((await kept.queryPermission()) === 'granted') open(kept);   // 'denied' once the file is gone
```

The runtime puts a handle in as its grant's token, which the desktop keeps
for the app (`installStoredHandles` in `src/sdk/standards.ts`), and reading
it back gives a handle that gets its grant back from the desktop when it's
first used: `queryPermission()` asks, and its other calls reject with
`NotFoundError` once the file is gone. `storeHandle`, `loadHandle` and
`forgetHandle` in `src/shared/handleStore.ts` keep handles under string
keys that the app keeps where it likes (the office apps', CAD's and Media
Player's lists keep them in localStorage, as `token`). Din's own Recent
(Files', the Dock's) doesn't take entries from apps yet.

## The file clipboard

Text and images use `navigator.clipboard`, as on the web. Files use Din's
own clipboard, which Files, Media Player and native apps share, through
the web's clipboard events (`installClipboardFiles` in
`src/sdk/standards.ts`, in the capture phase before the page's own
listeners):

```ts
document.addEventListener('copy', (e) => {           // Ctrl+C, or a 'cut' for Ctrl+X
  for (const handle of selected) e.clipboardData?.items.add(handle);
  e.preventDefault();
});
document.addEventListener('paste', async (e) => {    // Ctrl+V
  const items = [...(e.clipboardData?.items ?? [])].filter((item) => item.kind === 'file');
  paste(await Promise.all(items.map((item) => item.getAsFileSystemHandle())));
});
navigator.clipboard.addEventListener('clipboardchange', (e) => setCanPaste(e.types.includes('Files')));
```

A paste while files are on Din's clipboard has a `file` item for each,
and `Files` in its `types`; nothing is granted until a handle is asked
for. `items.add` in a `copy` or `cut` takes one of Din's handles (a folder
too) or a `File` read from one, and puts the file on Din's clipboard as
the event says. A Copy or Paste chosen from a menu fires no event, and an
app that wants to know whether the files were cut needs more than a
handle, so `din.clipboard` stays for those:

```ts
din.clipboard.writeFiles(selected, /* cut */ false);
const pasted = await din.clipboard.readFiles();   // { files, cut }, granted on read
```

Cut is a hint for the app that pastes: Files moves; an app without `fs`
gets copies (it can't delete the originals).

The clipboard holds files the user meant for wherever they paste, so an
app without `fs` reads it only on a paste: its window must be focused, and
the user must have pressed a key or clicked in it (main watches the
guest's input) or picked from its menus in the last few seconds, which a
`paste` event always is. Otherwise `readFiles`, and a paste's
`getAsFileSystemHandle()`, reject with `NotAllowedError`. The Clipboard API draft's
`clipboardchange` event on `navigator.clipboard` says when files come or
go, its `types` holding `Files` while some are there; an app with `fs`
reads them at any time to know what's there to start with.

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

`navigator.permissions.query({ name: 'fs' })` says `denied` for these; `din.system.fs` is there.

### Paths nothing granted

Some state names files by path that the user never handed over this time:
songs a playlist lists elsewhere, the folders a library watches.
`din.files.requestAccess(paths, reason)` asks for them and resolves with
handles for those granted (with `file-folders`, their folders come into
reach). For any not already in the app's reach, the desktop asks the
user, showing the paths and `reason`.

The desktop doesn't decide what's in reach itself: it asks main
(`dinos.apps.reaches`), which checks a path as it checks the app's own
calls on `din.system.fs`, with `..` and symlinks resolved. The same goes
for `din.files.fromPath` and a drag of `file:` URLs in an app with a scoped
grant: a path from a read-only folder gives a read-only handle, and a drag
of one can only be copied.

Apps with `fs` reach files by path through `din.system.fs` anyway.
`din.files.fromPath(path)` gives one of them a handle for a path, to hand
the file to another app with `din.app.launch`. To load a file by path,
`din.files.pathUrl(path)` costs no round trip, so a folder of thumbnails
is cheap: when the desktop grants `fs`, main gives the window a URL base
(`din-file://<token>`) that serves any path but Din's own profile, for as
long as the grant lasts.

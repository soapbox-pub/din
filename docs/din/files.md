# `din.files` and `din.clipboard`: files the user hands an app

> **Status: in place.** Apps still in the desktop's tree pick paths with
> `useFilePicker()` and read them with `window.dinos.fs`.

## Handles, not paths

An app without the `fs` permission never sees the filesystem. It sees
**file handles**, each of which is a grant to one file (or folder) that
the user handed it:

- picked in Din's open or save dialog (`din.files.open`, `din.files.save`);
- dropped on the app ([drag-and-drop.md](drag-and-drop.md));
- launched with: opened from Files, Open With, dropped on its Dock tile
  (`din.app.launch.files`, [lifecycle.md](lifecycle.md));
- pasted from Din's clipboard (`din.clipboard.readFiles`);
- restored from an earlier `persist()`.

```ts
const [file] = await din.files.open({
  types: [{ description: 'Pictures', extensions: ['.png', '.jpg', '.gif'] }],
});
if (!file) return;                       // cancelled
const blob = await file.getFile();       // a File, with name, size, type
// …
await file.write(await canvas.convertToBlob());
```

The shape follows the web's File System Access API (`getFile()`, `kind`,
`name`) so the code reads familiar, but a `DinFileHandle` isn't a
`FileSystemFileHandle`: it's backed by the desktop, and works the same in
Electron and in a browser.

| Member | |
|---|---|
| `name`, `kind` | `photo.png`, `file` or `directory` |
| `key` | Stable within the app for the same file; compare handles with it |
| `path` | The full path, only for apps with `fs`; null otherwise |
| `getFile()` | The contents as a `File`, read through the desktop in one message: fine for documents |
| `url()` | A `din-file://<token>/<name>` URL to load it from instead (`<img>`, `<audio>`, `<video>`, `fetch` with Range), streamed by main. For media and anything big |
| `write(data)` | Replace the contents. Only if `writable` |
| `onChange(cb)` | Something else modified or removed it (reload prompts) |
| `entries()` | Folders: what's in them, granted with the folder |
| `persist()` | A token that `din.files.restore(token)` turns back into the handle after a restart, for Recent Files and reopening last session's documents |

## Saving

```ts
const target = await din.files.save({
  suggestedName: 'Untitled.png',
  types: [{ description: 'PNG image', extensions: ['.png'] }],
});
if (target) await target.write(blob);
```

Save As is `save` again; Save is `write` on the handle you already
have. A handle from `open` is writable unless the app asked for
`writable: false`, or the file isn't writable.

## Recent files

An app keeps its own recent list: `handle.persist()` gives a token, kept
in the app's storage, that `din.files.restore(token)` turns back into a
handle after a restart (or null if the file is gone). The office apps do
this. Din's own Recent (Files', the Dock's) doesn't take entries from apps
yet.

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

## Streaming and paths

`handle.url()` asks main for an unguessable URL bound to that file and to
the app's window; main serves it on the apps' session with Range support
(the same code as the desktop's own `din-file://localhost/…` URLs, which
don't exist there). The URL lasts as long as the page: a reload or a
closed window ends it. The app's CSP must allow `din-file:` where it
loads it (`img-src`, `media-src`, `connect-src`).

Apps with `fs` reach files by path through `din.system.fs` anyway.
`din.files.fromPath(path)` gives one of them a handle for a path, to hand
the file to another app with `din.app.open`. To load a file by path,
`din.files.pathUrl(path)` costs no round trip, so a folder of thumbnails
is cheap: when the desktop grants `fs`, main gives the window a URL base
(`din-file://<token>`) that serves any path but Din's own profile, for as
long as the grant lasts.

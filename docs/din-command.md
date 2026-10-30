# The `din` command

> **Status: in place.** On DinOS `din` is on every shell's PATH; elsewhere,
> run `python3 electron/din-cli.py` against a running Din.

`din` runs a web app in a Din window, at `din://<origin>/`, the way Din
runs its built-in apps: in the apps' session, with `window.din` defined
before the page's scripts run, so a plain `index.html` can call
`await din.ready; din.window.setTitle('…')` with no build step. It's for
developing apps outside Din's tree.

```sh
din ./dist                      # a build: a folder with an index.html
din .                           # a project: its dist/
din --url http://localhost:5173 # a dev server, with its HMR
din ./dist notes.txt            # and hand it files, as if dropped on it
din ./dist --origin notes       # at din://notes/, keeping its storage
din ./dist -d                   # leave it open and return
```

The window's console prints in the terminal (warnings and errors on
stderr), and the command lasts as long as the window: closing the window
ends it, and Ctrl-C closes the window. `-q` keeps the console out.

## Origins

Without `--origin` an app gets a new `din://tmp-<random>/` each run, whose
storage is cleared when its last window closes. `--origin <name>` gives it
`din://<name>/` and keeps its storage between runs. A name may not be a
built-in app's, nor one another app on the desktop uses, and only one
folder (or server) runs at a name at a time.

## What it may do

The app's manifest is found the way a browser finds it, from the
`<link rel="manifest">` in its `index.html` (a build hashes its name),
else `/manifest.webmanifest`. Din uses its name, icon, colors, window
size and frame, shortcuts, `launch_handler`, and asks for:

- `din.permissions` and `din.folders`: the window asks first, listing
  them, and offers **Open Without**, which runs the app as a plain web
  page. For a named origin the answer is remembered until the folder or
  the request changes.
- Never honored: `migrateStorage`, `migrateRecentFiles`, `migrateFiles`,
  `dockAs`, `hidden`, file and protocol handlers.

Files are served only from inside the folder named (symlinks out of it
don't count), and a folder holding Din's own profile is refused. A path
with no extension that isn't a file gets the app's `index.html`, for
client-side routers. With `--url`, every path goes to that server's
origin.

## How it works

`electron/din-launch.mts` listens on `$XDG_RUNTIME_DIR/din.sock` (or
`din-<pid>.sock` when another Din has that one, as a dev build inside
DinOS does); the shells and apps Din starts get `$DIN_SOCKET`. One
connection is one launch: the command sends a JSON line, and main serves
the app's files at its origin (`serveLaunched`, from `din-apps.mts`'s
`din:` handler), reads its manifest and icon, and hands the launch to the
desktop (`dinos.launch.onOpen`). `LaunchHost` registers the app
(`src/lib/launchedApps.ts`) and opens its window, whose body is
`LaunchedAppFrame` asking about permissions in front of a `DinAppFrame`.
Main hears back when the window opened, when it closed, and when the app
has no windows left (`release`), which frees the origin and clears an
ephemeral one's storage.

## Apps from folders: `din+file://`

To keep an app you're working on in the launcher, add its folder in the
App Store instead: the folder button in its title bar, or **Add from a
Folder…** under From Your Folders. The folder is served the same way
(inside it only, `index.html` for router paths, never one holding Din's
profile), at `din+file://<hash>/`, where the hash is the sha256 of its
path in base32: the same folder always gets the same origin, and its
storage. Its id on the desktop is `file-<hash>` (no `din://` app may
have one), which is `din.app.id`.

The App Store shows the app as its manifest describes it, and what it
asks for; **Add** allows that and opens it. A manifest that later asks for
more is asked about again, as a named origin's is. Whenever a file in the
folder changes (outside `.git` and `node_modules`), its windows load
again with the manifest read afresh, so `vite build --watch` into the
folder, or saving a plain `index.html`, shows up at once.

The list is this computer's, in the desktop's `localStorage`
(`din:file-apps`, with each manifest as last read). Main serves only
folders the desktop opened since it started (`dinos.apps.folder`,
`electron/din-file-apps.mts`), so the desktop opens each again when it
starts, and a window (`FileAppFrame`) does before it loads. Removing the
app (from the App Store or the Dock) stops serving its folder, and leaves
the files and the origin's storage alone.

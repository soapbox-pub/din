# The `din` command

> **Status: in place.** On DinOS `din` is on every shell's PATH; elsewhere,
> run `python3 electron/din-cli.py` against a running Din.

`din` runs a web app in a Din window, at `din://<origin>/`, the way Din
runs its built-in apps: in the apps' session, with `window.din` for an app
built with the SDK. It's for developing apps outside Din's tree.

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

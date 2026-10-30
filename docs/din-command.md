# The `din` command

> **Status: in place.** On DinOS `din` is on every shell's PATH; elsewhere,
> run `node electron/din-cli.mts` against a running Din.

`din` does from a shell what a user does on Din's desktop: change its
settings, join a Wi-Fi network, set the volume, open apps and files, move
windows, add widgets, update DinOS. It's how the Assistant, or a script,
does for the user what they'd otherwise click through.

```sh
din help                          # the areas
din wifi                          # an area's commands
din help wifi connect             # a command's arguments
din settings list                 # every preference, with its value
din settings set windows.tiling on
din sound volume 40
din wifi connect "Home" --password hunter2
din windows list --json           # structured output, for scripts
din open ~/notes.txt https://example.com nostr:npub1…
```

Every command is `din <area> <command> [arguments]`; an area with one
command of its own runs it bare (`din open …`, `din lock`). Arguments are
positional or `--name value`; a switch takes `on` or `off` (also
`true`/`false`, `yes`/`no`), and a flag `--name` or `--no-name`. Relative
paths are the shell's.

Output is text for people, and with `--json` the answer's data as JSON.
Exit codes: 0 done, 1 failed, 2 used wrongly (an unknown area or command,
a missing or bad argument).

## Areas

`din help` lists them, with what each does:

| Area | What it covers |
| --- | --- |
| `settings` | Din's own preferences by key (`appearance.theme`, `dock.size`, `windows.tiling`, `datetime.clock-format`, `notifications.do-not-disturb`…), like `gsettings` |
| `apps` | List, open, install (websites, nsites), remove; `apps run` runs your own (below) |
| `windows`, `workspace` | List, focus, close, minimize, maximize, tile, move, resize, send to a workspace; show a workspace |
| `widgets` | List, add Din's own, remove, resize; `widgets add-folder` adds your own (below) |
| `notifications` | List, send, click, dismiss, clear |
| `open`, `screenshot`, `lock` | Open files, folders and links as the desktop does; save or record the screen; lock it |
| `wifi`, `bluetooth`, `vpn`, `tor` | Networks and devices, as Settings and the menu bar's menus do |
| `sound`, `display`, `brightness`, `keyboard`, `printers`, `power`, `datetime` | Settings' Devices and System sections |
| `vms` | Virtual machines: list them, install Windows, Ubuntu or Fedora on a new one (downloaded and set up by itself, as the Virtual Machines app's gallery does), start and stop them |
| `nostr` | Who's signed in, and the relay and Blossom server lists (published, as Settings does) |
| `update`, `firmware` | DinOS updates and firmware, as Settings → About |

The system's own settings (the time zone, the keyboard layout) are their
areas' commands rather than `settings` keys, since they act on the system.

### What it asks first

Commands act at once, as the user's own clicks would, except where Din
asks the user anyway or the act can't be taken back: restarting or shutting
down (`din power restart|off`) and installing firmware put the question on
screen and wait for the answer, and fail if the user says no. Giving trust
away, the password, what sudo asks for, and the signer's connected apps
aren't commands; the user changes those in Settings.

## How it works

The commands live in the desktop, in `src/lib/commands/` (one file per
group of areas, collected in `index.ts`), and run there: each calls what
the desktop's own UI calls (the `src/lib/` bridges, the window manager's
actions, `AppContext`), so the command and the UI can't come apart, and
what a command changes shows on screen at once. Each declares its
arguments (`Param`), from which its help, its argument checking, and
structured arguments for tools all come.

`electron/din-cli.mts` is the client: it sends the command line and the
shell's working folder to `electron/din-launch.mts` over Din's socket
(`$DIN_SOCKET`, else `$XDG_RUNTIME_DIR/din.sock`; on Windows, untested, the
named pipe `\\.\pipe\din-<user>`), and prints the answer. Main hands it to
the desktop (`dinos.commands`, `dinos-command:run`), where `CommandHost`
runs it with the desktop as it is now and answers. A command may take as
long as it needs (a confirmation, a firmware install); only the desktop's
taking it is timed, so a signed-out Din says so instead of hanging.
`runStructured` runs a command from a path and an object of arguments
instead of a command line, for tools.

On DinOS the client runs on Din's own Electron as Node
(`ELECTRON_RUN_AS_NODE`), compiled to `din-cli.mjs` with the rest of
`electron/`, so it needs nothing else installed.

**Adding something a user can do adds its command.** A new setting, or a
new Settings section, without one fails `commands.test.ts`: every Settings
section names its area in `SECTION_AREAS` (or why it has none), and every
`AppConfig` field is a `settings` key or in `CONFIG_FIELDS_ELSEWHERE`.

## Running your own app: `din apps run`

```sh
din apps run ./dist                      # a build: a folder with an index.html
din apps run .                           # a project: its dist/
din apps run --url http://localhost:5173 # a dev server, with its HMR
din apps run ./dist notes.txt            # and hand it files, as if dropped on it
din apps run ./dist --origin notes       # at din://notes/, keeping its storage
din apps run ./dist --detach             # leave it open and return
```

This runs a web app in a Din window at `din://<origin>/`, the way Din runs
its built-in apps: in the apps' session, with `window.din` defined before
the page's scripts run, so a plain `index.html` can call
`await din.ready; din.window.setTitle('…')` with no build step. It's for
developing apps outside Din's tree.

The window's console prints in the terminal (warnings and errors on
stderr), and the command lasts as long as the window: closing the window
ends it, and Ctrl-C closes the window. `--quiet` keeps the console out.
It runs in the client, streaming, rather than as a desktop command.

### Origins

Without `--origin` an app gets a new `din://tmp-<random>/` each run, whose
storage is cleared when its last window closes. `--origin <name>` gives it
`din://<name>/` and keeps its storage between runs. A name may not be a
built-in app's, nor one another app on the desktop uses, and only one
folder (or server) runs at a name at a time.

### What it may do

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

### How it works

One connection is one launch: the command sends a JSON line, and main
serves the app's files at its origin (`serveLaunched`, from
`din-apps.mts`'s `din:` handler), reads its manifest and icon, and hands
the launch to the desktop (`dinos.launch.onOpen`). `LaunchHost` registers
the app (`src/lib/launchedApps.ts`) and opens its window, whose body is
`LaunchedAppFrame` asking about permissions in front of a `DinAppFrame`.
Main hears back when the window opened, when it closed, and when the app
has no windows left (`release`), which frees the origin and clears an
ephemeral one's storage.

## Your own widgets: `din widgets add-folder`

```sh
din widgets add-folder ./my-widget               # a folder with a napplet's index.html
din widgets add-folder ./my-widget --size large  # starting Large (or small, medium)
```

This puts a folder's widget on the desktop, as **Add Widgets… → From a
Folder** does, in the first free cells. A widget that asks for none of the
permissions the user is asked about (`identity`, `resource`, `storage`)
goes straight on; any other opens its permission screen, and the command
waits for the user to add it or not (Ctrl-C takes the screen back). It
says which, and fails if that folder's widget is already on the desktop:
it reloads by itself whenever a file in the folder changes, so there's no
need to add it again. (`din widgets add <id>` adds one of Din's own.)

Main checks the folder as it does an app's (an `index.html`, not Din's
profile) and hands the desktop `dinos-launch:widget`; `WidgetOffers`
(`src/components/desktop/widgets/`) opens the folder (`dinos.widgets.folder`),
reads its metadata and asks, then answers `asking`, `added` or `failed`.

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

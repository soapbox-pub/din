<h1 align="center">
  <img src="public/din-logo.svg" alt="Din" width="280">
</h1>

**Din is a social computer.** You sign in with your Nostr account, and Din
bridges your identity into every application on the desktop — connecting you
to your friends across the network. Instead of relying on cloud services, Din
stores your data encrypted on free public infrastructure (Nostr relays and
Blossom servers). You can also self-host your own relays and servers, or
operate entirely locally.

Din features advanced AI integrations: control your whole computer by talking
to an agent, with support for local LLMs. You can also easily add sandboxed
OpenClaw agents that run 24/7 — as long as your computer is on.

## Architecture

Din is a web-native desktop environment built in Electron, targeting Linux
systems. The desktop itself — windows, taskbar, apps, login — is a Vite +
React 19 + TailwindCSS 4 + shadcn/ui app (based on the
[MKStack](https://soapbox.pub/mkstack) template) hosted by a thin Electron
shell, so it can run:

- **in kiosk mode** on top of any OS that Electron supports,
- **windowed** on a normal desktop for development,
- or as a plain web app in any browser (with reduced integration).

**DinOS** is the flagship OS of Din: a minimal NixOS system that boots
straight into Din fullscreen. No X11, no display manager, no traditional
desktop — just:

```
Linux kernel -> systemd -> din-shell (Din's own Wayland compositor) -> Electron -> Din
```

din-shell is `din-compositor session` (`native/din-compositor/src/session`), a
Smithay compositor that drives the displays through DRM/KMS and input through
libinput, shows Din's one window across every display, and speaks the wlroots
protocols the rest of the system uses: output management (`wlr-randr`, Din's
display settings), screencopy (`grim`, AirPlay) and gamma control (night
light).

Each display has a zoom of its own, its scale in din-shell: automatic from
its pixel density (`src/lib/autoZoom.ts`) until the user picks one in
Settings → Display, which is remembered for that display
(`src/lib/displayZoom.ts`, `din display set <monitor> --zoom`). Din's window
is drawn at the densest display's scale and scaled down on the others, so a
hidpi panel beside a low-dpi monitor shows the desktop at the same size on
both. Elsewhere (a windowed shell, bare X11) the zoom is one Chromium page
zoom for the whole desktop.

## Requirements

- Node.js (dev servers and builds)
- Xvfb, for running native Linux apps inside Din; optionally Rust (cargo), to
  build the Wayland compositor that hosts the apps able to use it (and draws
  them on the GPU), plus Xwayland, to put X11 apps there too. The compositor
  links against pixman, gbm, and xkbcommon, so it needs their development
  packages:
  - Fedora: `sudo dnf install xorg-x11-server-Xvfb xorg-x11-server-Xwayland pixman-devel mesa-libgbm-devel libxkbcommon-devel`
  - Debian/Ubuntu: `sudo apt install xvfb xwayland libpixman-1-dev libgbm-dev libxkbcommon-dev`
  - Void: `sudo xbps-install xorg-server-xvfb xorg-server-xwayland pixman-devel libgbm-devel libxkbcommon-devel`
    (a plain `xorg` install doesn't include Xvfb)
- Wine, for Windows programs
- Nix (with flakes enabled; the Determinate installer does this by default) —
  only needed for the DinOS `os:*` commands
- QEMU (`qemu-system-x86_64`) on the host for the `npm run os:run` demo

## Usage

```sh
npm run dev         # run Din in Electron with live HMR (windowed + DevTools)
npm run dev:browser # run Din in a plain browser with HMR (http://localhost:8080)
npm test            # type-check + lint + tests + build
npm run build       # build the web app into dist/
npm run build:native # build the Wayland compositor + GPU buffer addon (cargo)
npm run os:build    # build the installable DinOS disk image (./result/nixos.img)
npm run os:run      # demo DinOS in a QEMU window
npm run os:clean    # remove the build output and the demo VM disk (dinos.qcow2)
```

`npm run dev` starts Vite, then launches the same `electron/main.mts` DinOS
uses (Electron comes from devDependencies, pinned to the version the OS image
ships) against the dev server via `DIN_DEV_URL`. This gives you the real
Electron/`app://` environment with Vite HMR + React fast refresh. Ctrl-C stops
both processes.

### Din as your desktop, on another Linux

From a checkout, Din can go on your login screen's session menu (GDM,
LightDM, SDDM) next to the desktop you already have:

```sh
npm run session:install              # build this checkout and add "Din" to the login screen
npm run session:install -- --default # ...and log in to it by default
npm run session:update               # rebuild from the checkout for the next login
npm run session -- rollback          # back to the build before
npm run session -- restore           # log in to your old desktop by default again
npm run session:uninstall            # take Din off the login screen
```

Settings → About does the same from `npm run dev` (**Use Din as your
desktop**), and from the session itself, where it also updates, rolls back,
and returns to the old desktop. The session runs Din the way DinOS does, Din's
compositor on the screen running Electron, but from a copy of a build in
`~/.local/share/din/session`, never the checkout, so a broken edit can't keep
you from logging in. sudo asks for the password once, to install
`/usr/share/wayland-sessions/din.desktop`, the `/usr/local/bin/din-session`
it runs, on Ubuntu 24.04 and later an AppArmor profile that lets
Electron's sandbox start, and with LightDM a setting that keeps sessions on VT
7 and up, away from the console login prompts that would otherwise read what's
typed in Din (Fedora's LightDM starts at VT 1). If Din fails three times running just after
logging in, the login screen goes back to your old desktop. In the session,
the account menu has **Log out**. DinOS-only parts (updates, the Installer,
the lock screen, nostrd) stay off. `scripts/session.mjs` has the details.

Building it needs Rust 1.85 or newer ([rustup](https://rustup.rs); distribution
packages are often older) and the compositor's libraries:

- Debian/Ubuntu: `sudo apt install pkg-config libseat-dev libinput-dev libudev-dev libgbm-dev libdrm-dev libxkbcommon-dev libpixman-1-dev`
- Fedora: `sudo dnf install pkgconf-pkg-config libseat-devel libinput-devel systemd-devel mesa-libgbm-devel libdrm-devel libxkbcommon-devel pixman-devel`
- Arch: `sudo pacman -S --needed pkgconf seatd libinput systemd-libs mesa libdrm libxkbcommon pixman`

The script says which are missing. NixOS can't take it (`/usr` is read-only);
it has a module instead.

### Din as the Windows shell

Din can stand in for Explorer as the desktop a Windows user logs in to:

```sh
npm run build && npm run windows:package   # dist-windows/din, with Electron's Windows build
```

Copy `dist-windows/din` to the Windows machine, and in the user's PowerShell
run `.\din\install-shell.ps1` (`-Restore` goes back to Explorer). It sets the
per-user shell (`HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell`)
to `din.exe --din-shell`, from the next sign-in (tried on Windows 11
Enterprise). Ctrl+Alt+Del → Task Manager → Run new task →
`explorer.exe` is the way out for a session where Din won't start.

As the shell (`electron/windows-shell.mts`), Din's window is the desktop:
`electron/windows-shell-helper.ps1` keeps it under every program's window,
as Explorer's desktop is, and sets the work area so maximized programs leave
the menu bar showing. Programs (`.exe`, `.lnk`, `.msi`, `.bat`) open with
Windows itself, not Wine; Log out signs out of Windows, and Restart and Shut
down go through `shutdown.exe`. Din's desktop and apps see Windows' paths
in POSIX form (`C:\Users\Din` is `/C:/Users/Din`, and `/` is the computer,
whose folders are its drives), translated where they cross into main
(`electron/windows-paths.mts`); the files Windows hides (`desktop.ini`,
`Thumbs.db`, …) are hidden, and UTF-16 text is read and saved as it came.
Not there yet: programs' windows in the Dock
(Alt+Tab switches between them), Din's menus and windows over programs', the
Run keys and Startup folder, and the Linux-only parts (Terminal, displays,
sound, Wi-Fi, …).

### Din on NixOS

On NixOS, Din goes on the login screen from the system's configuration, with
`os/flake.nix`'s `nixosModules.din` (`os/desktop-module.nix`):

```nix
# flake.nix
inputs.din.url = "git+https://git.shakespeare.diy/npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj/din.git?dir=os";

# the system's modules
din.nixosModules.din
{ services.desktopManager.din.enable = true; }
```

It's the session above, built by Nix from the same derivations as DinOS
(`os/packages.nix`) with the system's own nixpkgs, and with the `din`
command. It turns on what Din's Settings works through, NetworkManager,
Bluetooth, UDisks, UPower, PipeWire and the login keyring, each only by
default (`enableSystemServices = false` leaves them to you), and makes Din's
file chooser the portal's in Din's session alone. `extraElectronFlags` passes
Electron more arguments. Updates are the system's: Din updates when the
input does. DinOS's own parts (its updater, the Installer, the lock screen,
nostrd, optional features) stay off.

`nix run ./os#desktop-vm` tries it in a throwaway NixOS: log in as `tester`,
password `din`. `nix build ./os#checks.x86_64-linux.desktop-module` checks
that the module adds nothing when it's off and none of DinOS when it's on.

`npm run os:build` produces the real artifact: a raw UEFI disk image meant to
be installed on a physical machine. Write it to a drive and boot from it:

```sh
sudo dd if=result/nixos.img of=/dev/sdX bs=4M status=progress conv=fsync
```

The image is 6 GiB, to fit any 8 GB stick; any tool that writes images
(Etcher, Rufus, `dd`) will do. Its root is Btrfs laid out as an installed
disk is (below), with everything compressed at zstd's strongest level, since
a USB stick is slow to read, and about 1 GiB free for a live session; nothing
grows it at boot (`os/make-stick-image.nix`).

Written to a USB stick instead, the same image is a live system: boot a laptop
from it and Din opens the **Install DinOS** app, which copies the running
system onto the computer's own disk — erasing it, or into its unpartitioned
space next to Windows (shrink Windows' partition in Disk Management first; the
firmware's boot menu then picks between them). It copies with `btrfs send`,
the data still compressed, so each byte is read off the stick once, as stored. The sign-in, saved Wi-Fi, and
files from the live session come along. The app only appears when DinOS is
running from removable media; the disk work is `os/din-install.sh`, run as
root through a sudo rule for that one program. Because the stick and the
installed disk are copies of each other, nothing is mounted by label: the
initrd finds root by GPT auto-discovery on the disk the boot loader ran from.

Every install has the same layout, with no choices offered: an ESP and one
system partition (optionally LUKS-encrypted) holding a Btrfs filesystem with
an `@` subvolume for the system (the default, which the initrd mounts as
root) and `@home` for home, sharing the disk's space and compressed with
zstd. Disks under 56 GiB are refused. Run on a disk that already has DinOS,
the Installer offers to **reinstall and keep your files**: it builds the new
system in `@new`, never mounts `@home`, carries over saved Wi-Fi, Bluetooth
pairings, the Nostr account keys, and the machine's identity, and only swaps
the new system in once it's complete.

**Set up for someone else** (`din-install install <disk> oem`, `din installer
install`) erases the disk and leaves it as if DinOS had been installed there
and then erased (below), the way a computer comes from the shop: nothing of
the live session's (home is empty, and the rest goes by the same list
`din-erase` uses, `os/din-pristine.sh`), no password, and the disk encrypted
under a new random key on the boot partition, which opens it without asking
until the first start's Setup replaces it with its owner's password. Unlike
erasing in place, nothing anyone had is left on the disk.

Systems installed before Btrfs have an LVM volume group, `dinos`, in its
place, with ext4 `root` and `home` volumes; they still boot, and reinstalling
one keeps that layout (formatting `root`, never mounting `home`). Moving one
to Btrfs means copying home off and erasing the disk. The group is created
with LVM autoactivation off; only the initrd activates it, and only on the
disk it booted from, so a DinOS disk attached to another DinOS machine (or
under a live stick) is left alone. `nix build ./os#checks.x86_64-linux.install`
installs from the image over USB in a VM and boots each result: a new
install, a reinstall, and a disk installed before Btrfs, before and after
reinstalling it.

One password runs the computer. Encrypting the disk sets its passphrase as
`din`'s password too, and as the password of **nostrd**, the signer daemon that holds the Nostr account
keys as its own user so nothing `din` runs can read them. Din signs through
nostrd's socket, and the passphrase typed at boot unlocks it. It unlocks the
login keyring too (which the first boot creates with it, and Passwords'
vault), and any GPG key whose passphrase is the same, so signing
commits doesn't ask (`os/din-gpg.py`). Settings → Password changes it
everywhere at once (`os/din-password.py`, disk first).

`sudo` (Din's own helpers excepted) asks you to approve the command in Din,
with a click and no password: the agent's commands in the Assistant's
conversation, others (typed in Din's Terminal, say) from a notification.
Root asks from
sudo's PAM stack (`os/din-password.py`'s `sudo check`) and only takes an
answer from Din's main process, the one child of din-shell's compositor,
whose Electron has its Node inspector fused off so nothing else can run code
in it. With no Din to ask (the text console, SSH), or no answer, `sudo` asks
for the password instead, in Din when there's no terminal (`os/din-askpass.py`,
`electron/askpass.mts`). Settings → Password can have it always ask for the
password, or never ask. Without encryption there's no password, and `sudo`
doesn't ask.
`os/tests/accounts.nix`
checks all of this in a VM: `nix build ./os#checks.x86_64-linux.accounts`.

Settings → About's **Erase all data** (`din update erase`) starts the
computer over: no files, accounts, apps, saved networks or settings, and no
password (`os/din-erase.sh`). It takes the password, and only erases a
computer whose next boot is official DinOS, since a build of the user's own
comes from `~/DinOS`, which goes; the dialog builds official DinOS first if
it isn't. Every other system leaves the boot menu, the disk gets a random
key on the boot partition, which the initrd unlocks it with from then on
without asking, and Din isolates `din-erase.target`: everything but the
system's own base stops, Din and the user's session included, and with only
the boot screen's "Erasing…" showing, `din-erase run` swaps an empty
`@home` in for the old one and deletes it, empties `/var/lib` and the rest
of the user's traces, and takes the old password's keyslot off the disk,
leaving only that key. Then the computer restarts. An erase cut short is
finished at the next boot, before anything has started (the initrd's
`dinos-erase`, then `din-erase-finish`). Din shows
Setup (`src/components/desktop/Setup.tsx`) in place of the desktop until
there's a password again: the keyboard layout, then the password, which
`din-password setup` sets everywhere, replacing the key. Deleted files aren't
overwritten, and an encrypted disk keeps its volume key, so whoever has the
key can read them; the dialog points to the Installer's Set up for someone
else for giving the computer away. `nix build ./os#checks.x86_64-linux.erase`.

The boot is quiet: no boot menu (hold Space to get it), no log lines, just
Plymouth drawing Din's boot screen (`os/boot-screen/din.script`). On an
encrypted disk that's where the password is typed, over the user's wallpaper,
with a clock, in the keyboard layout Settings set. None of that can come from
the encrypted disk, so the wallpaper, layout, time zone and clock format are
kept on the boot partition under `din/` (`os/din-boot-screen.sh`), and the
initrd copies them out before Plymouth starts. Once root is mounted the screen
fades to black, and Din fades in from there.
`nix build ./os#checks.x86_64-linux.boot-screen` draws it in a VM and leaves
screenshots in `result/`.

Closing the lid, or **Lock** in the account menu, locks the computer: the boot
screen again, run as root on its own terminal by `os/din-lock.py`, with
terminal switching turned off until the password is typed, so nothing running
as `din` can get past it. On an encrypted disk the computer then sleeps, and
after two hours (or on low battery) hibernates to a swap file on the encrypted
root, so the disk is locked too; waking from that goes through the boot
screen's password, and the lock screen steps aside. Without a password nothing
locks, and the lid just suspends. `nix build ./os#checks.x86_64-linux.lock`.

Installed systems update themselves, by building Din from source. Each keeps
a checkout of Din in `/var/lib/dinos/src`, which only root can write to, and
follows one branch of one repository: by default `main` of Din's own,
`nostr://npub10qdp2…/git.shakespeare.diy/din`, which git fetches through
`git-remote-nostr` (from ngit, which DinOS ships), taking the branch's tip
from the maintainers' signed repository state. `din-update.service` runs
`os/din-update.sh` five minutes after boot and every six hours after: it
fetches the branch, and if its tip is a commit the system isn't already
running or staging, builds that commit's `os#dinos` and stages it with
`switch-to-configuration boot`, the same as `nixos-rebuild boot`. Each
system records the commit it was built from (`/etc/din-revision`), and a
commit that fails to build isn't tried again until someone asks. Nix's
builds run at idle priority, and the timer's runs wait for AC power.

Before it builds, the updater asks Nix (`--dry-run`) how much the update
downloads, and makes sure root has that plus 4 GB free for the store and
`/home` 10 GB for build scratch (`nix.settings.build-dir`). If not, it drops
systems beyond the boot menu's five from the profile and collects garbage;
if that's still not enough it stops and says why. Every update prunes the
profile the same way after staging, and `min-free`/`max-free` have Nix make
room on its own if a build runs short anyway. Settings → About shows the
build's progress, offers the restart, turns automatic updates off (a
developer building by hand wants that; **Check now** still works), and
changes the repository and branch, so anyone can run their own fork:
`din-update source <url> <branch>`, through sudo, which asks first, since
whoever picks the source picks what runs as root. Older systems stay in the
boot menu. Live sticks aren't updated.

A staged update needn't wait for the next boot. Settings → About (and the
notification saying it's ready) offers **Apply now**, `din-update apply`:
the same switch as `nixos-rebuild switch`, which restarts the services that
changed but never `din-shell.service`, Din itself. If the update brings a
new Din, the old one runs on until **Restart Din** (`din-update
restart-din`), which closes every app; if it brings a new kernel, initrd,
kernel parameters, modules or firmware, it isn't applied, and the computer
restarts instead. `din-update status` reports what the running system
still needs (`restart`) and what the staged one would (`stagedNeeds`), by
comparing those with the booted system's and the command din-shell is
running with the system's own; Din offers the restart either way, including
after a switch by hand. Din's launcher names the updater through
`/run/current-system`, since a Din that hasn't restarted may only run the
new system's.

A computer's own changes live in `~/DinOS`, the user's copy of Din, built
with `din update local` (the assistant's `dinos` skill,
`os/opencode/skills/dinos`): Din resolves `main` of `~/DinOS` to its commit
and runs `din-update local <commit>` through sudo, which asks the user
("Allow the assistant to update Din?"). The service builds that commit like
any update, then the command switches to it and Din restarts if it changed.
Updates keep them: when the
commit the newest system was built from isn't in the followed branch, the
updater merges the branch's tip into that exact commit, which the user
approved when they built it, and builds the merge. It reads the commit from
`~/DinOS` as the user if its checkout lacks it, and never builds whatever
else is there. A merge that conflicts or doesn't build, or a system built
from uncommitted changes, fails with a reason; Din then offers **Fix with
assistant**, which merges in `~/DinOS`, where sudo asks again. So does a
system built from a commit the updater can't find at all (not on the
branch, nor in `~/DinOS`): building the branch over it could go back to an
older Din, so it's left alone until the user picks **Use <branch>
instead** (`din-update replace`). A merge that comes out the same as the
branch's tip, once the user's changes are upstream, builds the tip itself,
so the system stops being custom. The checkout's `upstream` branch is the
tip last fetched and `system` the last commit it staged, for `~/DinOS` to
pull. A developer can point `~/DinOS` at their own checkout with a
symlink. Dismissing that notification sets the failure aside, across
restarts, until an update stops on another commit of the user's: the branch
moving on doesn't bring it back. Settings → About still shows it.

A system behind its branch (updates off, on battery, or the user's changes
conflicting) may lack a fix for a security issue, and **a commit that fixes
one says so** with a trailer in its message:

```
Check the path the fs bridge is given against the folders it grants

Security: high
```

The severity is `low`, `medium`, `high` or `critical`. A commit that only
later turns out to have fixed one is flagged by a later commit (empty, if
there's nothing else to it) naming it: `Security-Fix: <commit>`, with its
own `Security:`. The trailers ride on the signed branch like the code
they're on, so there's nothing else to publish. Whenever a run ends, the
updater lists the branch's flagged commits the newest system has no change
like (a fix cherry-picked into the user's commits counts), and with updates
off or on battery the timer's runs still fetch the branch to look for
them. `din-update status` reports them (`security`), Settings → About lists
them, and Din puts up a notification for each new one, even once the
failure keeping it out was dismissed, offering **Update now** or, when the
user's changes are in the way, **Fix with assistant**. Dismissing it sets
those fixes aside for good. A fork set as the source passes on Din's fixes
only once its maintainer merges them.

New installs start from a disk image. To cut one, bump `os/version`, commit,
tag `v<version>`, and run `npm run os:release -- -- --nbunksec-file <file>`
(or pass any other `ngit release publish` signer option after the second
`--`). It builds the image from a clean worktree of the tag and publishes it
as a NIP-82 release of the application `din` (`.ngit/release.yaml`), signed
by the soapbox.pub key, with the file on Blossom.
`npm run os:release -- --stage-only` builds it into `.release-artifacts/`
without publishing anything. Installed systems don't use releases.

For debugging on real hardware, `nix build ./os#debug-image` builds the same
image plus an SSH server (key-only) and mDNS (`dinos.local`). No key is baked
in: after writing the drive, mount its root partition and put a public key in
`/root/.ssh/authorized_keys`, and a NetworkManager profile in
`/etc/NetworkManager/system-connections/` (mode 600) if the machine needs
Wi-Fi. A system installed from a debug stick keeps that access.

`npm run os:run` is
for demoing: it boots the same system in a QEMU window (software rendering,
since QEMU provides no GPU), with boot logs mirrored to the serial console
(your terminal).

## Layout

- `src/` — the Din desktop environment (React, Tailwind, shadcn/ui)
- `src/apps/` — the built-in apps, each a page of its own at `din://<id>/`
  in its own process, reaching the desktop only through `window.din`
  (`src/sdk/`); code they share is in `src/shared/`. See `docs/README.md`.
- `electron/main.mts` — the Electron host; serves `dist/` over a custom
  `app://` protocol (real origin, SPA fallback for BrowserRouter)
- `electron/din-apps.mts` — the built-in apps' `din://` protocol, session
  and ports
- `electron/preload.cjs`, `electron/pty-host.py` — `window.dinos`, the
  desktop's bridges to the system (fs, pty, wifi, …)
- `electron/native-*.mts`, `electron/wayland-bridge.mts`, `native/` — the
  embedded display that runs native Linux apps inside Din windows (see
  "Native Linux apps" below)
- `os/` — DinOS, the flagship OS:
  - `os/flake.nix` — entry point; exposes the installable disk image as
    `./os#image` (the default) and the QEMU demo as `./os#vm`, and pulls in
    the Din source tree (the repo root) as an input
  - `os/configuration.nix` — the whole OS definition: the din-shell service
    (Din's compositor), the Electron launcher and the rest
  - `os/packages.nix` — the Nix builds of Din (`buildNpmPackage`), its
    compositor, din-fd and the Electron it runs on, shared by DinOS and
    `os/desktop-module.nix`, Din as a desktop on any NixOS (see "Din on
    NixOS")
  - `os/din-install.sh` — the Installer app's privileged helper (see
    `electron/installer.mts`)

## Dev loop

Three tiers, fastest first:

1. **Browser + HMR** (`npm run dev:browser`): Din is an ordinary Vite app;
   edit `src/` and see changes instantly at http://localhost:8080.
2. **Electron windowed + HMR** (`npm run dev`): runs Din inside the actual
   Electron host (`app://` protocol, CSP, download handling) pointed at the
   Vite dev server, so it matches DinOS while staying hot-reloadable. Under
   the hood this just sets `DIN_DEV_URL=http://localhost:8080` for
   `electron/main.mts`.
3. **Full OS demo** (`npm run os:run`): rebuilds DinOS and boots it in
   QEMU; only changed layers rebuild. The demo VM disk (`dinos.qcow2`)
   persists between boots; `npm run os:clean` resets it.

### Native Linux apps

Installed desktop apps launch onto Din's embedded display, a pair of private
servers whose windows Din composites into its own:

- **Wayland** — `native/din-compositor`, a headless Smithay compositor (Rust).
  Apps that speak Wayland (GTK, Qt, Firefox, Electron, SDL) use it. With a
  GPU, it composites each window on the GPU into shared dmabufs that Din's
  main process imports once each (`sharedTexture`; the descriptors arrive via
  `native/din-fd`, a small N-API addon) and the shell draws without any CPU
  copy - apps get linux-dmabuf and render on the GPU too. A window that is
  one surface in one GPU buffer (most games, video players and X11 apps)
  isn't composited at all: Din imports the app's own buffer (in any layout
  when the compositor is on the GPU Chromium uses, only linear ones
  otherwise, as with two GPUs). Without one, pixels
  stream to the shell over a token-guarded localhost WebSocket. Either way,
  apps are paced by the shell's display refresh. Apps draw at the shell's
  pixel ratio (its zoom, times the screen's scale): the outputs carry it,
  as a fractional scale (wp_fractional_scale, with wp_viewporter) or a
  whole buffer scale, and windows reach Din at it, so they're as sharp as
  Din's own at 200%. A buffer the app drew at that scale is still passed
  on as it is.
- **X11** — the compositor's rootless Xwayland, which it manages as the X
  window manager, so X11 apps take the same (GPU) path as Wayland ones and get
  hardware OpenGL. X apps draw at 1, which Din scales up: Xwayland can't tell
  its clients a scale, and making it run at the screen's pixels would leave
  every app that doesn't scale itself tiny. Where Xwayland isn't installed, or without the compositor,
  X11 apps fall back to a private Xvfb, managed and composited by
  `electron/native-display-worker.mts` (software rendering).

The compositor also speaks relative-pointer and pointer-constraints, for
mouse-look in games (Wayland or X11 via Xwayland): an app's pointer lock
becomes DOM Pointer Lock on its window, Escape releases it, and the next click
in the window lets the app take it again.

Apps type with the system's keyboard layout (`electron/keyboard.mts` reads it
from `XKB_DEFAULT_*`, GNOME or KDE settings, the host X server, or the system
keyboard config). Din sends them physical keys and both servers apply the
layout; the Xvfb fallback needs `setxkbmap` for it. Settings → Keyboard shows
the layouts (up to four, XKB's groups) and changes them on DinOS and GNOME.
DinOS keeps them in `/var/lib/din/keyboard` (`os/din-keyboard.sh` writes it as
root), which din-shell starts with; Din tells it a changed list and the layout
typing in `$XDG_RUNTIME_DIR/din-shell-keyboard`
(`native/din-compositor/src/session/layouts.rs`), so a change takes effect at
once. With more than one, the menu bar shows the layout typing and switches
it, and so do Ctrl+Space (back to the last one) and Ctrl+Alt+Space (the next),
as Control-Space and Control-Option-Space on a Mac; the embedded display's
servers get the keymap with the layout typing first.

Settings → Date & Time shows the system's time zone and clock, read from
systemd-timedated (`electron/datetime.mts`), and on DinOS changes them
through `os/din-time.sh`, which runs timedatectl as root. Chromium follows
`/etc/localtime`, so the new zone takes effect without a restart. The clock's
12/24-hour format, and whether the menu bar shows the date and seconds, are
Din's own settings; the boot and lock screens follow the format too.

Build both crates with `npm run build:native`. Without the compositor, every
app runs on Xvfb; without din-fd, the compositor stays on the CPU path.
`DIN_NATIVE_DISPLAY=x11` forces X, `DIN_COMPOSITOR_GPU=0` the CPU path and
`DIN_COMPOSITOR_PASSTHROUGH=0` compositing every window, for comparisons, and `DIN_COMPOSITOR_STATS=1` logs the compositor's frame
rate.

### Windows programs

Opening an `.exe`, `.msi`, `.bat` or `.lnk` (in Files, or a finished browser
download) runs it through Wine on the same embedded display, so it gets a Din
window like any native app. Din keeps one hidden Wine prefix in
`~/.local/share/din/windows`, created on first use without any Wine dialogs:
C: plus the home folder as H: (no Z: drive), the user folders linked to the
home ones, and crashes closing quietly instead of opening winedbg. Installers
need no help: the Start-menu shortcuts they create become desktop entries,
which appear in the launcher as soon as the install finishes (Uninstall
shortcuts are left out). See `electron/windows-apps.mts`.

Every Wine process runs in a bubblewrap sandbox (`electron/wine-sandbox.mts`).
It gets the system read-only, plus the GPU, sound, controllers and the
network. It also gets the prefix and the folders Windows has too: Desktop,
Documents, Downloads, Music, Pictures and Videos. Nothing else of home is
visible: no dotfiles, Din data, session bus, `din` socket or key agents. A
program or document opened from somewhere else (a USB stick) brings its
folder along. Wine's Start-menu entries, icons and file types go to
`~/.local/share/din/windows-shell` instead of `~/.local/share`. Din lists
them without trusting them: an entry from there only ever runs Wine, in the
prefix and the sandbox. All sandboxes share one `/tmp` (under
`$XDG_RUNTIME_DIR/din-windows`), where the prefix's wineserver keeps its
socket. Where bubblewrap is missing or can't make namespaces, programs run
unsandboxed.

An installed Windows program has Uninstall in its right-click menus (and
`din apps remove`), as in Windows' Apps & Features. Din finds the program
in the prefix registry's Uninstall keys: first by place (the shortcut's
folder inside its InstallLocation or its icon's folder), then by name
("Foo 2.1 (64-bit)" for "Foo", never "Foobar"). It then runs `wine uninstaller --remove <key>`, which opens
the program's own uninstaller. A program without one only loses its
shortcut. Wine never takes away an entry whose shortcut an uninstaller
deleted, so Din hides those. Wine's `.desktop` copies of desktop shortcuts
go to a folder out of sight, since the `.lnk` on the Desktop is the same
icon.

Windows programs' notification-area icons appear in Din's tray. Wine only
speaks the old XEmbed tray (`_NET_SYSTEM_TRAY`), so the compositor hosts
one on its Xwayland (`native/din-compositor/src/tray.rs`). It offers a
32-bit visual, so icons keep their transparency. Each docked icon sits in a
hidden container off every screen, under every other window, and the
compositor never shows it. The icon is redirected and its pixmap read every
half second; a changed icon is sent to `electron/tray.mts`, which lists it
with the StatusNotifierItems. A click comes back as the X button press and
release a real tray's icon gets: Activate is button 1, ContextMenu
button 3, both at the point clicked. The container moves under that point
first, so the program's own menu opens under Din's icon. Wine's explorer
draws every program's icon, so an icon can't say which program it's for.

Files' and the desktop's right-click menus have Open With for the
installed apps that open a file (`din apps open-with`), by its type. Types
come from the shared MIME database's globs, plus the types Windows programs
register, which Wine writes as packages beside their entries. Wine's entries
for those types are `NoDisplay`, so Din keeps NoDisplay entries only for
opening files. They're named and drawn from their program's own version
info and icon, found through the ProgID's open command in the registry. A
file of a kind Din has no app for opens in the first of them: Windows
programs' own types first, then by name.

On DinOS, Wine (`wineWow64Packages.stableFull`, which includes Wine Mono
and Gecko) is the Windows apps optional feature (below). Elsewhere Din uses
the system's `wine`, or `$DIN_WINE`.

The feature also brings Direct3D on Vulkan, which games need to run well or
at all. DXVK covers Direct3D 8 to 11 (nixpkgs' MinGW builds,
`pkgs.dxvk.dxvk64`/`dxvk32`). vkd3d-proton covers Direct3D 12 (its own
release tarball, since nixpkgs has no Windows build of it). Din links their
DLLs over Wine's in `system32` and `syswow64` (`$DIN_WINE_DXVK_X64` and
the rest) and sets them to load Windows' first, then Wine's (the
`native,builtin` override). Links left dangling by a removed feature are
taken away, so Wine's own OpenGL ones load again.

Wine Mono only stands in for the old .NET Framework, so the feature also
brings .NET (the runtime and its Windows Desktop part, 64- and 32-bit,
Microsoft's MIT-licensed builds, unpacked in the store), which Din links
into the prefix's `C:\Program Files\dotnet` and `C:\Program Files
(x86)\dotnet` (`$DIN_WINE_DOTNET_X64`, `$DIN_WINE_DOTNET_X86`), beside any
.NET installed there already. Programs built for an older .NET run on it
(`DOTNET_ROLL_FORWARD=Major`). A new .NET is `dotnetVersion` and the parts'
hashes in `os/configuration.nix`.

### AirPlay

The menu bar's AirPlay item (once a receiver is nearby) and Settings →
Display share the screen with Apple TVs, AirPlay TVs and Rokus. Like a
monitor plugged in, a receiver connects the way it was last used, extending
the desktop by default as a separate display arranged in Settings like any
other; while connected it can be switched to mirroring the primary display
and back, from the menu or with the display-switch key (F7 on ThinkPads), and
that is remembered (`airplay.json` in Din's config). Sound goes to the
receiver too. A receiver that drops or refuses the connection while it wakes
up is tried again for half a minute, still "Connecting…", as a Mac does; if
that gives up, Din says so in a sentence. The
sending is [deckmon](https://git.shakespeare.diy)'s, a daemon DinOS runs as a
user service (the flake's `deckmon` input) and Din talks to over its socket
(`electron/airplay.mts`). It captures the screen through din-shell's wlroots
screencopy. A separate display is one din-shell adds with no screen behind it
(`HEADLESS-1`, through its own din-virtual-output protocol,
`native/din-compositor/protocols/`): it's drawn only into deckmon's copies, as
soon as Din draws, and goes with deckmon, even if deckmon is killed.
Elsewhere Din uses a `deckmon` on PATH.

### Passwords

The Passwords app keeps logins, verification codes (TOTP) and secure notes
in a KeePass file, `~/.local/share/din/Passwords.kdbx` (KDBX 4, Argon2id),
which KeePassXC, Strongbox and KeePassDX open with the same password. Only
Din's main process holds it open (`electron/passwords.mts`); the app reaches
it through its `passwords` permission. Argon2 runs in a worker thread with
hash-wasm (`electron/passwords-kdf.mts`), since Electron's BoringSSL has none.

The vault comes with the computer, set up with its password: the first boot
after the Installer, creating the login keyring with the boot screen's
password, leaves a key for it derived from that password (`os/din-keyring.py`)
that Din makes the vault from, and Setup after erasing hands Din the new
password to make it with. A computer without one gets a setup screen that
takes the computer's password, checked by `din-password check`, or one of
the vault's own.

Set up with the computer's password, it opens at login with no prompt. The
key derived from the password, not the password, is kept in the login
keyring over the Secret Service (`electron/secret-service.mts`), which the
boot screen's password unlocks; the vault keeps its KDF salt across saves so
that key stays valid. Settings → Password re-keys the vault along with
everything else when its password was the computer's old one. Lock in the
app locks it until the password is typed; a save by another app (which draws
a new salt) makes the next unlock ask once.

The Web Browser fills logins in. `electron/passwords-preload.cjs`, in every
frame of web pages, reports focus on a login field; the desktop draws the
vault's logins for the site below it (`PasswordAutofillHost`), and main
checks the one picked against the frame's own URL (same host or registrable
domain, never https to http) before sending it to that frame. New-password
fields offer a strong password. A login submitted that the vault doesn't
have becomes an offer to save it, and the toolbar shows a site's saved
logins to fill or copy. Copied passwords and codes leave the clipboard after
90 seconds.

Passkeys work too: Din is the authenticator, since Chromium has none on
Linux. `electron/passkeys-preload.cjs` gives pages a `navigator.credentials`
whose public-key requests go to main (`electron/passkeys.mts`), and the
desktop asks the user below the toolbar (`PasskeyPrompt`): save a passkey,
or pick an account to sign in with. Main builds the signed client data from
the frame's own origin and checks the relying party ID against it, and keeps
each passkey in the vault the way KeePassXC does (`KPEX_PASSKEY_*` fields),
with the account's password when the vault has one, so KeePassXC, Strongbox
and KeePassDX use the same passkeys. A request for a security key, a frame
from another site, and the prompt's "Use a Security Key" go to Chromium's own
WebAuthn.

Import (the + menu, or Settings) adds another KeePass file's items, KDBX 3 or
4 with its password or key file, in a folder named after it; or another app's
export (`electron/passwords-import.mts`): CSVs from Google Passwords, the
Chromium browsers, Firefox, Safari and Apple Passwords, Bitwarden, 1Password,
LastPass, KeePassXC, Proton Pass, Dashlane, NordPass and the like, read by
their header rows, and Bitwarden's unencrypted JSON. The app reads the file
the user picks and hands its bytes to main, which parses it; items the vault
already has (same site, username and password) are skipped.

### Virtual machines

The Virtual Machines app runs other systems (Windows, macOS, Linux, anything
x86) with QEMU and KVM, no libvirt (`electron/vms.mts`, the `vms` permission).
Each machine is a folder in `~/VMs`: `vm.json`, `disk.qcow2`, the UEFI
firmware's variables (`vars.qcow2`), the TPM's state (`tpm/`) and macOS's
boot loader (`opencore/`). A running
machine is a detached `qemu-system-x86_64` as the user, with its QMP, VNC and
swtpm sockets in `$XDG_RUNTIME_DIR/din-vms/<uuid>/`; it keeps running when the
app closes, and Din finds it again after a restart by its pidfile. Its screen
is QEMU's VNC server, drawn by noVNC in the app, whose bytes go over the
app's bridge port (apps can't open sockets).

The app's gallery installs a system in one click
(`electron/vm-installers.mts`): Din makes the machine at once, sized to this
computer, then asks the system's own servers for its newest release and its
SHA-256 (Ubuntu's `meta-release-lts` and `SHA256SUMS`, Fedora's
`releases.json`, and for Windows Microsoft's download page, whose form a
hidden Electron window fills in since Microsoft turns away scripted
requests, and whose table lists each language's SHA-256), downloads it to `~/VMs/.installers/` (resumable, shared by
machines installing the same release, checked against that hash), and
installs it hands-free. Windows starts from its disc (Din presses Enter
for its "Press any key" prompt) with an `autounattend.xml` on a FAT drive
QEMU makes from a folder: Windows 11 Pro with Microsoft's generic key
(installed, not activated), the whole disk, and a local account with no
password, so no Microsoft account and no questions. At its first logon it
writes a line to the serial port, and Din ejects the disc and answer drive
while it runs. Linux installers boot their own kernel straight from
the disc image, with an answer file on a FAT drive QEMU makes from a folder
(Ubuntu's autoinstall, Fedora's kickstart): the account is the computer's
user's name, with no password, logged in automatically. The installer
powering the machine off is it finishing; Din ejects the disc and starts the
new system. The install's state is kept in `vm.json`, so it carries on after
a restart. Right-clicking a system offers Custom Install, the full form with
that system filled in; when a download fails, the app links to the system's
own download page and installs from the disc image the user chooses.

macOS is the newest release Apple's Internet Recovery offers the last Intel
iMac (iMac20,1's board, so macOS Tahoe 26), asked for as a Mac asks
(`osrecovery.apple.com`) and checked chunk by chunk against the chunklist
Apple signs with its EFI key. QEMU reads the `.dmg` itself, as a disk.
OpenCore, from acidanthera's newest GitHub release (checked against the
SHA-256 GitHub lists), starts it from a FAT drive QEMU makes of the machine's
`opencore/`, with a config made from the release's own `Sample.plist`: no
kexts, Apple Secure Boot off, and the machine's own iMac20,1 serial numbers.
Recovery has no answer file, so once its menu bar shows (Din reads the screen
over QMP) Din opens its Terminal with Shift-Command-T and types one command,
which runs a script on the answer drive: it erases the disk and runs
Apple's `startosinstall`, which downloads the full installer and restarts
the machine to install it. That restart is Din's part done: it takes the
answer drive out, and the app shows the screen, where Apple's installer
goes on through its own restarts to Setup Assistant, which the user answers.

Windows machines get what Windows 11's installer checks for and has drivers
for: UEFI with Secure Boot and Microsoft's keys (OVMF's `OVMF_VARS.ms.fd`), a
TPM 2.0 (swtpm), a SATA disk, an e1000e network card and Hyper-V
enlightenments. macOS gets an Intel CPU model (on AMD hosts too, with the
TSC's rate given so it can still be saved running), QEMU's Apple SMC, USB
input and a SATA SSD, and no sound (it has no driver for QEMU's); its
screen is 2560×1600, which macOS draws at Retina scale. Linux gets virtio, and its screen follows the window's size.
The clipboard is shared with guests running spice-vdagent; sound goes through
PipeWire. Snapshots are qcow2's own: taken while running, they keep memory
too and come back running.

DinOS passes QEMU, swtpm and OVMF to Din as `DIN_QEMU`, `DIN_QEMU_IMG`,
`DIN_SWTPM` and `DIN_OVMF`, which are there once the Virtual machines
optional feature is installed (below); elsewhere Din looks on PATH and in the usual
OVMF folders (`/usr/share/OVMF`, `/usr/share/edk2/ovmf`, …), and needs
`/dev/kvm` to be read-writable by the user.

### Games

The Games app plays the games in `~/roms`, laid out as RetroArch, EmulationStation
and Batocera lay them out: a folder per system (`nes`, `snes`, `gba`, `n64`,
`nds`, `psx`, `dreamcast`…; `electron/game-systems.mts` lists them and the
other names each goes by), its games in it, zipped or not, a game with
several files in a folder of its own. Main reads them (`electron/games.mts`,
`game-library.mts`, the `games` permission), groups each game's copies
(regions, revisions, discs) by their No-Intro names (`game-names.mts`),
picks the copy for the computer's language, and hides BIOS files, bad dumps,
demos and betas. Box art comes from libretro-thumbnails, matched by name, with
the list of what it has for a system cached in `~/.cache/din/games/art`.

Playing a game runs RetroArch with the system's core, full screen on the
embedded display, as an app of its own named for the game with its box art
in the Dock (`launchAsApp` in `electron/native-apps.mts`), where its frames go
straight to the screen and the performance power mode comes on. Din writes
RetroArch's settings itself, in `~/.local/share/din/games` (saves, the
moments games were left at, BIOS files), and never touches
`~/.config/retroarch`: Vulkan, PipeWire, controllers set up by RetroArch's
autoconfig profiles, pixel art scaled sharp, the game paused while its window
isn't in front, and where a game was left saved when it quits and picked up
when it starts again. Start+Select quits back to the library; the Home button
or L3+R3 opens RetroArch's menu. The app is driven by a controller as well as
the mouse (`src/apps/games/games/input.ts`), and full screen it becomes a TV's
view. GameCube, Wii, 3DS, PS2 and Switch games are listed but can't be played
yet: their emulators aren't libretro cores.

On DinOS RetroArch and its cores are the Games optional feature, found through
`DIN_GAMES` (a part per core, all free software in the binary cache);
elsewhere Din runs `retroarch` from PATH with the cores it finds in the usual
places.

### Printing

Printers need no setup on DinOS. CUPS runs with Avahi and ipp-usb, so a
printer on the network, or one plugged in that speaks IPP over USB, appears
in the print dialog as soon as it's on. The first time Din prints to one (or
makes it the default) it gives it a driverless queue of its own, so it's
still there after a restart. Din reads the printer list in the background
once it starts, so the print dialog doesn't wait on the network, and
remembers the network printers found on each Wi-Fi or wired network
(`printers.json` in Din's config), so they're listed again as soon as the
computer is back on it, before CUPS has found them. Settings →
Printers shows them and their queues, sets the
default, prints a test page, and adds older USB printers with the best
driver installed (gutenprint, brlaser).

The print dialog is Din's own, a window per document
(`src/components/desktop/apps/PrintWindow.tsx`), not a modal, so the
desktop stays usable while a job is sent: Chromium's would open a GTK
window, which DinOS's compositor wouldn't show. `electron/print-preload.cjs` sends every page's `print()`, frames'
included, there, and so do Ctrl+P, the browser's menu and right-click menu,
and Print in Files and Preview. Whatever is printed goes to CUPS as a PDF
laid out by Chromium, and the dialog previews that PDF's pages, drawn by
poppler (`electron/printing.mts`). Save as PDF needs no printer at all.

### Assistant

The Assistant app, the menu bar's robot, and Super+A (a prompt from
anywhere) talk to [OpenCode](https://opencode.ai) v2, the coding agent,
through its per-user background server (`opencode serve --service`). Din
starts it at login while Settings → Assistant has it on, and holds its
password and event stream in the main process (`electron/assistant.mts`);
the shell only gets what it asks for under `/api/`. Conversations are
OpenCode's sessions, so `opencode` in a Terminal shares them. OpenCode is the
user's own self-updating install in `~/.opencode/bin` (DinOS puts it on
PATH). DinOS's disk image comes with it there (`opencode` in
`os/flake.nix`; bump its version and hash now and then). Where it's missing,
or won't run (it's the AVX2 build), Din runs the v2 installer;
`$DIN_OPENCODE` names another binary. As OpenCode's TUI does, Din asks
OpenCode's update service for a newer release every few hours while the
assistant is on, and offers it at the foot of the Assistant's list and in
Settings → Assistant (`din assistant update`): `opencode upgrade`, then the
server restarts on it.

### Dictation

Super+H types what you say into whatever has the keyboard: a text field, a
web page, the Terminal, or a native app (pasted, since the display only sends
keys). Holding Super+A opens the assistant's prompt listening, and the
prompt's mic button dictates into it. The shell records the microphone
(`src/lib/dictation.ts`) and whisper.cpp's server turns it into text on the
GPU (`electron/dictation.mts`), started on first use and stopped after a few
idle minutes. On DinOS the server and Whisper large-v3-turbo (about
550 MB) are the Dictation & transcripts optional feature (below), named in
`$DIN_WHISPER_SERVER` and `$DIN_WHISPER_MODEL`; elsewhere, set both to
dictate.

### Tiling and workspaces

Windows float by default. Super+Shift+T (or Settings → Windows, or Super+T
on a window) turns on Hyprland-style dwindle tiling: each new window splits
the focused tile (`src/lib/tiling.ts`). The rest of the Super keys follow
Omarchy's bindings (`src/lib/wmBindings.ts`; Super+K lists them), and work
with tiling on or off. Each monitor has workspaces 1 to 10 of its own;
windows on the ones not showing stay mounted, hidden like minimized ones.
The window manager (`src/hooks/useWindows.ts`) keeps the tiling trees, and
`settle()` derives every window's tile and visibility after each change.
While tiling is on, or a workspace other than 1 is in use, the menu bar shows
the workspaces and a switch to turn tiling off. Keys pressed inside web pages
reach the shell through the host's `wm` shortcut (`electron/main.mts`).

### Optional features

Some of DinOS takes a lot of space and only some people use it, so it isn't
on the disk until someone installs it, in Settings → Optional Features or
with `din features`: Windows apps (Wine), Virtual machines (QEMU, swtpm,
OVMF), Dictation & transcripts (whisper.cpp and its model), a web view for
Linux apps (WebKitGTK, on nix-ld's library path) and Linux containers
(Podman, `docker`, distrobox). Together they're over 2 GB the disk image
doesn't carry.

Each is a few packages from the system's nixpkgs, its parts, listed in
`dinFeatures` in `os/configuration.nix`. The system names them in
`/etc/dinos/features.json` only by the store paths they are, so none of
them, nor how they're built, is in the system (and so not on the disk
image); installing one downloads each part as the user through the Nix
daemon (`electron/features.mts`) from the binary cache, which has
everything nixpkgs builds, into `~/.local/state/din/features/<id>/<part>`,
a GC root. The release checks every part is there
(`scripts/dinos-release.sh`). A part that's a plain download, the Whisper
model, gives its URL and hash and lands where `fetchurl` would put it.
Everything that uses a feature looks at its parts' links (the launcher's
PATH and `DIN_*` variables, nix-ld's library path; `docker` is a small
script in the system for Podman), so it works as soon as it's installed.
Removing one deletes its links and whatever only it used. A system update
downloads the new versions of installed ones before switching
(`os/din-update.sh`), and Din updates any it couldn't soon after it
starts; one installed before features had parts, a single link, is
downloaded again in parts. A computer updated from a
DinOS that had them all built in keeps them all: the first time Din starts
with optional features there, it installs every one, from what's still in
the store.

Dictation is `default`: it comes with the computer all the same, without
the disk image carrying it. Din keeps which features the user wants in
`~/.local/state/din/feature-choices.json`, and a default one counts as
wanted until they remove it, so a new or erased computer downloads it in
the background soon after Din first starts, and an install that a restart
or a lost connection cut short carries on the next time Din starts or the
computer is online (it tries every few minutes). Nothing downloads by
itself from a live USB stick (`/run/din/live`); the computer it's installed
onto does. A computer set up before defaults existed, whose features
folder was already there, treats a default feature it doesn't have as
removed.

A new optional feature is an entry in `dinFeatures` with a title,
description, size and package (and `default = true` if it comes with the
computer), whose users look for it under its link.

### Updating npm dependencies

The Nix build fetches npm deps from `package-lock.json` pinned by hash.
After changing dependencies, refresh the hash in `os/packages.nix`:

```sh
nix run --inputs-from ./os nixpkgs#prefetch-npm-deps -- package-lock.json
# copy the sha256-... into npmDepsHash in os/packages.nix
```

Also note: when built from a git checkout, the flake only sees **git-tracked**
files — `git add` new source files before `npm run os:build`.

## Notes

- The Web Browser app supports Chrome extensions (tabs, toolbar actions,
  content scripts) via
  [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell);
  `about:extensions` (the browser menu's Extensions) lists the installed
  ones and adds more: from the Chrome Web Store, a folder (which Din keeps
  loading from where it is), a `.crx` file, or Nostr (NIP-82 apps with a
  `.crx`, see `NIP.md`), and publishes any of them from its menu. Extensions
  run only in the browser's session partition — never against the shell.
  Installed web apps share that partition, like installed apps in Chrome: a
  site signed in in a tab is signed in in its app window, and the reverse.
  Manifest V2 is allowed (Electron lacks `declarativeNetRequest`, so classic
  content blockers like uBlock Origin need it); `chrome.*` API coverage is
  broad but not complete.
- Din's signer is the system's NIP-07 provider. Browser tabs (not private
  ones) and installed web apps get a `window.nostr` (`electron/nostr-preload.cjs`)
  whose calls Din answers: a site has to ask to connect before it learns who
  you are, and Din asks before it signs, encrypts or decrypts anything unless
  you told it to remember (per site, and per kind for signing). Apps on other
  devices can use your account the same way over NIP-46, with a bunker:// link
  Din makes or a nostrconnect:// link they make (`electron/bunker.mts`).
  Settings → Connected apps lists all of them; the key button in the browser's
  toolbar shows the current site's.
- The Settings app manages WiFi through NetworkManager (`nmcli` behind an
  Electron IPC bridge, `electron/network.mts`): joining, Add network (hidden
  and 802.1X enterprise networks), Saved networks, and each network's own
  page with Android's options (auto-connect, metered, MAC privacy, password
  or sign-in, static IP and DNS, proxy, hidden, share as a QR code). A
  network's proxy is Din's own (kept in `wifi-proxy.json`) and applies to
  Din's browser and apps while that network is up. NetworkManager picks up
  physical adapters (wired and wireless) automatically. Note that QEMU has no wireless hardware, so the
  WiFi panel will show no networks inside the demo VM.
- The Settings app and the menu bar manage Bluetooth through BlueZ over the
  system bus (`electron/bluetooth.mts`): turning it on and off, finding,
  pairing, connecting and forgetting devices. Prompts a pairing needs (a code
  to compare or type) appear on the desktop. Headsets show up in the Sound
  panel through WirePlumber once connected.
- Calendar keeps events only on this computer, as a private desktop
  calendar does: a folder per calendar in `~/.local/share/din/calendar`,
  one iCalendar (.ics) file per event, with the calendar's name and colour
  in `displayname` and `color` beside them (`src/shared/localCalendar.ts`,
  `src/shared/ical.ts`), the vdir layout vdirsyncer can sync with a CalDAV
  server later. Day, week and month views, all-day and timed events, and
  calendars of the user's own (Personal to start). Beside them is the
  **Nostr calendar**, marked Public: the account's NIP-52 events
  (`src/shared/calendar.ts`) and invitations by npub with Going / Maybe /
  Not Going answers (View → Nostr Calendar hides it). An event goes to
  Nostr only when the user picks the Nostr calendar for it. The menu bar's clock opens it,
  and `din calendar` lists, adds, answers and deletes events, and manages
  the calendars.
- Contacts is the address book, kept only on this computer: one vCard per
  person in `~/.local/share/din/contacts` (`src/shared/contacts.ts`,
  `src/shared/vcard.ts`), the vdir layout vdirsyncer and khard use, with
  groups (the cards' CATEGORIES), pictures, birthdays and Apple's and
  Google's custom labels. It imports and exports .vcf files (Files opens
  them there; someone already in the book gets what the file adds rather
  than a second card), shows each phone's synced contacts beside it,
  read-only, to add from, and starts a text in Messages or an email in Mail.
  `din contacts` lists, shows, adds, edits and deletes people, and groups,
  imports and exports them.
- Messages reads and answers the texts on the user's phones, added in
  Settings → Phone (`electron/phone.mts`): iPhones and Android phones alike
  over Bluetooth's Message Access Profile, through BlueZ's obexd
  (`electron/phone-map.mts`), as Windows does for iPhones; no pictures or
  group conversations. New texts pop up as notifications with a reply field.
  Messages are kept only on this computer, sealed with the login keyring.
- A text with a verification code in it (`electron/phone-codes.mts` finds
  it) has the code offered in the Web Browser's code fields for 10 minutes,
  as a Mac offers the codes from Messages: the suggestions below the field
  (`autocomplete="one-time-code"`, a field named like one, or a row of
  one-digit boxes) list it "From Messages", and the one picked is typed in,
  spread across the boxes. A code arriving while the cursor is in the field
  brings them up. The code is kept in memory only, and goes only to the page
  it's picked for; its notification has a button to copy it. "Fill in
  verification codes" on the phone's page (`din phone fill-codes`) turns it
  off.
- A phone added there can share files to the computer over Bluetooth (the
  share sheet's Bluetooth target): `electron/phone-receive.mts` is obexd's
  agent, saving them to Downloads without asking, with one notification per
  share for its progress and then Open or Show in Files. Other devices are
  turned away; "Receive files" on the phone's page (`din phone
  receive-files`) turns it off.
- A phone added in Settings → Phone with "Receive files" on can share
  files, text and links with Quick Share (`electron/quickshare.mts`), with
  nothing to turn on: while it's connected over Bluetooth, Din listens for
  the beacon its share sheet sends, and sends the Bluetooth LE advertisement
  Android receivers send for 90 seconds after. No server is involved. The
  phone connects over Bluetooth (RFCOMM, through `electron/quickshare-bt.py`,
  since Node can't take the socket BlueZ hands over), on a link encrypted
  with the pairing's key, which proves which phone it is, so its share
  arrives without asking, in a notification. Anything else connecting that
  way is asked about in a notification, with the code.
- Bluetooth is slow, so a share over it moves to a WPA2 hotspot Din hosts on
  the Wi-Fi card alongside its own connection, on the same channel
  (`electron/quickshare-hotspot.mts`); Android phones leave their own Wi-Fi
  while the share sheet is open, so a hotspot is what both can reach. Adding
  its interface (`dinqs0`) needs root, so `os/din-hotspot.sh` does that
  through sudo, and NetworkManager runs the network from a profile it doesn't
  save, with a new name and password each time. A udev rule keeps the
  interface coming and going from restarting wpa_supplicant (NixOS's rule
  for any Wi-Fi interface), which would drop the computer's own connection.
  Without the helper (outside DinOS) the share stays on Bluetooth.
- On hardware, Din runs GPU-accelerated (Mesa via `hardware.graphics`, plus
  redistributable firmware). Only the QEMU demo variant passes
  `--disable-gpu` (no virgl) and falls back to software rendering.
- Din runs as the `din` user with Chromium's sandbox and
  context isolation enabled; the renderer has no Node access.
- The `app://` protocol handler in `main.mts` serves only files inside
  `dist/` (path-traversal guarded) and falls back to `index.html` for SPA
  routes.

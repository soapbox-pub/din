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

`npm run os:build` produces the real artifact: a raw UEFI disk image meant to
be installed on a physical machine. Write it to a drive and boot from it:

```sh
sudo dd if=result/nixos.img of=/dev/sdX bs=4M status=progress conv=fsync
```

The image is 14 GiB, to fit any 16 GB stick; any tool that writes images
(Etcher, Rufus, `dd`) will do.

Written to a USB stick instead, the same image is a live system: boot a laptop
from it and Din opens the **Install DinOS** app, which copies the running
system onto the computer's own disk — erasing it, or into its unpartitioned
space next to Windows (shrink Windows' partition in Disk Management first; the
firmware's boot menu then picks between them). The sign-in, saved Wi-Fi, and
files from the live session come along. The app only appears when DinOS is
running from removable media; the disk work is `os/din-install.sh`, run as
root through a sudo rule for that one program. Because the stick and the
installed disk are copies of each other, nothing is mounted by label: the
initrd finds root by GPT auto-discovery on the disk the boot loader ran from.

Every install has the same layout, with no choices offered: an ESP and one
system partition (optionally LUKS-encrypted) holding an LVM volume group,
`dinos`, with an ext4 `root` volume — a quarter of the space, between 48 and
128 GiB — and an ext4 `home` volume taking the rest. Disks under 100 GiB are
refused. Run on a disk that already has DinOS, the Installer offers to
**reinstall and keep your files**: it formats `root`, never mounts `home`, and
carries over saved Wi-Fi, Bluetooth pairings, the Nostr account keys, and the
machine's identity. The group is created with LVM autoactivation off; only the
initrd activates it, and only on the disk it booted from, so a DinOS disk
attached to another DinOS machine (or under a live stick) is left alone.

One password runs the computer. Encrypting the disk sets its passphrase as
`din`'s password too, and as the password of **nostrd**, the signer daemon that holds the Nostr account
keys as its own user so nothing `din` runs can read them. Din signs through
nostrd's socket, and the passphrase typed at boot unlocks it. It unlocks the
login keyring too, and any GPG key whose passphrase is the same, so signing
commits doesn't ask (`os/din-gpg.py`). Settings → Password changes it
everywhere at once (`os/din-password.py`, disk first).

`sudo` (Din's own helpers excepted) asks you to approve the command in Din,
with a click and no password: the agent's commands in the Assistant's
conversation, others from a notification, in a terminal too. Root asks from
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
`nostr://npub1q3sle…/git.shakespeare.diy/din`, which git fetches through
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
    (Din's compositor) + Electron launcher + Nix build of Din
    (`buildNpmPackage`)
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
  apps are paced by the shell's display refresh.
- **X11** — the compositor's rootless Xwayland, which it manages as the X
  window manager, so X11 apps take the same (GPU) path as Wayland ones and get
  hardware OpenGL. Where Xwayland isn't installed, or without the compositor,
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
the layout and changes it on DinOS and GNOME. DinOS keeps it in
`/var/lib/din/keyboard`, which Din's compositor reads when it starts (`os/din-keyboard.sh`
writes it as root), so Din's own windows switch after Din restarts.

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

DinOS ships Wine (`wineWow64Packages.stableFull`, which includes Wine Mono
and Gecko). Elsewhere Din uses the system's `wine`, or `$DIN_WINE`.

### AirPlay

The menu bar's AirPlay item (once a receiver is nearby) and Settings →
Display share the screen with Apple TVs, AirPlay TVs and Rokus. Like a
monitor plugged in, a receiver connects the way it was last used, extending
the desktop by default as a separate display arranged in Settings like any
other; while connected it can be switched to mirroring the primary display
and back, from the menu or with the display-switch key (F7 on ThinkPads), and
that is remembered (`airplay.json` in Din's config). Sound goes to the
receiver too. The
sending is [deckmon](https://git.shakespeare.diy)'s, a daemon DinOS runs as a
user service (the flake's `deckmon` input) and Din talks to over its socket
(`electron/airplay.mts`). It captures the screen through din-shell's wlroots screencopy, and a
separate display is a spare DisplayPort connector forced on with an EDID,
through a sudo rule for those writes. Elsewhere Din uses a `deckmon` on PATH.

### Printing

Printers need no setup on DinOS. CUPS runs with Avahi and ipp-usb, so a
printer on the network, or one plugged in that speaks IPP over USB, appears
in the print dialog as soon as it's on. The first time Din prints to one (or
makes it the default) it gives it a driverless queue of its own, so it's
still there after a restart. Din reads the printer list in the background
once it starts, so the print dialog doesn't wait on the network. Settings →
Printers shows them and their queues, sets the
default, prints a test page, and adds older USB printers with the best
driver installed (gutenprint, brlaser).

The print dialog is Din's own (`src/components/desktop/PrintDialog.tsx`):
Chromium's would open a GTK window, which DinOS's compositor wouldn't
show. `electron/print-preload.cjs` sends every page's `print()`, frames'
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
`$DIN_OPENCODE` names another binary.

### Dictation

Super+H types what you say into whatever has the keyboard: a text field, a
web page, the Terminal, or a native app (pasted, since the display only sends
keys). Holding Super+A opens the assistant's prompt listening, and the
prompt's mic button dictates into it. The shell records the microphone
(`src/lib/dictation.ts`) and whisper.cpp's server turns it into text on the
GPU (`electron/dictation.mts`), started on first use and stopped after a few
idle minutes. DinOS ships the server and Whisper large-v3-turbo (about
550 MB) and names them in `$DIN_WHISPER_SERVER` and `$DIN_WHISPER_MODEL`;
elsewhere, set both to dictate.

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

### Updating npm dependencies

The Nix build fetches npm deps from `package-lock.json` pinned by hash.
After changing dependencies, refresh the hash in `os/configuration.nix`:

```sh
nix run --inputs-from ./os nixpkgs#prefetch-npm-deps -- package-lock.json
# copy the sha256-... into npmDepsHash in os/configuration.nix
```

Also note: when built from a git checkout, the flake only sees **git-tracked**
files — `git add` new source files before `npm run os:build`.

## Notes

- The Web Browser app supports Chrome extensions (tabs, toolbar actions,
  content scripts) via
  [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell);
  install them by browsing the Chrome Web Store inside the browser, or drop
  unpacked extensions into the app's `Extensions/` data directory. Extensions
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
- On hardware, Din runs GPU-accelerated (Mesa via `hardware.graphics`, plus
  redistributable firmware). Only the QEMU demo variant passes
  `--disable-gpu` (no virgl) and falls back to software rendering.
- Din runs as the `din` user with Chromium's sandbox and
  context isolation enabled; the renderer has no Node access.
- The `app://` protocol handler in `main.mts` serves only files inside
  `dist/` (path-traversal guarded) and falls back to `index.html` for SPA
  routes.

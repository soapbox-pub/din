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
Linux kernel -> systemd -> cage (Wayland kiosk compositor) -> Electron -> Din
```

## Requirements

- Node.js (dev servers and builds)
- Xvfb, for running native Linux apps inside Din; optionally Rust (cargo), to
  build the Wayland compositor that hosts the apps able to use it (and draws
  them on the GPU), plus Xwayland, to put X11 apps there too. The compositor
  links against pixman, gbm, and xkbcommon, so it needs their development
  packages:
  - Fedora: `sudo dnf install xorg-x11-server-Xvfb xorg-x11-server-Xwayland pixman-devel mesa-libgbm-devel libxkbcommon-devel`
  - Debian/Ubuntu: `sudo apt install xvfb xwayland libpixman-1-dev libgbm-dev libxkbcommon-dev`
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
`din`'s password too, which `sudo` asks for (Din's own helpers excepted), and
as the password of **nostrd**, the signer daemon that holds the Nostr account
keys as its own user so nothing `din` runs can read them. Din signs through
nostrd's socket, and the passphrase typed at boot unlocks it. It unlocks the
login keyring too, and any GPG key whose passphrase is the same, so signing
commits doesn't ask (`os/din-gpg.py`). Without encryption there's no password,
and `sudo` doesn't ask. Settings → Password changes it everywhere at once
(`os/din-password.py`, disk first).
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

Installed systems update themselves. A DinOS release is a NIP-82 release of
the application `din` (`.ngit/release.yaml`), signed by the soapbox.pub key,
with two files on Blossom: the compressed disk image, for new installs, and an
update bundle. The bundle holds the new system's store path, the list of its
store paths cache.nixos.org already has, and a `nix-store --export` of the
rest (Din itself and the generated configuration, a few tens of MB). Din looks
for a newer release a minute after starting and every six hours. The check is
`os/din-update.sh`, run as root like the Installer's helper. It verifies the
release's signature and author, downloads the bundle and checks it against the
asset's sha256, fetches the rest from cache.nixos.org, and stages the new
system with `switch-to-configuration boot`. Settings → About shows its
progress and offers the restart. Older systems stay in the boot menu. Live
sticks aren't updated.

To cut a release, bump `os/version`, commit, tag `v<version>`, and run
`npm run os:release -- -- --nbunksec-file <file>` (or pass any other
`ngit release publish` signer option after the second `--`). It builds from a
clean worktree of the tag. `npm run os:release -- --stage-only` builds the two
files into `.release-artifacts/` without publishing anything.

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
- `electron/main.mts` — the Electron host; serves `dist/` over a custom
  `app://` protocol (real origin, SPA fallback for BrowserRouter)
- `electron/preload.cjs`, `electron/pty-host.py` — the fs/pty/wifi bridges
  behind Din's Files, Terminal, and Settings apps
- `electron/native-*.mts`, `electron/wayland-bridge.mts`, `native/` — the
  embedded display that runs native Linux apps inside Din windows (see
  "Native Linux apps" below)
- `os/` — DinOS, the flagship OS:
  - `os/flake.nix` — entry point; exposes the installable disk image as
    `./os#image` (the default) and the QEMU demo as `./os#vm`, and pulls in
    the Din source tree (the repo root) as an input
  - `os/configuration.nix` — the whole OS definition: cage + Electron
    launcher + Nix build of Din (`buildNpmPackage`)
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
  copy - apps get linux-dmabuf and render on the GPU too. Without one, pixels
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
`/var/lib/din/keyboard`, which cage reads when it starts (`os/din-keyboard.sh`
writes it as root), so Din's own windows switch after Din restarts.

Settings → Date & Time shows the system's time zone and clock, read from
systemd-timedated (`electron/datetime.mts`), and on DinOS changes them
through `os/din-time.sh`, which runs timedatectl as root. Chromium follows
`/etc/localtime`, so the new zone takes effect without a restart. The clock's
12/24-hour format, and whether the menu bar shows the date and seconds, are
Din's own settings; the boot and lock screens follow the format too.

Build both crates with `npm run build:native`. Without the compositor, every
app runs on Xvfb; without din-fd, the compositor stays on the CPU path.
`DIN_NATIVE_DISPLAY=x11` forces X and `DIN_COMPOSITOR_GPU=0` the CPU path,
for comparisons, and `DIN_COMPOSITOR_STATS=1` logs the compositor's frame
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
(`electron/airplay.mts`). It captures cage through wlroots screencopy, and a
separate display is a spare DisplayPort connector forced on with an EDID,
through a sudo rule for those writes. Elsewhere Din uses a `deckmon` on PATH.

### Printing

Printers need no setup on DinOS. CUPS runs with Avahi and ipp-usb, so a
printer on the network, or one plugged in that speaks IPP over USB, appears
in the print dialog as soon as it's on, and printing makes its driverless
queue on the spot. Settings → Printers shows them and their queues, sets the
default, prints a test page, and adds older USB printers with the best
driver installed (gutenprint, brlaser).

The print dialog is Din's own (`src/components/desktop/PrintDialog.tsx`):
Chromium's would open a GTK window, which under cage replaces the whole
screen. `electron/print-preload.cjs` sends every page's `print()`, frames'
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
  Electron IPC bridge). NetworkManager picks up physical adapters (wired and
  wireless) automatically. Note that QEMU has no wireless hardware, so the
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

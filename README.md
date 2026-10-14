# Din

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

**Aladdin** is the flagship OS of Din: a minimal NixOS system that boots
straight into Din fullscreen. No X11, no display manager, no traditional
desktop — just:

```
Linux kernel -> systemd -> cage (Wayland kiosk compositor) -> Electron -> Din
```

## Requirements

- Node.js (dev servers and builds)
- Xvfb, for running native Linux apps inside Din; optionally Rust (cargo), to
  build the Wayland compositor that hosts the apps able to use it
- Nix (with flakes enabled; the Determinate installer does this by default) —
  only needed for the Aladdin `os:*` commands
- QEMU (`qemu-system-x86_64`) on the host for the `npm run os:run` demo

## Usage

```sh
npm run dev         # run Din in Electron with live HMR (windowed + DevTools)
npm run dev:browser # run Din in a plain browser with HMR (http://localhost:8080)
npm test            # type-check + lint + tests + build
npm run build       # build the web app into dist/
npm run build:compositor # build the Wayland compositor for native apps (cargo)
npm run os:build    # build the installable Aladdin disk image (./result/nixos.img)
npm run os:run      # demo Aladdin in a QEMU window
npm run os:clean    # remove the build output and the demo VM disk (aladdin.qcow2)
```

`npm run dev` starts Vite, then launches the same `electron/main.mts` Aladdin
uses (Electron comes from devDependencies, pinned to the version the OS image
ships) against the dev server via `DIN_DEV_URL`. This gives you the real
Electron/`app://` environment with Vite HMR + React fast refresh. Ctrl-C stops
both processes.

`npm run os:build` produces the real artifact: a raw UEFI disk image meant to
be installed on a physical machine. Write it to a drive and boot from it:

```sh
sudo dd if=result/nixos.img of=/dev/sdX bs=4M status=progress conv=fsync
```

On first boot the root partition grows to fill the disk. `npm run os:run` is
for demoing: it boots the same system in a QEMU window (software rendering,
since QEMU provides no GPU), with boot logs mirrored to the serial console
(your terminal).

## Layout

- `src/` — the Din desktop environment (React, Tailwind, shadcn/ui)
- `electron/main.mts` — the Electron host; serves `dist/` over a custom
  `app://` protocol (real origin, SPA fallback for BrowserRouter)
- `electron/preload.cjs`, `electron/pty-host.py` — the fs/pty/wifi bridges
  behind Din's Files, Terminal, and Settings apps
- `electron/native-*.mts`, `electron/wayland-bridge.mts`,
  `native/din-compositor/` — the embedded display that runs native Linux apps
  inside Din windows (see "Native Linux apps" below)
- `os/` — Aladdin, the flagship OS:
  - `os/flake.nix` — entry point; exposes the installable disk image as
    `./os#image` (the default) and the QEMU demo as `./os#vm`, and pulls in
    the Din source tree (the repo root) as an input
  - `os/configuration.nix` — the whole OS definition: cage + Electron
    launcher + Nix build of Din (`buildNpmPackage`)

## Dev loop

Three tiers, fastest first:

1. **Browser + HMR** (`npm run dev:browser`): Din is an ordinary Vite app;
   edit `src/` and see changes instantly at http://localhost:8080.
2. **Electron windowed + HMR** (`npm run dev`): runs Din inside the actual
   Electron host (`app://` protocol, CSP, download handling) pointed at the
   Vite dev server, so it matches Aladdin while staying hot-reloadable. Under
   the hood this just sets `DIN_DEV_URL=http://localhost:8080` for
   `electron/main.mts`.
3. **Full OS demo** (`npm run os:run`): rebuilds Aladdin and boots it in
   QEMU; only changed layers rebuild. The demo VM disk (`aladdin.qcow2`)
   persists between boots; `npm run os:clean` resets it.

### Native Linux apps

Installed desktop apps launch onto Din's embedded display, a pair of private
servers whose windows Din composites into its own:

- **Wayland** — `native/din-compositor`, a headless Smithay compositor (Rust).
  Apps that speak Wayland (GTK, Qt, Firefox, Electron, SDL) use it. Pixels
  stream straight to the shell renderer over a token-guarded localhost
  WebSocket, and apps are paced by Din's frame acks.
- **X11** — a private Xvfb, managed and composited by
  `electron/native-display-worker.mts`, for apps that only speak X.

Build the compositor with `npm run build:compositor`. Without it, every app
runs on X; `DIN_NATIVE_DISPLAY=x11` forces that for comparisons, and
`DIN_COMPOSITOR_STATS=1` makes the compositor log its frame throughput.

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
- The Settings app manages WiFi through NetworkManager (`nmcli` behind an
  Electron IPC bridge). NetworkManager picks up physical adapters (wired and
  wireless) automatically. Note that QEMU has no wireless hardware, so the
  WiFi panel will show no networks inside the demo VM.
- On hardware, Din runs GPU-accelerated (Mesa via `hardware.graphics`, plus
  redistributable firmware). Only the QEMU demo variant passes
  `--disable-gpu` (no virgl) and falls back to software rendering.
- Din runs as the unprivileged `web` user with Chromium's sandbox and
  context isolation enabled; the renderer has no Node access.
- The `app://` protocol handler in `main.mts` serves only files inside
  `dist/` (path-traversal guarded) and falls back to `index.html` for SPA
  routes.

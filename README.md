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
- Nix (with flakes enabled; the Determinate installer does this by default) —
  only needed for `npm run dev` (Electron via Nix) and the Aladdin `os:*`
  commands
- QEMU (`qemu-system-x86_64`) on the host for `npm run os:run`

## Usage

```sh
npm run dev         # run Din in Electron with live HMR (windowed + DevTools)
npm run dev:browser # run Din in a plain browser with HMR (http://localhost:8080)
npm test            # type-check + lint + tests + build
npm run build       # build the web app into dist/
npm run os:build    # build the Aladdin VM (./result/bin/run-aladdin-vm)
npm run os:run      # build the Aladdin VM and boot it in a QEMU window
npm run os:clean    # remove the VM build output and disk (aladdin.qcow2)
```

`npm run dev` starts Vite, then launches the same `electron/main.cjs` Aladdin
uses (pulled from the OS flake's pinned nixpkgs) against the dev server via
`DIN_DEV_URL`. This gives you the real Electron/`app://` environment with Vite
HMR + React fast refresh. Ctrl-C stops both processes.

The QEMU window boots Aladdin into Din fullscreen. Boot logs also appear on
the serial console (your terminal).

## Layout

- `src/` — the Din desktop environment (React, Tailwind, shadcn/ui)
- `electron/main.cjs` — the Electron host; serves `dist/` over a custom
  `app://` protocol (real origin, SPA fallback for BrowserRouter)
- `electron/preload.cjs`, `electron/pty-host.py` — the fs/pty/wifi bridges
  behind Din's Files, Terminal, and Settings apps
- `os/` — Aladdin, the flagship OS:
  - `os/flake.nix` — entry point; exposes the VM as `./os#vm` and pulls in
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
   `electron/main.cjs`.
3. **Full VM** (`npm run os:run`): rebuilds the Aladdin image; only changed
   layers rebuild. The VM disk (`aladdin.qcow2`) persists between boots;
   `npm run os:clean` resets it.

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

- The Settings app manages WiFi through NetworkManager (`nmcli` behind an
  Electron IPC bridge). NetworkManager picks up physical adapters (wired and
  wireless) automatically. Note that QEMU has no wireless hardware, so the
  WiFi panel will show no networks inside the VM.
- Electron runs with `--disable-gpu` for reliability in QEMU without virgl.
  On real hardware, remove it in `os/configuration.nix` and verify GPU
  acceleration.
- Din runs as the unprivileged `web` user with Chromium's sandbox and
  context isolation enabled; the renderer has no Node access.
- The `app://` protocol handler in `main.cjs` serves only files inside
  `dist/` (path-traversal guarded) and falls back to `index.html` for SPA
  routes.

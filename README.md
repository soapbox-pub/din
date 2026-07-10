# webos-demo

A minimal NixOS system that boots straight into a fullscreen Electron app.
No X11, no display manager, no desktop environment - just:

```
Linux kernel -> systemd -> cage (Wayland kiosk compositor) -> Electron -> web shell
```

The shell is a Vite + React 19 + TailwindCSS 4 + shadcn/ui app based on the
[MKStack](https://soapbox.pub/mkstack) template, so it can also run as a plain
web app in any browser.

## Requirements

- Nix (with flakes enabled; the Determinate installer does this by default)
- QEMU (`qemu-system-x86_64`) on the host for `make run`
- Node.js for `make dev`

## Usage

```sh
make run    # build the OS + VM and boot it in a QEMU window
make dev    # run the web shell locally with HMR (http://localhost:8080)
make test   # shell type-check + lint + tests + build
make build  # just build the VM (./result/bin/run-webos-vm)
make clean  # remove build output and the VM disk (webos.qcow2)
```

The QEMU window shows the shell fullscreen with a live clock. Boot logs also
appear on the serial console (your terminal).

## Layout

- `flake.nix` - entry point; exposes the VM as `.#vm`
- `os/configuration.nix` - the whole OS definition: cage + Electron launcher +
  Nix build of the shell (`buildNpmPackage`)
- `shell/` - the web shell (MKStack template: Vite, React, Tailwind, shadcn/ui)
- `shell/electron/main.cjs` - the Electron host; serves `dist/` over a custom
  `app://` protocol (real origin, SPA fallback for BrowserRouter)

## Dev loop

Three tiers, fastest first:

1. **Browser + HMR** (`make dev`): the shell is an ordinary Vite app; edit
   `shell/src/` and see changes instantly at http://localhost:8080.
2. **Electron windowed** (optional): point any local Electron at the dev
   server: `SHELL_DEV_URL=http://localhost:8080 electron shell/electron/main.cjs`
3. **Full VM** (`make run`): rebuilds the OS image; only changed layers
   rebuild. The VM disk (`webos.qcow2`) persists between boots; `make clean`
   resets it.

### Updating npm dependencies

The Nix build fetches npm deps from `shell/package-lock.json` pinned by hash.
After changing dependencies, refresh the hash in `os/configuration.nix`:

```sh
nix run nixpkgs#prefetch-npm-deps -- shell/package-lock.json
# copy the sha256-... into npmDepsHash in os/configuration.nix
```

Also note: the flake only sees **git-tracked** files - `git add` new shell
files before `make build`.

## Notes

- Electron runs with `--disable-gpu` for reliability in QEMU without virgl.
  On real hardware, remove it in `os/configuration.nix` and verify GPU
  acceleration.
- The shell runs as the unprivileged `web` user with Chromium's sandbox and
  context isolation enabled; the renderer has no Node access.
- The `app://` protocol handler in `main.cjs` serves only files inside
  `dist/` (path-traversal guarded) and falls back to `index.html` for SPA
  routes.

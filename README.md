# webos-demo

A minimal NixOS system that boots straight into a fullscreen Electron app.
No X11, no display manager, no desktop environment - just:

```
Linux kernel -> systemd -> cage (Wayland kiosk compositor) -> Electron -> your web UI
```

## Requirements

- Nix (with flakes enabled; the Determinate installer does this by default)
- QEMU (`qemu-system-x86_64`) on the host for `make run`

## Usage

```sh
make run    # build the VM and boot it in a QEMU window
make build  # just build (./result/bin/run-webos-vm)
make clean  # remove build output and the VM disk (webos.qcow2)
```

The QEMU window should show the Electron hello-world shell fullscreen,
with a live clock. Boot logs also appear on the serial console (your
terminal).

## Layout

- `flake.nix` - entry point; exposes the VM as `.#vm`
- `os/configuration.nix` - the whole OS definition (cage + Electron launcher)
- `shell/` - the Electron app (`main.js`, `index.html`). This grows into the
  desktop shell.

## Dev loop

- UI-only changes: edit `shell/`, then `make run` (rebuild is seconds; only
  the changed app layer rebuilds).
- The VM's disk (`webos.qcow2`) persists between boots; `make clean` resets it.
- Extra QEMU flags can be passed via `QEMU_OPTS`, e.g.
  `QEMU_OPTS="-display none -vnc :9" ./result/bin/run-webos-vm`

## Notes

- Electron runs with `--disable-gpu` for reliability in QEMU without virgl.
  On real hardware, remove it in `os/configuration.nix` and verify GPU
  acceleration.
- The shell runs as the unprivileged `web` user with Chromium's sandbox and
  context isolation enabled.

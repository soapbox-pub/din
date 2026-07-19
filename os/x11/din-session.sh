#!/usr/bin/env bash
# Din as a standalone login session on an existing Linux install, no
# NixOS/Aladdin required.
#
# This runs the *production* Electron shell (fullscreen kiosk) against a
# pre-built dist/. It is the hand-rolled equivalent of what Aladdin's cage
# service does: start exactly one fullscreen app - Din - and nothing else.
# Din does all window management itself inside that single window, so no
# external window manager is needed. Works under an X11 or Wayland session;
# unlike Aladdin, the rest of your OS (audio, GPU drivers, Bluetooth, logind,
# printing) is still there underneath.
#
# Prerequisites:
#   - `npm run build` has been run at least once (produces dist/).
#   - Electron present (node_modules/.bin/electron, from `npm install`).
#   - python3 on PATH (Terminal app's pty host) and nmcli (Settings Wifi).
#     Both are standard on Fedora and most distros.
#
# Install as a login session (keeps your existing desktop as a fallback -
# don't uninstall it while you dogfood):
#   sudo ln -s "$PWD/os/x11/din-session.sh" /usr/local/bin/din-session
#   sudo cp os/x11/din.desktop /usr/share/xsessions/din.desktop        # X11
#   # or /usr/share/wayland-sessions/din.desktop for a Wayland session
# then pick "Din" at your display manager's login screen.
#
# Or without a display manager, from a TTY:
#   echo 'exec /usr/local/bin/din-session' > ~/.xinitrc && startx
#
# If Din ever wedges with no WM to kill it, switch to a VT (Ctrl+Alt+F3) and
# `pkill electron`; the respawn logic below brings it back or hands control
# to the login manager.
#
# Env:
#   DIN_ROOT     Override the repo root (default: inferred from this script).
#   DIN_NO_GPU=1 Force software rendering (broken drivers / headless X).
#   DIN_OZONE    Force Electron's ozone platform (e.g. wayland, x11).
set -euo pipefail

# Resolve the repo root from this script's real location (works via symlink).
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT_DIR="${DIN_ROOT:-$(cd "$(dirname "${SELF}")/../.." && pwd)}"

# The Terminal pty host (python3) and Wifi bridge (nmcli) must be reachable
# even under a display manager's minimal session PATH.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ELECTRON="${ROOT_DIR}/node_modules/.bin/electron"
MAIN="${ROOT_DIR}/electron/main.cjs"

# main.cjs serves the built app over app://; point it at this checkout's build
# explicitly. (It also falls back to __dirname/../dist, but being explicit
# means the standalone session never depends on that guess.)
export DIN_DIST_DIR="${ROOT_DIR}/dist"

if [ ! -x "${ELECTRON}" ]; then
  echo "din-session: Electron not found at ${ELECTRON}. Run 'npm install'." >&2
  exit 1
fi
if [ ! -f "${ROOT_DIR}/dist/index.html" ]; then
  echo "din-session: no build at ${ROOT_DIR}/dist. Run 'npm run build'." >&2
  exit 1
fi

# GPU acceleration is on by default (compositing dragging/blur/shadows is far
# snappier than SwiftShader). --enable-unsafe-swiftshader stays in both modes
# so the Terminal's WebGL box-drawing glyphs still render if Chromium falls
# back to software. On real hardware there is no --disable-gpu (that was only
# an Aladdin/QEMU workaround); set DIN_NO_GPU=1 to force it back.
FLAGS=(--enable-unsafe-swiftshader)
[ "${DIN_NO_GPU:-0}" = "1" ] && FLAGS=(--disable-gpu --enable-unsafe-swiftshader)
[ -n "${DIN_OZONE:-}" ] && FLAGS+=(--ozone-platform="${DIN_OZONE}")

# No DIN_DEV_URL -> main.cjs opens the fullscreen kiosk window (see
# electron/main.cjs: `fullscreen/kiosk: !DEV_URL`).
#
# Respawn on a crash so a wedged renderer drops back to a fresh Din rather
# than a black screen - but bail out to the login manager if it crash-loops
# (dies in under 3s, five times running), so a persistently broken build
# doesn't trap the session.
fails=0
while true; do
  start=$(date +%s)
  if "${ELECTRON}" "${MAIN}" "${FLAGS[@]}"; then
    break # clean exit: the user quit Din -> end the session
  fi
  if [ $(( $(date +%s) - start )) -lt 3 ]; then
    fails=$((fails + 1))
    if [ "${fails}" -ge 5 ]; then
      echo "din-session: Din is crash-looping, exiting to the login manager." >&2
      exit 1
    fi
  else
    fails=0
  fi
done

#!/usr/bin/env bash
# Din as a standalone login session on an existing Linux install, no
# NixOS/DinOS required.
#
# This runs the *production* Electron shell (fullscreen kiosk) against a
# pre-built dist/. It is the hand-rolled equivalent of what DinOS's cage
# service does: start exactly one fullscreen app - Din - and nothing else.
# Din does all window management itself inside that single window, so no
# external window manager is needed. Works under an X11 or Wayland session;
# unlike DinOS, the rest of your OS (audio, GPU drivers, Bluetooth, logind,
# printing) is still there underneath.
#
# Prerequisites:
#   - `npm run build` has been run at least once (produces dist/ and the
#     compiled electron/*.mjs).
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
# The compiled host (npm run build -> scripts/build-electron.mjs), not the
# .mts sources: those load Node's TypeScript stripper into every process.
MAIN="${ROOT_DIR}/electron/main.mjs"

# main.mts serves the built app over app://; point it at this checkout's build
# explicitly. (It also falls back to __dirname/../dist, but being explicit
# means the standalone session never depends on that guess.)
export DIN_DIST_DIR="${ROOT_DIR}/dist"

if [ ! -x "${ELECTRON}" ]; then
  echo "din-session: Electron not found at ${ELECTRON}. Run 'npm install'." >&2
  exit 1
fi
if [ ! -f "${ROOT_DIR}/dist/index.html" ] || [ ! -f "${MAIN}" ]; then
  echo "din-session: no build at ${ROOT_DIR}/dist. Run 'npm run build'." >&2
  exit 1
fi

# GPU acceleration is on by default (compositing dragging/blur/shadows is far
# snappier than SwiftShader). --enable-unsafe-swiftshader stays in both modes
# so the Terminal's WebGL box-drawing glyphs still render if Chromium falls
# back to software. On real hardware there is no --disable-gpu (that was only
# a DinOS/QEMU workaround); set DIN_NO_GPU=1 to force it back.
FLAGS=(--enable-unsafe-swiftshader)
[ "${DIN_NO_GPU:-0}" = "1" ] && FLAGS=(--disable-gpu --enable-unsafe-swiftshader)
[ -n "${DIN_OZONE:-}" ] && FLAGS+=(--ozone-platform="${DIN_OZONE}")

# Natural ("reverse") scrolling on touchpads. On a bare login session there is
# no GNOME/settings daemon to apply input preferences, so libinput sits at its
# default - traditional scrolling - and a trackpad feels backwards to anyone
# used to natural scroll. Din owns the whole session (same reason it drives
# xrandr and the lid switch itself), so set it here. Touchpads only, so an
# external mouse keeps traditional wheel scrolling; a touchpad is the pointer
# subset that exposes "libinput Tapping Enabled" (mice don't tap). X11 only -
# xinput talks to the X server; under Wayland the compositor owns scrolling and
# this is skipped. Entirely best effort: a missing xinput or a device that
# drops out is ignored so input setup can never wedge login. Set DIN_NATURAL_
# SCROLL=0 to opt out and keep the libinput default.
enable_natural_scroll() {
  [ "${DIN_NATURAL_SCROLL:-1}" = "1" ] || return 0
  [ "${XDG_SESSION_TYPE:-x11}" = "x11" ] || return 0
  command -v xinput >/dev/null 2>&1 || return 0
  xinput list --name-only 2>/dev/null | while IFS= read -r dev; do
    props="$(xinput list-props "${dev}" 2>/dev/null)" || continue
    case "${props}" in
      *"libinput Tapping Enabled"*)
        xinput set-prop "${dev}" "libinput Natural Scrolling Enabled" 1 \
          2>/dev/null || true
        ;;
    esac
  done
}
enable_natural_scroll || true

# No DIN_DEV_URL -> main.mts opens the fullscreen kiosk window (see
# electron/main.mts: `fullscreen/kiosk: !DEV_URL`).
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

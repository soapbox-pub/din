#!/usr/bin/env bash
# Launch Din in Electron with live HMR.
#
# Starts the Vite dev server, waits for it to come up, then launches Electron
# pointed at it via DIN_DEV_URL. Electron loads the same main.mts used in the
# VM, so app:// routing / CSP behaviour matches production while React fast
# refresh + Vite HMR stay live. Ctrl-C tears down both processes.
#
# Electron comes from devDependencies (pinned to the same version the DinOS
# OS image ships), so no Nix setup is required. Nix is only needed for the
# os:* scripts that build the VM.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="localhost"
PORT="${PORT:-8080}"
URL="http://${HOST}:${PORT}"

cd "${ROOT_DIR}"

# Make sure dependencies (including Electron) are present.
npm install --silent

# The ad blocker's filter engine bundle (electron/adblock.mts).
node scripts/build-adblock-engine.mjs

ELECTRON="${ROOT_DIR}/node_modules/.bin/electron"
if [ ! -x "${ELECTRON}" ]; then
  echo "Electron binary not found at ${ELECTRON}." >&2
  echo "Try: npm install" >&2
  exit 1
fi

# Start Vite in the background.
npm exec -- vite --host "${HOST}" --port "${PORT}" --strictPort &
VITE_PID=$!

cleanup() {
  trap - INT TERM EXIT
  [ -n "${ELECTRON_PID:-}" ] && kill "${ELECTRON_PID}" 2>/dev/null || true
  kill "${VITE_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Wait for the dev server to accept connections (max ~30s).
echo "Waiting for Vite dev server at ${URL} ..."
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${URL}"; then break; fi
  # Bail out early if Vite died.
  if ! kill -0 "${VITE_PID}" 2>/dev/null; then
    echo "Vite exited before becoming ready." >&2
    exit 1
  fi
  sleep 0.5
done

echo "Launching Electron -> ${URL}"
# GPU acceleration is ON by default: window dragging, backdrop blur, and
# shadows feel dramatically snappier composited on the GPU than in SwiftShader.
# Set DIN_NO_GPU=1 to force software rendering (e.g. headless X, broken
# drivers). If GPU init fails anyway, Chromium logs some ANGLE/EGL noise and
# falls back to software on its own - the app still works.
# --enable-unsafe-swiftshader stays in both modes: whenever the GPU is absent
# or fails to init, Chromium >=137 refuses to create even software WebGL
# contexts without it, and the Terminal app needs WebGL for crisp box-drawing
# glyphs ("unsafe" = SwiftShader is not security-maintained against untrusted
# WebGL content; acceptable here).
GPU_FLAGS=(--enable-unsafe-swiftshader)
if [ "${DIN_NO_GPU:-0}" = "1" ]; then
  GPU_FLAGS=(--disable-gpu --enable-unsafe-swiftshader)
fi

DIN_DEV_URL="${URL}" "${ELECTRON}" "${ROOT_DIR}/electron/main.mts" \
  "${GPU_FLAGS[@]}" &
ELECTRON_PID=$!

# Exit when either process exits.
wait -n "${VITE_PID}" "${ELECTRON_PID}"

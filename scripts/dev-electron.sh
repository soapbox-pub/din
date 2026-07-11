#!/usr/bin/env bash
# Launch Din in Electron with live HMR.
#
# Starts the Vite dev server, waits for it to come up, then launches Electron
# pointed at it via DIN_DEV_URL. Electron loads the same main.cjs used in the
# VM, so app:// routing / CSP behaviour matches production while React fast
# refresh + Vite HMR stay live. Ctrl-C tears down both processes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="localhost"
PORT="${PORT:-8080}"
URL="http://${HOST}:${PORT}"

# Resolve Electron from the OS flake's pinned nixpkgs (same version Aladdin
# uses, already in the Nix store).
NIX="$(command -v nix || echo /nix/var/nix/profiles/default/bin/nix)"
ELECTRON_DIR="$("${NIX}" build --no-link --print-out-paths \
  --inputs-from "${ROOT_DIR}/os" 'nixpkgs#electron')"
ELECTRON="${ELECTRON_DIR}/bin/electron"

cd "${ROOT_DIR}"

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

# Nix-built Electron can't find host GL drivers on non-NixOS distros (it looks
# in /run/opengl-driver, a NixOS convention), so GPU init fails and everything
# renders in software. nixGL bridges that gap by pointing the loader at a
# Nix-built Mesa. Built with the same nixpkgs pin as Electron so the versions
# stay in lockstep. nixGLIntel is the Mesa wrapper and covers Intel + AMD;
# NVIDIA proprietary-driver users need nixGL#nixGLNvidia (requires --impure)
# or DIN_NO_GPU=1.
GL_WRAPPER=()
if [ "${DIN_NO_GPU:-0}" != "1" ] && [ ! -e /run/opengl-driver ]; then
  echo "Non-NixOS host detected; resolving nixGL for GPU acceleration ..."
  if NIXGL_DIR="$("${NIX}" build --no-link --print-out-paths \
    --inputs-from "${ROOT_DIR}/os" --override-input nixpkgs nixpkgs \
    'github:nix-community/nixGL#nixGLIntel' 2>/dev/null)"; then
    GL_WRAPPER=("${NIXGL_DIR}/bin/nixGLIntel")
  else
    echo "nixGL unavailable; continuing without it (software rendering likely)." >&2
  fi
fi

DIN_DEV_URL="${URL}" "${GL_WRAPPER[@]}" "${ELECTRON}" "${ROOT_DIR}/electron/main.cjs" \
  "${GPU_FLAGS[@]}" &
ELECTRON_PID=$!

# Exit when either process exits.
wait -n "${VITE_PID}" "${ELECTRON_PID}"

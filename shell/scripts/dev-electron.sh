#!/usr/bin/env bash
# Launch the shell in Electron with live HMR.
#
# Starts the Vite dev server, waits for it to come up, then launches Electron
# pointed at it via SHELL_DEV_URL. Electron loads the same main.cjs used in the
# VM, so app:// routing / CSP behaviour matches production while React fast
# refresh + Vite HMR stay live. Ctrl-C tears down both processes.
set -euo pipefail

SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="localhost"
PORT="${PORT:-8080}"
URL="http://${HOST}:${PORT}"

# Resolve Electron from the flake's pinned nixpkgs (same version the VM uses,
# already in the Nix store). Falls back to `nix run` if a build path is unset.
NIX="$(command -v nix || echo /nix/var/nix/profiles/default/bin/nix)"
REPO_ROOT="$(cd "${SHELL_DIR}/.." && pwd)"
ELECTRON_DIR="$("${NIX}" build --no-link --print-out-paths \
  --inputs-from "${REPO_ROOT}" 'nixpkgs#electron')"
ELECTRON="${ELECTRON_DIR}/bin/electron"

cd "${SHELL_DIR}"

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
# --disable-gpu: many dev machines (and headless X/QEMU) lack GL accel, which
# otherwise floods the console with ANGLE/EGL errors. Drop it if you want to
# exercise GPU paths locally.
# --enable-unsafe-swiftshader: with the GPU disabled, Chromium >=137 refuses
# to create even software WebGL contexts without this flag. The Terminal app
# needs WebGL for crisp box-drawing glyphs ("unsafe" = SwiftShader is not
# security-maintained against untrusted WebGL content; acceptable here).
SHELL_DEV_URL="${URL}" "${ELECTRON}" "${SHELL_DIR}/electron/main.cjs" \
  --disable-gpu --enable-unsafe-swiftshader &
ELECTRON_PID=$!

# Exit when either process exits.
wait -n "${VITE_PID}" "${ELECTRON_PID}"

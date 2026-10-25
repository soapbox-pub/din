#!/bin/sh
# Builds electron/indd.wasm, Publisher's reader for InDesign documents:
# indd-utils (MIT OR Apache-2.0) behind the plain interface in
# native/indd-wasm. The result is committed, so neither `npm run build` nor
# the DinOS build needs a Rust WebAssembly toolchain; run this after
# changing native/indd-wasm (e.g. moving to a newer indd-utils).
#
# Needs: rustup target add wasm32-unknown-unknown
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cargo build --release --target wasm32-unknown-unknown --manifest-path "$root/native/indd-wasm/Cargo.toml"
cp "$root/native/indd-wasm/target/wasm32-unknown-unknown/release/indd_wasm.wasm" "$root/electron/indd.wasm"
echo "electron/indd.wasm: $(wc -c < "$root/electron/indd.wasm") bytes"

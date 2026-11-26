#!/usr/bin/env bash
#
# Din's binary cache: build what DinOS's optional features need that
# nixpkgs' cache doesn't have (configuration.nix's
# system.build.din-cache-parts: reims-vgpu's QEMU), sign it with Din's
# cache key, add it to the cache's folder, and publish the folder as Team
# Soapbox's `din-cache` nsite, which DinOS has Nix substitute from
# (dinCache in configuration.nix).
#
#   scripts/din-cache-push.sh [<commit or ref, default main>]
#
# The folder is a Nix binary cache (nix-cache-info, <hash>.narinfo and
# nar/<hash>.nar.xz, served at
# https://2zrgjemvgxppn2jwgm61w6yrqqlcmm8njvhby68a9cj7ooo5phdin-cache.nsite.lol),
# kept between runs so older systems' parts stay in it;
# a part already there isn't copied again, and ngit uploads only new files.
# Run it whenever a part changes (reims-vgpu.nix, or the nixpkgs it's built
# with), before a release that has it: scripts/dinos-release.sh checks that
# every feature part can be downloaded.
#
# DIN_CACHE_DIR: the folder (default ~/.local/share/din/nix-cache).
# DIN_CACHE_KEY: the signing key (default ~/.config/din/nix-cache.sec).
# DIN_CACHE_SIGNER: who publishes the nsite (default Team Soapbox).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF=${1:-main}
DIR=${DIN_CACHE_DIR:-$HOME/.local/share/din/nix-cache}
KEY=${DIN_CACHE_KEY:-$HOME/.config/din/nix-cache.sec}
SIGNER=${DIN_CACHE_SIGNER:-npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj}
[[ -r $KEY ]] || { echo "No signing key at $KEY (DIN_CACHE_KEY)" >&2; exit 1; }

# Built from a commit, never the working tree, so what's pushed is what
# that commit's systems name.
flake="git+file://$ROOT?ref=$REF&dir=os"
[[ $REF =~ ^[0-9a-f]{7,40}$ ]] && flake="git+file://$ROOT?rev=$(git -C "$ROOT" rev-parse "$REF")&dir=os"
attr="nixosConfigurations.dinos.config.system.build.din-cache-parts"
mapfile -t names < <(nix eval --json "$flake#$attr" --apply builtins.attrNames | jq -r '.[]')

# Nix reads /nix-cache-info, and an nsite's every file needs an extension
# (NIP-5A), so it's /nix-cache-info/index.html, which gateways serve for a
# path with no filename.
mkdir -p "$DIR/nix-cache-info"
cat >"$DIR/nix-cache-info/index.html" <<EOF
StoreDir: /nix/store
WantMassQuery: 1
Priority: 50
EOF

# One path into the cache, alone: its NAR, xz-compressed, and a narinfo
# signed with the key. Everything it refers to is in nixpkgs' cache, where
# Nix finds it (`nix copy` to a file cache wants the whole closure in it).
add() {
  local path=$1 info nar tmp file_hash
  nix store sign --key-file "$KEY" "$path"
  info=$(nix path-info --json --json-format 1 "$path" | jq -c --arg p "$path" '.[$p] // .[0]')
  mkdir -p "$DIR/nar"
  tmp=$(mktemp "$DIR/nar/.tmp.XXXXXX")
  nix-store --dump "$path" | xz -T4 -6 >"$tmp"
  file_hash=$(nix hash file --type sha256 --base32 "$tmp")
  nar="nar/$file_hash.nar.xz"
  mv "$tmp" "$DIR/$nar"
  {
    echo "StorePath: $path"
    echo "URL: $nar"
    echo "Compression: xz"
    echo "FileHash: sha256:$file_hash"
    echo "FileSize: $(stat -c %s "$DIR/$nar")"
    echo "NarHash: sha256:$(nix hash convert --hash-algo sha256 --to nix32 "$(jq -r .narHash <<<"$info")")"
    echo "NarSize: $(jq -r .narSize <<<"$info")"
    echo "References: $(jq -r '.references | map(sub("^/nix/store/"; "")) | join(" ")' <<<"$info")"
    jq -r '.deriver // empty | "Deriver: " + sub("^/nix/store/"; "")' <<<"$info"
    jq -r '.signatures[] | select(startswith("din-cache-1:")) | "Sig: " + .' <<<"$info"
  } >"$DIR/$(basename "$path" | cut -d- -f1).narinfo"
}

for name in "${names[@]}"; do
  echo "Building $name"
  # Nix's own limits: the daemon builds it, outside any lowcpu scope.
  path=$(nix build --no-link --print-out-paths --cores 4 --max-jobs 1 "$flake#$attr.$name")
  hash=$(basename "$path" | cut -d- -f1)
  if [[ -f $DIR/$hash.narinfo ]]; then
    echo "$name is in the cache already ($path)"
    continue
  fi
  add "$path"
  echo "Added $name ($path)"
done

echo "Publishing $DIR as the din-cache nsite"
# ngit resolves --signer in a repository's context: Din's.
cd "$ROOT"
ngit --signer "$SIGNER" nsite publish "$DIR" --no-config --id din-cache \
  --title "Din binary cache" \
  --description "Nix binary cache for DinOS's optional features (din-cache-1)" \
  --blossom-server https://blossom.ditto.pub/ --blossom-server https://blossom.primal.net/ \
  --json | jq '{command_status, changed: .result.changed, problems: .result.blossom.problems, relays: .result.publication.relays}'

#!/usr/bin/env bash
#
# Din's artifacts: the optional features' parts Din builds itself, which no
# binary cache has (configuration.nix's system.build.din-artifacts:
# reims-vgpu's QEMU). For each, build it, write its NAR, xz-compressed and
# named by its SHA-256, into the artifacts folder, sign its narinfo with
# Din's key, and list both in os/din-artifacts.json, which installing the
# feature reads (electron/features.mts, os/din-update.sh).
#
#   scripts/din-artifacts.sh [<commit or ref, default HEAD>]
#
# Then upload the files it names to the Blossom servers in BLOSSOM_SERVERS
# (any Blossom client: they're found by their SHA-256), and only then
# commit and push os/din-artifacts.json. Run it whenever a part changes
# (reims-vgpu.nix, or the nixpkgs it's built with): a system whose list
# lacks a part's path can't install it, and scripts/dinos-release.sh checks
# every part is in the binary cache or in the list, its file on Blossom.
#
# DIN_ARTIFACTS_DIR: the folder (default ~/.local/share/din/artifacts).
# DIN_ARTIFACTS_KEY: the signing key (default ~/.config/din/nix-cache.sec).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF=${1:-HEAD}
DIR=${DIN_ARTIFACTS_DIR:-$HOME/.local/share/din/artifacts}
KEY=${DIN_ARTIFACTS_KEY:-$HOME/.config/din/nix-cache.sec}
BLOSSOM_SERVERS=(https://blossom.ditto.pub https://blossom.primal.net)
LIST=$ROOT/os/din-artifacts.json
[[ -r $KEY ]] || { echo "No signing key at $KEY (DIN_ARTIFACTS_KEY)" >&2; exit 1; }

# Built from a commit, never the working tree, so each path is the one that
# commit's systems name.
flake="git+file://$ROOT?rev=$(git -C "$ROOT" rev-parse "$REF")&dir=os"
attr="nixosConfigurations.dinos.config.system.build.din-artifacts"
mapfile -t names < <(nix eval --json "$flake#$attr" --apply builtins.attrNames | jq -r '.[]')

mkdir -p "$DIR"
list='{}'
upload=()
for name in "${names[@]}"; do
  echo "Building $name" >&2
  # Nix's own limits: the daemon builds it, outside any lowcpu scope.
  path=$(nix build --no-link --print-out-paths --cores 4 --max-jobs 1 "$flake#$attr.$name")
  nix store sign --key-file "$KEY" "$path"
  info=$(nix path-info --json --json-format 1 "$path" | jq -c --arg p "$path" '.[$p]')
  tmp=$(mktemp "$DIR/.tmp.XXXXXX")
  nix-store --dump "$path" | xz -T4 -6 >"$tmp"
  sha256=$(sha256sum "$tmp" | cut -d' ' -f1)
  file=$DIR/$sha256.nar.xz
  mv "$tmp" "$file"
  # The narinfo as a binary cache would serve it, its NAR at nar/ under its
  # Nix base-32 hash, where features.mts puts the download.
  file_hash=$(nix hash convert --hash-algo sha256 --to nix32 "$sha256")
  narinfo=$(
    echo "StorePath: $path"
    echo "URL: nar/$file_hash.nar.xz"
    echo "Compression: xz"
    echo "FileHash: sha256:$file_hash"
    echo "FileSize: $(stat -c %s "$file")"
    echo "NarHash: sha256:$(nix hash convert --hash-algo sha256 --to nix32 "$(jq -r .narHash <<<"$info")")"
    echo "NarSize: $(jq -r .narSize <<<"$info")"
    echo "References: $(jq -r '.references | map(sub("^/nix/store/"; "")) | join(" ")' <<<"$info")"
    jq -r '.deriver // empty | "Deriver: " + sub("^/nix/store/"; "")' <<<"$info"
    jq -r '.signatures[] | select(startswith("din-cache-1:")) | "Sig: " + .' <<<"$info"
  )
  urls=$(printf '%s\n' "${BLOSSOM_SERVERS[@]}" | jq -R --arg h "$sha256" '. + "/" + $h' | jq -s -c .)
  list=$(jq --arg p "$path" --arg s "$sha256" --argjson u "$urls" --arg n "$narinfo"$'\n' \
    '.[$p] = { sha256: $s, urls: $u, narinfo: $n }' <<<"$list")
  upload+=("$file")
done

jq -S . <<<"$list" >"$LIST"
echo "Wrote $LIST" >&2
echo "Upload these to ${BLOSSOM_SERVERS[*]}, then commit and push it:" >&2
for file in "${upload[@]}"; do
  sha256=$(basename "$file" .nar.xz)
  if curl -fsSI -o /dev/null "${BLOSSOM_SERVERS[0]}/$sha256"; then
    echo "  $file (already on ${BLOSSOM_SERVERS[0]})" >&2
  else
    echo "  $file" >&2
  fi
done

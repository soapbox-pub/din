#!/usr/bin/env bash
# Build and publish a DinOS release: `npm run os:release`.
#
# The version is os/version's, and the release is built from its tag, so a
# release is: bump os/version, commit, tag v<version>, run this. The build
# is from a clean worktree of the tag, never from the working tree.
#
# Two files are staged in .release-artifacts/ and published as a NIP-82
# release of `din` (.ngit/release.yaml):
#
#   DinOS-v<version>-x86_64-linux.update.tar.zst
#       What installed systems update from (os/din-update.sh): the system's
#       store path, the part of its closure cache.nixos.org has (which the
#       updater fetches from there), and a `nix-store --export` of the rest.
#   DinOS-v<version>-x86_64.img.zst
#       The disk image, for new installs.
#
# Options:
#   --stage-only  build and stage the files, but publish nothing. Builds
#                 HEAD when the version isn't tagged yet.
# Anything after `--` goes to `ngit release publish`, e.g. a signer:
#   npm run os:release -- -- --nbunksec-file ~/.soapbox-bunker
set -euo pipefail

die() {
  echo "$*" >&2
  exit 1
}

stage_only=false
ngit_args=()
while (($#)); do
  case $1 in
    --stage-only) stage_only=true ;;
    --) shift; ngit_args=("$@"); break ;;
    *) die "usage: dinos-release.sh [--stage-only] [-- <ngit release publish args>]" ;;
  esac
  shift
done

repo=$(git rev-parse --show-toplevel)
version=$(<"$repo/os/version")
tag=v$version
if commit=$(git -C "$repo" rev-parse -q --verify "refs/tags/$tag^{commit}"); then
  :
elif $stage_only; then
  commit=$(git -C "$repo" rev-parse HEAD)
  tag=""
else
  die "Tag the release first: git tag $tag"
fi

tmp=$(mktemp -d)
worktree=$tmp/din
cleanup() {
  git -C "$repo" worktree remove --force "$worktree" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
git -C "$repo" worktree add --quiet --detach "$worktree" "$commit"
[[ $(<"$worktree/os/version") == "$version" ]] ||
  die "$tag's os/version isn't $version."

echo "Building DinOS $version ($commit)..."
system=$(nix build --no-link --print-out-paths "$worktree/os#nixosConfigurations.dinos.config.system.build.toplevel")
image=$(nix build --no-link --print-out-paths "$worktree/os#image")
[[ $(cat "$system/etc/din-version") == "$version" ]] || die "The system isn't version $version."

# Split the closure into what cache.nixos.org has and what it doesn't.
# Anything it can't be asked about is shipped, which only costs size.
echo "Asking cache.nixos.org which of the system's store paths it has..."
# shellcheck disable=SC2016 # expanded by the inner shell
nix-store --query --requisites "$system" | xargs -P 32 -n 1 sh -c '
  hash=${1#/nix/store/}
  if curl -fsI -o /dev/null "https://cache.nixos.org/${hash%%-*}.narinfo"; then
    echo "cached $1"
  else
    echo "shipped $1"
  fi' _ >"$tmp/paths"
bundle=$tmp/bundle
mkdir "$bundle"
echo "$system" >"$bundle/system"
sed -n 's/^cached //p' "$tmp/paths" | sort >"$bundle/substitutes"
mapfile -t shipped < <(sed -n 's/^shipped //p' "$tmp/paths" | sort)
printf '%s\n' "${shipped[@]}" | grep -qxF "$system" || die "cache.nixos.org has the system itself?"
echo "${#shipped[@]} store paths to ship, $(wc -l <"$bundle/substitutes") from cache.nixos.org."
nix-store --export "${shipped[@]}" >"$bundle/store.export"

out=$repo/.release-artifacts
rm -rf "$out"
mkdir -p "$out"
update_file=$out/DinOS-v$version-x86_64-linux.update.tar.zst
image_file=$out/DinOS-v$version-x86_64.img.zst
tar -C "$bundle" -cf - system substitutes store.export | zstd -q -T0 -19 -o "$update_file"
echo "Compressing the disk image..."
zstd -q -T0 -12 "$image/nixos.img" -o "$image_file"
ls -lh "$out"

if $stage_only; then
  echo "Staged in $out; nothing published."
  exit 0
fi

channel=main
case $version in *-*) channel=beta ;; esac
cd "$repo"
ngit release publish "$version" --defaults --channel "$channel" \
  --repo "$(git remote get-url origin)" --commit "$commit" --tag "$tag" \
  "${ngit_args[@]}"

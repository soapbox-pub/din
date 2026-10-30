#!/usr/bin/env bash
# Build and publish a DinOS release: `npm run os:release`.
#
# The version is os/version's, and the release is built from its tag, so a
# release is: bump os/version, commit, tag v<version>, run this. The build
# is from a clean worktree of the tag, never from the working tree.
#
# The disk image, for new installs, is staged in .release-artifacts/ as
# DinOS-v<version>-x86_64.img.zst and published as a NIP-82 release of `din`
# (.ngit/release.yaml). Installed systems don't take releases: they build
# their updates from source (os/din-update.sh).
#
# Options:
#   --stage-only  build and stage the image, but publish nothing. Builds
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
image=$(nix build --no-link --print-out-paths "$worktree/os#image")

out=$repo/.release-artifacts
rm -rf "$out"
mkdir -p "$out"
image_file=$out/DinOS-v$version-x86_64.img.zst
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

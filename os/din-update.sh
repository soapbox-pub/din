# din-update: the privileged half of DinOS's system updates.
#
# DinOS releases are NIP-82 software releases of the application `din`
# (kind 30063, naming kind-3063 assets), signed by RELEASE_PUBKEY. One asset
# of each release is the update bundle (variant `update`): a zstd tarball of
#
#   system       the release's NixOS system, a /nix/store path
#   substitutes  the rest of its closure, one store path per line, all of
#                which cache.nixos.org has (checked when the release was made)
#   store.export `nix-store --export` of the paths it doesn't: Din itself and
#                the system's generated configuration
#
# so a release carries only what nobody else has built, and every byte of it
# is pinned by hash: the asset's `x` is the bundle's sha256, the release names
# the asset by id, and the release is signed by the one key this trusts.
# What comes from cache.nixos.org is checked by Nix against that cache's key,
# as on any NixOS machine. See scripts/dinos-release.sh for the other side.
#
# Din runs this through sudo from electron/updater.mts.
#
#   din-update status
#       JSON: whether this is a live boot, the running system's version, and
#       the version that the next boot starts, if one is staged.
#   din-update update
#       Look for a newer release and stage it for the next boot. Reports on
#       stdout as it goes - `available <version>`, `step <name>` and
#       `progress <percent>` lines - and finishes with `staged <version>`, or
#       `current` when there's nothing newer. Exits non-zero with the reason
#       on stderr if it can't.
#
# Staging is `switch-to-configuration boot`: the running system is left
# alone, and the new one starts at the next boot. The boot menu keeps the old
# ones (configuration.nix), so a bad update can be backed out of there.

RELEASE_PUBKEY=781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5
APP=din
CHANNEL=main
PLATFORM=linux-x86_64
# The same relays and servers .ngit/release.yaml publishes to.
RELAYS=(wss://relay.ditto.pub wss://relay.primal.net wss://relay.dreamith.to)
BLOSSOM_SERVERS=(https://blossom.ditto.pub https://blossom.primal.net https://blossom.dreamith.to)
PROFILE=/nix/var/nix/profiles/system
LOCK=/run/din-update.lock

die() {
  echo "$*" >&2
  exit 1
}

# The version a system was built as, or nothing for one from before versions.
version_of() {
  cat "$1/etc/din-version" 2>/dev/null || true
}

# Whether version $1 is newer than $2 (or $2 is empty).
newer() {
  [[ -z $2 ]] && return 0
  [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1) == "$1" ]]
}

# Booted from a USB stick or other removable media, as in din-install. A
# live system isn't updated: the Installer puts what's on the stick on disk.
is_live() {
  local root disk
  root=$(findmnt -nvo SOURCE /)
  disk=$(lsblk -no PKNAME "$root" | head -n1)
  [[ -n $disk ]] || return 1
  [[ $(cat "/sys/block/$disk/removable" 2>/dev/null) == 1 ]] ||
    [[ $(lsblk -dno TRAN "/dev/$disk") == usb ]]
}

status() {
  local live=false current staged=""
  if is_live; then live=true; fi
  current=$(version_of /run/current-system)
  if [[ $(readlink -f "$PROFILE") != $(readlink -f /run/current-system) ]]; then
    staged=$(version_of "$PROFILE")
  fi
  jq -n --argjson live "$live" --arg current "$current" --arg staged "$staged" '
    def orNull: if . == "" then null else . end;
    {live: $live, current: ($current | orNull), staged: ($staged | orNull)}'
}

# Events matching a filter from every relay that answers, verified, one per
# line. `nak verify` checks each one's id and signature; nak checks them too.
fetch_events() {
  local event
  { timeout 60 nak req "$@" "${RELAYS[@]}" 2>/dev/null || true; } |
    jq -cR 'fromjson? | select(type == "object" and .id != null)' | sort -u |
    while read -r event; do
      if nak verify <<<"$event" >/dev/null 2>&1; then echo "$event"; fi
    done
}

# The newest stable release, as JSON.
latest_release() {
  fetch_events -k 30063 -a "$RELEASE_PUBKEY" -t "i=$APP" -l 20 | jq -sc \
    --arg pubkey "$RELEASE_PUBKEY" --arg app "$APP" --arg channel "$CHANNEL" '
      def tag($name): [.tags[] | select(.[0] == $name) | .[1]] | first;
      map(select(.pubkey == $pubkey and tag("i") == $app and tag("c") == $channel)
        | {id, version: tag("version"), assets: [.tags[] | select(.[0] == "e") | .[1]]}
        | select(.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")))
      | sort_by(.version | split(".") | map(tonumber)) | last // empty'
}

# The release's update bundle asset, as JSON. Only an asset the release names
# by id counts: the id is the hash of the asset event, so the release's
# signature covers its `x` too.
update_asset() {
  local release=$1 version ids=() id
  version=$(jq -r .version <<<"$release")
  while read -r id; do ids+=(-i "$id"); done < <(jq -r '.assets[]' <<<"$release")
  ((${#ids[@]})) || return 0
  fetch_events -k 3063 -a "$RELEASE_PUBKEY" "${ids[@]}" | jq -sc \
    --arg pubkey "$RELEASE_PUBKEY" --arg app "$APP" --arg version "$version" \
    --arg platform "$PLATFORM" --argjson named "$(jq -c .assets <<<"$release")" '
      def tag($name): [.tags[] | select(.[0] == $name) | .[1]] | first;
      map(select(.pubkey == $pubkey and (.id as $id | $named | index($id))
          and tag("i") == $app and tag("version") == $version
          and tag("variant") == "update"
          and ([.tags[] | select(.[0] == "f") | .[1]] | index($platform)))
        | {x: (tag("x") // ""), url: (tag("url") // ""), size: (tag("size") // "0" | tonumber? // 0)}
        | select(.x | test("^[0-9a-f]{64}$")))
      | first // empty'
}

# Download the bundle to $1, from the asset's URL or any server that has it
# by hash, reporting progress, and check it against the asset's hash.
download() {
  local file=$1 x=$2 size=$3 url pid have
  shift 3
  for url in "$@"; do
    [[ $url == https://* ]] || continue
    rm -f "$file"
    curl -fsSL --retry 3 --connect-timeout 20 -o "$file" "$url" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      have=$(stat -c %s "$file" 2>/dev/null || echo 0)
      if ((size > 0)); then echo "progress $((have * 100 / size))"; fi
      sleep 1
    done
    if wait "$pid" && [[ $(sha256sum "$file" | cut -d' ' -f1) == "$x" ]]; then
      echo "progress 100"
      return 0
    fi
    echo "Couldn't download the update from $url" >&2
  done
  die "Couldn't download the update from any server."
}

# The update's scratch directory, removed on the way out.
work=""
cleanup() {
  if [[ -n $work ]]; then rm -rf "$work"; fi
}
trap cleanup EXIT

update() {
  if is_live; then die "A live system isn't updated. Install DinOS to get updates."; fi

  exec 9>"$LOCK"
  flock -n 9 || die "An update is already running."

  # Newer than what's running, and than what's already staged.
  local current staged release version asset system total fetched=0 batch
  current=$(version_of /run/current-system)
  staged=$(version_of "$PROFILE")
  if newer "$current" "$staged"; then staged=$current; fi

  release=$(latest_release)
  [[ -n $release ]] || die "Couldn't find any DinOS release."
  version=$(jq -r .version <<<"$release")
  if ! newer "$version" "$staged"; then
    echo current
    return
  fi
  echo "available $version"

  asset=$(update_asset "$release")
  [[ -n $asset ]] || die "DinOS $version has no update for this computer."

  work=$(mktemp -d /var/tmp/din-update.XXXXXX)

  echo "step download"
  local x server urls=()
  x=$(jq -r .x <<<"$asset")
  urls+=("$(jq -r .url <<<"$asset")")
  for server in "${BLOSSOM_SERVERS[@]}"; do urls+=("$server/$x"); done
  download "$work/bundle" "$x" "$(jq -r .size <<<"$asset")" "${urls[@]}"
  mkdir "$work/bundle.d"
  zstd -dc "$work/bundle" | tar -x -C "$work/bundle.d" system substitutes store.export
  rm "$work/bundle"

  system=$(<"$work/bundle.d/system")
  [[ $system =~ ^/nix/store/[a-z0-9]{32}-nixos-system-[A-Za-z0-9._+-]+$ ]] ||
    die "The update names no system."

  # What cache.nixos.org has, a batch at a time for the progress.
  echo "step fetch"
  total=$(wc -l <"$work/bundle.d/substitutes")
  while mapfile -t -n 100 batch && ((${#batch[@]})); do
    nix-store --realise "${batch[@]}" 2> >(grep -v -- "--add-root" >&2) >/dev/null ||
      die "Couldn't download part of the update from cache.nixos.org."
    fetched=$((fetched + ${#batch[@]}))
    echo "progress $((fetched * 100 / total))"
  done <"$work/bundle.d/substitutes"

  echo "step install"
  nix-store --import <"$work/bundle.d/store.export" >/dev/null ||
    die "Couldn't add the update to the Nix store."
  nix-store --query --requisites "$system" | xargs nix-store --check-validity ||
    die "The update is missing part of its system."
  [[ $(version_of "$system") == "$version" ]] ||
    die "The update isn't DinOS $version."

  nix-env --profile "$PROFILE" --set "$system"
  "$system/bin/switch-to-configuration" boot ||
    die "Couldn't add DinOS $version to the boot menu."
  echo "staged $version"
}

case "${1:-}" in
  status) status ;;
  update) update ;;
  *) die "usage: din-update status | update" ;;
esac

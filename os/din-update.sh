# din-update: the privileged half of DinOS's system updates.
#
# DinOS builds its updates from source. SRC is a git checkout of Din that
# only root can write to: whatever is in it becomes the next system, so
# nothing running as `din` may change it. Its `origin` is Din's own
# repository (DEFAULT_URL, a nostr:// remote: git-remote-nostr takes the
# branch's tip from its maintainers' signed state) or a fork's, and it
# follows one branch, `dinos.branch` in its git config. An update fetches
# that branch, builds the system its os/flake.nix describes, and stages it
# for the next boot, as `nixos-rebuild boot` would.
#
# din-update.service runs `din-update run`, on its timer and when asked
# (configuration.nix). Din reads how it's going with `status`.
#
#   din-update status
#       JSON: whether this is a live boot; the running system's version and
#       commit and the commit the next boot starts, if one is staged; the
#       repository and branch followed, whether updates are automatic, and
#       the last or current run's phase, step, progress and error.
#   din-update start
#       Check for an update now. Unlike the timer's runs, this one goes ahead
#       with updates off, on battery, or for a commit that failed to build.
#   din-update auto on|off
#       Whether the timer's runs update the system.
#   din-update source <url> <branch>
#       Follow another repository or branch: a fork's, say. Not one of the
#       commands Din runs without asking (configuration.nix), as whoever
#       chooses the source chooses what runs as root.
#   din-update run
#       The update itself, as din-update.service. Writes its progress to
#       STATE as it goes.
#
# Before it builds, a run makes sure there's room: the store on root has to
# take what the build adds, and the build directory (nix.settings.build-dir,
# on the home volume) its scratch space. It collects garbage if there isn't,
# and gives up with the reason if that's not enough. After staging, systems
# beyond the boot menu's (configuration.nix) leave the profile, so their
# store paths can go at the next collection.

DEFAULT_URL=nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/din
DEFAULT_BRANCH=main
# The configuration in os/flake.nix that's built.
SYSTEM_NAME=dinos
SRC=/var/lib/dinos/src
STATE=/var/lib/dinos/state.json
AUTO_OFF=/var/lib/dinos/manual
# Left by `start`, so `run` can tell the user asked.
REQUEST=/run/din-update.request
RESULT=/var/lib/dinos/result
PROFILE=/nix/var/nix/profiles/system
LOCK=/run/din-update.lock
UNIT=din-update.service
BUILD_DIR=/home/.nix-build
# Systems kept in the profile: the boot menu's (configurationLimit).
KEEP_GENERATIONS=5
GIB=$((1024 * 1024 * 1024))
# Room on root beyond what the build downloads, for what it builds.
ROOT_HEADROOM_BYTES=$((4 * GIB))
# Room for a build's scratch space: Din's node_modules, Rust's targets.
BUILD_DIR_BYTES=$((10 * GIB))

die() {
  echo "$*" >&2
  exit 1
}

# The commit a system was built from, or nothing for one from before that
# was recorded.
revision_of() {
  cat "$1/etc/din-revision" 2>/dev/null || true
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

src_git() {
  git -C "$SRC" "$@"
}

source_url() {
  src_git remote get-url origin 2>/dev/null || echo "$DEFAULT_URL"
}

source_branch() {
  src_git config dinos.branch 2>/dev/null || echo "$DEFAULT_BRANCH"
}

# The checkout, made empty (to be fetched into) the first time.
ensure_checkout() {
  [[ -d $SRC/.git ]] && return
  rm -rf "$SRC.partial"
  mkdir -p "$(dirname "$SRC")"
  git init -q "$SRC.partial"
  git -C "$SRC.partial" remote add origin "$DEFAULT_URL"
  git -C "$SRC.partial" config dinos.branch "$DEFAULT_BRANCH"
  mv "$SRC.partial" "$SRC"
}

# --- The run's state, kept in STATE between runs ---------------------------

phase=idle step="" percent=0 target="" error="" checked_at="" failed=""

load_state() {
  [[ -f $STATE ]] || return 0
  phase=$(jq -r '.phase // "idle"' "$STATE")
  error=$(jq -r '.error // ""' "$STATE")
  checked_at=$(jq -r '.checkedAt // ""' "$STATE")
  failed=$(jq -r '.failed // ""' "$STATE")
}

save_state() {
  jq -n --arg phase "$phase" --arg step "$step" --argjson percent "$percent" \
    --arg target "$target" --arg error "$error" --arg checkedAt "$checked_at" --arg failed "$failed" '
    def orNull: if . == "" then null else . end;
    {phase: $phase, step: ($step | orNull), percent: $percent, target: ($target | orNull),
     error: ($error | orNull), checkedAt: ($checkedAt | orNull | if . then tonumber else . end),
     failed: ($failed | orNull)}' >"$STATE.tmp"
  chmod 644 "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

set_step() {
  step=$1
  percent=0
  save_state
}

# End the run, as `idle` or with an error.
finish() {
  phase=${1:-idle}
  step=""
  percent=0
  target=""
  checked_at=$(date +%s%3N)
  save_state
}

fail() {
  error=$*
  echo "$error" >&2
  finish failed
  exit 1
}

status() {
  local live=false current staged="" version auto=true active=false
  if is_live; then live=true; fi
  version=$(cat /run/current-system/etc/din-version 2>/dev/null || true)
  current=$(revision_of /run/current-system)
  if [[ $(readlink -f "$PROFILE") != $(readlink -f /run/current-system) ]]; then
    staged=$(revision_of "$PROFILE")
  fi
  [[ -e $AUTO_OFF ]] && auto=false
  systemctl is-active -q "$UNIT" && active=true
  load_state
  # A run that was stopped (the computer turned off, say) never finished.
  if ! $active && [[ $phase == checking || $phase == updating ]]; then
    phase=failed
    error="The last update stopped before it finished."
  fi
  jq -n --argjson live "$live" --arg version "$version" --arg current "$current" \
    --arg staged "$staged" --arg url "$(source_url)" --arg branch "$(source_branch)" \
    --argjson auto "$auto" --arg phase "$phase" --argjson state "$(cat "$STATE" 2>/dev/null || echo '{}')" \
    --arg error "$error" '
    def orNull: if . == "" then null else . end;
    {live: $live, version: ($version | orNull), current: ($current | orNull), staged: ($staged | orNull),
     url: $url, branch: $branch, auto: $auto, phase: $phase,
     step: $state.step, percent: ($state.percent // 0), target: $state.target,
     error: (if $phase == "failed" then ($error | orNull) else null end), checkedAt: $state.checkedAt}'
}

start() {
  is_live && die "A live system isn't updated. Install DinOS to get updates."
  systemctl is-active -q "$UNIT" && return
  touch "$REQUEST"
  systemctl start --no-block "$UNIT"
}

auto() {
  case $1 in
    on) rm -f "$AUTO_OFF" ;;
    off) mkdir -p "$(dirname "$AUTO_OFF")" && touch "$AUTO_OFF" ;;
    *) die "usage: din-update auto on|off" ;;
  esac
}

set_source() {
  local url=$1 branch=$2
  # Only remotes that fetch by themselves: no local paths, nothing that
  # needs keys, and none of git's transports that run commands.
  [[ $url =~ ^(nostr|https)://[^[:space:]]+$ ]] || die "The repository must be a nostr:// or https:// URL."
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "\"$branch\" isn't a branch name."
  exec 9>"$LOCK"
  flock -n 9 || die "An update is running. Try again when it finishes."
  ensure_checkout
  src_git remote set-url origin "$url"
  src_git config dinos.branch "$branch"
  # A commit that failed elsewhere is worth trying again here.
  load_state
  failed=""
  save_state
}

# --- Building ---------------------------------------------------------------

# The error in Nix's log on stdin: the last `error:` line with a message,
# after the trace of what was being evaluated, without the store path the
# source was read from.
eval_error() {
  sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | { grep -E '^\s*error: \S' || true; } | tail -n1 |
    sed -E 's/^\s*error: *//; s/ Definition values:$//; s|/nix/store/[a-z0-9]{32}-source/||g'
}

free_bytes() {
  df -B1 --output=avail "$1" | tail -n1 | tr -d ' '
}

gib() {
  awk -v b="$1" 'BEGIN { printf "%.1f GB", b / 1073741824 }'
}

# What the build downloads, unpacked, in bytes, from `nix build --dry-run`.
fetch_bytes() {
  { grep -oE '[0-9.]+ [KMGT]iB unpacked' <<<"$1" || true; } | awk '
    { n = $1; u = $2 }
    END {
      m = u == "KiB" ? 1024 : u == "MiB" ? 1048576 : u == "GiB" ? 1073741824 : u == "TiB" ? 1099511627776 : 0
      printf "%d\n", n * m
    }'
}

# Make sure the build has room, collecting garbage if it doesn't.
check_space() {
  local installable=$1 plan root_need root_free build_free
  if ! plan=$(nix build --dry-run "$installable" 2>&1); then
    # A commit that doesn't evaluate won't build either.
    failed=$target
    fail "Commit ${target:0:7} doesn't build: $(eval_error <<<"$plan")"
  fi
  root_need=$(($(fetch_bytes "$plan") + ROOT_HEADROOM_BYTES))
  root_free=$(free_bytes /nix/store)
  build_free=$(free_bytes "$BUILD_DIR")
  if ((root_free >= root_need && build_free >= BUILD_DIR_BYTES)); then return; fi

  echo "Making room: $(gib "$root_free") free for the store, $(gib "$build_free") for building."
  prune_generations
  nix-store --gc >/dev/null 2>&1 || true
  root_free=$(free_bytes /nix/store)
  build_free=$(free_bytes "$BUILD_DIR")
  ((root_free >= root_need)) ||
    fail "Not enough space to update: the system needs $(gib "$root_need") free, and has $(gib "$root_free")."
  ((build_free >= BUILD_DIR_BYTES)) ||
    fail "Not enough space to update: building needs $(gib "$BUILD_DIR_BYTES") free in /home, and has $(gib "$build_free")."
}

# Systems beyond the boot menu's leave the profile. The running one always
# stays: it's a GC root of its own.
prune_generations() {
  nix-env --profile "$PROFILE" --delete-generations "+$KEEP_GENERATIONS" >/dev/null 2>&1 || true
}

# Nix's machine-readable log (--log-format internal-json) on stdin, as
# `progress <percent>` lines - derivations built and paths fetched, of
# those expected - and `error <message>` lines. Its errors and warnings go
# on to stderr, for the journal.
progress_of() {
  jq --unbuffered -nrR '
    def clean: gsub("\u001b\\[[0-9;]*[A-Za-z]"; "");
    foreach (inputs | select(startswith("@nix ")) | .[5:] | fromjson? // empty) as $m (
      {counts: {}, percent: -1, out: null};
      .out = null
      # actCopyPaths and actBuilds, whose resProgress is [done, expected, ...].
      | if $m.action == "start" and ($m.type == 103 or $m.type == 104) then
          .counts[$m.id | tostring] = [0, 0]
        elif $m.action == "result" and $m.type == 105 and .counts[$m.id | tostring] then
          .counts[$m.id | tostring] = $m.fields[0:2]
          | ([.counts[][0]] | add) as $done | ([.counts[][1]] | add) as $expected
          | (if $expected > 0 then ($done * 100 / $expected | floor) else 0 end) as $p
          | if $p != .percent then .percent = $p | .out = "progress \($p)" else . end
        elif $m.action == "msg" and $m.level <= 1 then
          ($m.msg | clean | . + "\n" | stderr) as $_
          | if $m.level == 0 then
              .out = "error \($m.msg | clean | sub("^error: "; "")
                | gsub("/nix/store/[a-z0-9]{32}-(?<name>[^'"'"']+?)(\\.drv)?(?=['"'"'])"; .name)
                | split("\n") | map(select(test("\\S"))) | first // "")"
            else . end
        else . end;
      .out // empty)'
}

# Build the system, as `built`.
built=""
build() {
  local installable=$1 line reason=""
  rm -f "$RESULT"
  # The result link keeps what's built from being collected before it's in
  # the profile.
  while read -r line; do
    case $line in
      progress\ *)
        percent=${line#progress }
        save_state
        ;;
      # The first is the build that failed; the rest follow from it.
      error\ *) [[ -n $reason ]] || reason=${line#error } ;;
    esac
  done < <(nix build --out-link "$RESULT" --log-format internal-json -v "$installable" 2>&1 >/dev/null | progress_of)
  built=$(readlink -f "$RESULT" 2>/dev/null || true)
  if [[ ! $built =~ ^/nix/store/[a-z0-9]{32}-nixos-system- ]]; then
    failed=$target
    fail "Couldn't build commit ${target:0:7}${reason:+: $reason}"
  fi
}

# Whether a system built from commit $1 already has commit $2: it's the same
# one, or $2 is in its history, so building $2 would go back. A commit made
# with uncommitted changes counts as the commit itself.
contains() {
  local have=${1%-dirty} want=$2
  [[ -n $have ]] || return 1
  [[ $have == "$want" ]] || src_git merge-base --is-ancestor "$want" "$have" 2>/dev/null
}

run() {
  if is_live; then exit 0; fi
  exec 9>"$LOCK"
  flock -n 9 || die "An update is already running."
  load_state

  local manual=false
  if [[ -e $REQUEST ]]; then manual=true; fi
  rm -f "$REQUEST"
  if ! $manual; then
    [[ -e $AUTO_OFF ]] && exit 0
    # Building a whole system on battery is the user's to ask for.
    systemd-ac-power || exit 0
  fi

  # Its error is shown again if this run goes no further than finding the
  # same failed commit.
  local last_error=$error
  error=""
  phase=checking
  set_step fetch
  ensure_checkout
  local url branch tip current staged
  url=$(source_url)
  branch=$(source_branch)
  echo "Fetching $branch from $url"
  src_git fetch --quiet --no-tags origin "refs/heads/$branch" </dev/null ||
    fail "Couldn't get $branch from $url."
  tip=$(src_git rev-parse FETCH_HEAD)
  current=$(revision_of /run/current-system)
  staged=$(revision_of "$PROFILE")
  if contains "$current" "$tip" || contains "$staged" "$tip"; then
    echo "Up to date at $tip"
    error=""
    finish
    return
  fi
  if ! $manual && [[ $tip == "$failed" ]]; then
    echo "Not building $tip again: it failed before."
    error=$last_error
    finish failed
    return
  fi

  # The checkout is exactly the commit: nothing of an earlier one is left
  # for the flake to pick up.
  src_git checkout -q --force --detach "$tip"
  src_git clean -q -ffdx

  phase=updating
  target=$tip
  local installable="$SRC/os#nixosConfigurations.$SYSTEM_NAME.config.system.build.toplevel"
  set_step space
  check_space "$installable"
  set_step build
  echo "Building $tip"
  build "$installable"
  [[ $(revision_of "$built") == "$tip" ]] || fail "Commit ${tip:0:7} didn't build as itself."

  set_step install
  nix-env --profile "$PROFILE" --set "$built"
  rm -f "$RESULT"
  "$built/bin/switch-to-configuration" boot ||
    fail "Couldn't add the update to the boot menu."
  prune_generations
  echo "Staged $tip"
  error=""
  failed=""
  finish
}

case "${1:-}" in
  status) status ;;
  start) start ;;
  auto) auto "${2:-}" ;;
  source)
    [[ $# == 3 ]] || die "usage: din-update source <url> <branch>"
    set_source "$2" "$3"
    ;;
  run) run ;;
  *) die "usage: din-update status | start | auto on|off | source <url> <branch> | run" ;;
esac

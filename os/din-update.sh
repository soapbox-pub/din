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
#       the last or current run's phase, step, progress and error; and
#       what the running system still needs to be all of itself (`restart`)
#       and to start the staged one (`stagedNeeds`), below.
#   din-update start
#       Check for an update now. Unlike the timer's runs, this one goes ahead
#       with updates off, on battery, or for a commit that failed to build.
#   din-update replace
#       Like `start`, but builds the branch's tip as it is, over whatever
#       the system was built from: for a system whose commit the updater
#       can't find (`missing`, below), or changes the user no longer wants.
#       The branch is the source already chosen, so this chooses nothing
#       new to trust.
#   din-update auto on|off
#       Whether the timer's runs update the system.
#   din-update source <url> <branch>
#       Follow another repository or branch: a fork's, say. Not one of the
#       commands Din runs without asking (configuration.nix), as whoever
#       chooses the source chooses what runs as root.
#   din-update apply
#       Switch to the staged system now, as `nixos-rebuild switch` would,
#       where it needs no restart of the computer.
#   din-update restart-din
#       Restart din-shell.service: Din, and every app in it. Din asks for
#       this, so it doesn't wait for its own end.
#   din-update local <commit>
#       Build commit <commit> of ~/DinOS (the full hash) as the next system,
#       with the service's progress like any update, and switch to it unless
#       it needs the computer to restart. Prints what's left: `din`,
#       `reboot`, or nothing (`needs_for`). Not one of the commands Din runs
#       without asking, as it builds what the user wrote; sudo asks, for that
#       commit and no other, as it would for `nixos-rebuild switch`.
#   din-update run
#       The update itself, as din-update.service. Writes its progress to
#       STATE as it goes.
#
# A system built from commits of the user's own (with nixos-rebuild, from
# their copy of Din in ~/DinOS: the dinos skill) is custom: the commit it
# was built from isn't in the branch's history. An update keeps those
# changes, merging the branch's tip into that commit and building the
# merge. Only that exact commit is merged, never whatever ~/DinOS holds
# now: the user approved it, through sudo, when they built it. If the
# checkout doesn't have it, it's read from ~/DinOS as its owner, so root
# never runs git in a repository someone else controls, and a commit can't
# be swapped for another under its hash. A merge that conflicts, or a
# system built from uncommitted changes, which can't be carried forward,
# fails with a `reason` Din offers to have the assistant fix (merging in
# ~/DinOS, where sudo asks again). So does a commit that's neither in the
# checkout (which keeps everything it ever fetched or built) nor in
# ~/DinOS: it was built by hand from somewhere else, and building the
# branch over it could take the system back to an older Din. Only
# `replace` does that, when the user asks.
#
# A merge that comes out the same as the branch's tip (the user's changes
# have been taken upstream) builds the tip itself, so the system is no
# longer custom.
#
# The checkout's `upstream` branch is the tip last fetched, and its `system`
# branch the commit of the last system the updater staged, for ~/DinOS to
# pull.
#
# Updates are staged for the next boot, but most needn't wait for it. A
# system switched to while running (`apply`, or `nixos-rebuild switch`)
# restarts the services that changed, except din-shell.service: that's
# Din, and everything in it, so it keeps running the Din it started with
# until it's restarted (`restart-din`). A new kernel, initrd, kernel
# parameters, modules or firmware wait for the computer's restart.
# Settings in /etc that a running service reads only when it starts (one
# with no restartTriggers) also wait for that service's next start, which
# nothing here can see.
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
SHELL_UNIT=din-shell.service
BOOTED=/run/booted-system
BUILD_DIR=/home/.nix-build
# Systems kept in the profile: the boot menu's (configurationLimit).
KEEP_GENERATIONS=5
UPSTREAM_REF=refs/heads/upstream
SYSTEM_REF=refs/heads/system
# The user's copy of Din, and whose it is.
FORK_USER=din
FORK_HOME=~din
FORK=$FORK_HOME/DinOS
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

has_commit() {
  src_git cat-file -e "$1^{commit}" 2>/dev/null
}

# The commit the newest system was built from: the next boot's.
newest_revision() {
  local revision
  revision=$(revision_of "$PROFILE")
  [[ -n $revision ]] || revision=$(revision_of /run/current-system)
  echo "$revision"
}

# git in ~/DinOS, as its owner.
fork_git() {
  runuser -u "$FORK_USER" -- env HOME="$FORK_HOME" git -C "$FORK" "$@"
}

# Copy commit $1 and its history from ~/DinOS into the checkout, leaving
# out what the tip $2 already brings if ~/DinOS has it. The checkout only
# takes the objects in.
import_from_fork() {
  local commit=$1 tip=$2 have=""
  [[ -d $FORK ]] || return 1
  fork_git cat-file -e "$commit^{commit}" </dev/null 2>/dev/null || return 1
  if fork_git cat-file -e "$tip^{commit}" </dev/null 2>/dev/null; then have="^$tip"; fi
  printf '%s\n' "$commit" ${have:+"$have"} | fork_git pack-objects --revs --stdout -q |
    src_git index-pack --stdin --fix-thin >/dev/null 2>&1 || return 1
  # All of its history is here, not just the commit.
  src_git rev-list --objects "$commit" >/dev/null 2>&1
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

# `failed` is the attempt that failed to build (attempt below), not tried
# again unless asked; `reason` why the last run failed, when it's for the
# user to fix: `conflict`, `dirty`, `missing`, or `build`.
phase=idle step="" percent=0 target="" error="" reason="" checked_at="" failed=""

load_state() {
  [[ -f $STATE ]] || return 0
  phase=$(jq -r '.phase // "idle"' "$STATE")
  error=$(jq -r '.error // ""' "$STATE")
  reason=$(jq -r '.reason // ""' "$STATE")
  checked_at=$(jq -r '.checkedAt // ""' "$STATE")
  failed=$(jq -r '.failed // ""' "$STATE")
}

save_state() {
  jq -n --arg phase "$phase" --arg step "$step" --argjson percent "$percent" \
    --arg target "$target" --arg error "$error" --arg reason "$reason" --arg checkedAt "$checked_at" --arg failed "$failed" '
    def orNull: if . == "" then null else . end;
    {phase: $phase, step: ($step | orNull), percent: $percent, target: ($target | orNull),
     error: ($error | orNull), reason: ($reason | orNull), checkedAt: ($checkedAt | orNull | if . then tonumber else . end),
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
  reason=""
  echo "$error" >&2
  finish failed
  exit 1
}

# Fail for a reason that's the user's to fix ($1).
fail_for() {
  local why=$1
  shift
  error=$*
  reason=$why
  echo "$error" >&2
  finish failed
  exit 1
}

# Whether the newest system is custom (above): built from uncommitted
# changes, or from a commit that isn't in the branch's history as last
# fetched. Then `changes` is how many commits of the user's it has, if the
# checkout has them to count.
custom=false changes=null
find_custom() {
  local head
  head=$(newest_revision)
  [[ -n $head ]] || return 0
  if [[ $head == *-dirty ]]; then
    custom=true
    return
  fi
  src_git rev-parse -q --verify "$UPSTREAM_REF" >/dev/null 2>&1 || return 0
  if has_commit "$head"; then
    src_git merge-base --is-ancestor "$head" "$UPSTREAM_REF" 2>/dev/null && return
    custom=true
    changes=$(src_git rev-list --count --no-merges "$UPSTREAM_REF..$head" 2>/dev/null) || changes=null
  else
    custom=true
  fi
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
    reason=""
  fi
  find_custom
  local restart="" staged_needs=""
  if ! $live; then
    restart=$(needs_for /run/current-system)
    if [[ -n $staged ]]; then staged_needs=$(needs_for "$(readlink -f "$PROFILE")"); fi
  fi
  jq -n --arg restart "$restart" --arg stagedNeeds "$staged_needs" \
    --argjson live "$live" --arg version "$version" --arg current "$current" \
    --arg staged "$staged" --arg url "$(source_url)" --arg branch "$(source_branch)" \
    --argjson auto "$auto" --arg phase "$phase" --argjson state "$(cat "$STATE" 2>/dev/null || echo '{}')" \
    --arg error "$error" --arg reason "$reason" --argjson custom "$custom" --argjson changes "$changes" '
    def orNull: if . == "" then null else . end;
    {live: $live, version: ($version | orNull), current: ($current | orNull), staged: ($staged | orNull),
     url: $url, branch: $branch, auto: $auto, phase: $phase,
     step: $state.step, percent: ($state.percent // 0), target: $state.target,
     error: (if $phase == "failed" then ($error | orNull) else null end),
     reason: (if $phase == "failed" then ($reason | orNull) else null end),
     custom: $custom, changes: $changes, checkedAt: $state.checkedAt,
     restart: ($restart | orNull), stagedNeeds: (if $staged == "" then null else ($stagedNeeds | orNull) end)}'
}

# The command Din runs under: din-shell's, which execs its compositor with
# Din's launcher. From system $1's unit, or with no argument, of the
# running Din.
din_command() {
  local script pid
  if [[ -n ${1:-} ]]; then
    script=$(sed -n 's/^ExecStart=//p' "$1/etc/systemd/system/$SHELL_UNIT" 2>/dev/null | head -n1)
    [[ -n $script ]] || return 0
    sed -n 's/^exec  *//p' "$script" 2>/dev/null | head -n1
  else
    pid=$(systemctl show -p MainPID --value "$SHELL_UNIT" 2>/dev/null)
    [[ -n $pid && $pid != 0 ]] || return 0
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | sed 's/ *$//'
  fi
}

# What running system $1 would take, on top of switching to it: `reboot`
# when its kernel, initrd, kernel parameters, modules or firmware aren't
# the booted system's, `din` when its Din isn't the one running, or
# nothing.
needs_for() {
  local system=$1 part running
  for part in kernel initrd kernel-modules firmware; do
    [[ $(readlink -f "$system/$part") == $(readlink -f "$BOOTED/$part") ]] || {
      echo reboot
      return
    }
  done
  cmp -s "$system/kernel-params" "$BOOTED/kernel-params" || {
    echo reboot
    return
  }
  running=$(din_command)
  [[ -z $running || $running == "$(din_command "$system")" ]] || echo din
}

# $1 is what was asked: `start`, or `replace`.
start() {
  is_live && die "A live system isn't updated. Install DinOS to get updates."
  if systemctl is-active -q "$UNIT"; then
    [[ ${1:-start} == start ]] && return
    die "An update is running. Try again when it finishes."
  fi
  echo "${1:-start}" >"$REQUEST"
  systemctl start --no-block "$UNIT"
}

auto() {
  case $1 in
    on) rm -f "$AUTO_OFF" ;;
    off) mkdir -p "$(dirname "$AUTO_OFF")" && touch "$AUTO_OFF" ;;
    *) die "usage: din-update auto on|off" ;;
  esac
}

# Switch to the staged system now. It's the one the next boot starts
# anyway, so applying it early chooses nothing new.
apply() {
  is_live && die "A live system isn't updated."
  exec 9>"$LOCK"
  flock -w 30 9 || die "An update is running. Try again when it finishes."
  local next
  next=$(readlink -f "$PROFILE")
  [[ $next != "$(readlink -f /run/current-system)" ]] || die "There's no update to apply."
  [[ $(needs_for "$next") != reboot ]] || die "This update needs the computer to restart."
  "$next/bin/switch-to-configuration" switch </dev/null || die "Couldn't apply the update."
}

restart_din() {
  systemctl restart --no-block "$SHELL_UNIT"
}

# `local`: have the service build commit $1 of ~/DinOS (run_local), then
# switch to it as `apply` would.
build_local() {
  local commit=$1 next
  is_live && die "A live system isn't updated."
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || die "usage: din-update local <commit>"
  systemctl is-active -q "$UNIT" && die "An update is running. Try again when it finishes."
  echo "local $commit" >"$REQUEST"
  # A oneshot: this waits for the run, whose failure is in STATE.
  systemctl start "$UNIT" 2>/dev/null || true
  load_state
  [[ $phase != failed ]] || die "${error:-The update failed.}"
  next=$(readlink -f "$PROFILE")
  [[ $(revision_of "$next") == "$commit" ]] || die "Commit ${commit:0:7} wasn't built."
  if [[ $next != "$(readlink -f /run/current-system)" ]]; then
    if [[ $(needs_for "$next") == reboot ]]; then
      echo reboot
      return
    fi
    exec 9>"$LOCK"
    flock -w 30 9 || die "An update is running. Try again when it finishes."
    "$next/bin/switch-to-configuration" switch </dev/null >&2 || die "Couldn't switch to commit ${commit:0:7}."
  fi
  needs_for /run/current-system
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
    failed=$attempt
    fail_build "${what^} doesn't build: $(eval_error <<<"$plan")"
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

# What's being built, as the user would put it ("commit 1234abc"), and
# what a failure to build it is keyed by (`failed`): the tip, or for a
# merge both of its sides.
what="" attempt="" merging=false

# A build that failed: the user's to fix if it's their changes.
fail_build() {
  if $merging; then fail_for build "$*"; else fail "$*"; fi
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
    failed=$attempt
    fail_build "Couldn't build $what${reason:+: $reason}"
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

  local manual=false replace=false request=""
  if [[ -e $REQUEST ]]; then
    manual=true
    request=$(cat "$REQUEST")
  fi
  rm -f "$REQUEST"
  case $request in
    replace) replace=true ;;
    local\ *)
      run_local "${request#local }"
      return
      ;;
  esac
  if ! $manual; then
    [[ -e $AUTO_OFF ]] && exit 0
    # Building a whole system on battery is the user's to ask for.
    systemd-ac-power || exit 0
  fi

  # Its error is shown again if this run goes no further than finding the
  # same failed attempt.
  local last_error=$error last_reason=$reason
  error=""
  reason=""
  phase=checking
  set_step fetch
  ensure_checkout
  local url branch tip current head
  url=$(source_url)
  branch=$(source_branch)
  echo "Fetching $branch from $url"
  src_git fetch --quiet --no-tags origin "refs/heads/$branch" </dev/null ||
    fail "Couldn't get $branch from $url."
  tip=$(src_git rev-parse FETCH_HEAD)
  src_git update-ref "$UPSTREAM_REF" "$tip"
  current=$(revision_of /run/current-system)
  head=$(newest_revision)
  if [[ -n $head && $head != *-dirty ]] && ! has_commit "$head"; then
    import_from_fork "$head" "$tip" && echo "Took commit $head from $FORK"
  fi
  if $replace; then
    echo "Replacing ${head:-the system} with $tip, as asked"
  elif contains "$current" "$tip" || contains "$head" "$tip"; then
    echo "Up to date at $tip"
    finish
    return
  fi

  # Whether the newest system has changes of the user's to keep (status's
  # custom).
  if $replace; then
    :
  elif [[ $head == *-dirty ]]; then
    fail_for dirty "DinOS was built with uncommitted changes, which an update can't keep. Commit them in ~/DinOS and build it again."
  elif [[ -n $head ]] && ! src_git merge-base --is-ancestor "$head" "$tip" 2>/dev/null; then
    if has_commit "$head"; then
      merging=true
    elif [[ -d $FORK ]]; then
      fail_for missing "DinOS was built from commit ${head:0:7}, which isn't in ~/DinOS, so an update can't keep its changes."
    else
      fail_for missing "DinOS was built from commit ${head:0:7}, which isn't on $branch, and there's no ~/DinOS to find it in, so an update could take it back to an older version."
    fi
  fi

  if $merging; then
    attempt="$head+$tip"
    what="your changes with commit ${tip:0:7}"
  else
    attempt=$tip
    what="commit ${tip:0:7}"
  fi
  if ! $manual && [[ $attempt == "$failed" ]]; then
    echo "Not building $attempt again: it failed before."
    error=$last_error
    reason=$last_reason
    finish failed
    return
  fi

  phase=updating
  target=$tip
  # The checkout is exactly the commit: nothing of an earlier one is left
  # for the flake to pick up.
  if $merging; then
    set_step merge
    src_git checkout -q --force --detach "$head"
    src_git clean -q -ffdx
    echo "Merging $tip into $head"
    merge_upstream "$tip" "$branch"
  else
    src_git checkout -q --force --detach "$tip"
    src_git clean -q -ffdx
  fi
  stage
}

# Build commit $1 of ~/DinOS, as `local` asked, and stage it. The user
# approved that commit, so it's built as it is: no merge, and whatever it
# has of the branch.
run_local() {
  local commit=$1 upstream
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail "\"$commit\" isn't a commit."
  error=""
  reason=""
  phase=updating
  target=$commit
  attempt=$commit
  what="commit ${commit:0:7}"
  set_step fetch
  ensure_checkout
  upstream=$(src_git rev-parse -q --verify "$UPSTREAM_REF" 2>/dev/null || true)
  has_commit "$commit" || import_from_fork "$commit" "$upstream" ||
    fail "Commit ${commit:0:7} isn't in ~/DinOS."
  echo "Building commit $commit of $FORK, as asked"
  src_git checkout -q --force --detach "$commit"
  src_git clean -q -ffdx
  stage
}

# Build the checked-out commit, `target`, and make it the next boot's.
stage() {
  local installable="$SRC/os#nixosConfigurations.$SYSTEM_NAME.config.system.build.toplevel"
  set_step space
  check_space "$installable"
  set_step build
  echo "Building $target"
  build "$installable"
  [[ $(revision_of "$built") == "$target" ]] || fail "${what^} didn't build as itself."

  set_step install
  nix-env --profile "$PROFILE" --set "$built"
  rm -f "$RESULT"
  "$built/bin/switch-to-configuration" boot ||
    fail "Couldn't add the update to the boot menu."
  prune_generations
  src_git update-ref "$SYSTEM_REF" "$target"
  echo "Staged $target"
  error=""
  failed=""
  finish
}

# Merge the tip $1 of branch $2 into the checked-out commit, the user's,
# making the merge the `target`.
merge_upstream() {
  local tip=$1 branch=$2 conflicts
  if src_git -c user.name=DinOS -c user.email=din-update@dinos -c commit.gpgSign=false \
    merge -q --no-edit -m "Merge $branch into your changes" "$tip" >/dev/null 2>&1; then
    target=$(src_git rev-parse HEAD)
    # The user's changes are all upstream now: build the tip, not a merge
    # that's the same.
    if src_git diff --quiet "$tip" HEAD; then
      echo "Your changes are all in $tip already"
      src_git checkout -q --force --detach "$tip"
      target=$tip
      merging=false
      what="commit ${tip:0:7}"
    fi
    return
  fi
  conflicts=$(src_git diff --name-only --diff-filter=U | head -n3 | paste -sd , || true)
  src_git merge --abort 2>/dev/null || src_git reset -q --hard
  src_git clean -q -ffdx
  fail_for conflict "Your changes to DinOS conflict with commit ${tip:0:7} of $branch${conflicts:+, in ${conflicts//,/, }}."
}

case "${1:-}" in
  status) status ;;
  start) start ;;
  replace) start replace ;;
  auto) auto "${2:-}" ;;
  source)
    [[ $# == 3 ]] || die "usage: din-update source <url> <branch>"
    set_source "$2" "$3"
    ;;
  apply) apply ;;
  restart-din) restart_din ;;
  local)
    [[ $# == 2 ]] || die "usage: din-update local <commit>"
    build_local "$2"
    ;;
  run) run ;;
  *) die "usage: din-update status | start | replace | auto on|off | source <url> <branch> | apply | restart-din | local <commit> | run" ;;
esac

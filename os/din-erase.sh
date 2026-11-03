# din-erase: the privileged half of Settings → About's Erase All Data.
#
# Erasing puts the computer back as the Installer left it, running official
# DinOS: no files, accounts, apps, saved networks or settings, and on an
# encrypted disk no password, which the Setup screen asks for before the
# desktop starts (din-password setup). It's done at once, with nothing of
# the user's running, and then the computer restarts:
#
#   din-erase status
#       JSON: whether this computer can be erased (`available`, or the
#       `reason` it can't: `live`, `layout` for a disk installed before
#       Btrfs), whether its disk is `encrypted`, whether it has a
#       `password`, and whether the system the next boot starts is
#       `official` DinOS (below).
#   din-erase start
#       The password on stdin, where there is one. Checks it, and that the
#       next boot's system is official: built from a commit on the official
#       repository's main branch, as last fetched, with no changes of the
#       user's, since their source (~/DinOS) is about to go and no update
#       could follow it. Takes every other system out of the boot menu,
#       then does `mark`'s work without reading the password again.
#   din-erase mark
#       The password on stdin, where there is one; root's alone, without
#       start's checks, for tests. Adds a key on the boot partition
#       (SETUP_KEY) to the disk, which the initrd opens it with from then on
#       without asking, marks the disk to be erased (MARK), and isolates
#       din-erase.target: everything but the system's own base stops, Din
#       and the user's session with it, and din-erase.service does `run`.
#   din-erase run
#       The erasing, as din-erase.service, with only the boot screen showing
#       "Erasing…": an empty home in place of the old one, the system's own
#       record of the user emptied (wipe_system), the disk's other keys
#       gone, so only SETUP_KEY opens it, `din`'s password gone, and the
#       boot screen's things. Then the computer restarts, into Setup.
#   din-erase finish
#       din-erase-finish.service, at a boot that finds MARK: one that
#       stopped partway, say with the power cut. The initrd has already put
#       an empty home in place of the old one (dinos-erase,
#       configuration.nix); this does the rest of `run` before anything that
#       reads what it empties starts.
#
# MARK goes only once everything's done, so whatever stops an erase, the
# next boot finishes it.
MARK=/var/lib/dinos/erase
SETUP_MARK=/var/lib/din/setup
SETUP_KEY=/boot/din/setup.key
PROFILE=/nix/var/nix/profiles/system
SRC=/var/lib/dinos/src
# As in os/din-update.sh.
OFFICIAL_URL=nostr://npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj/git.shakespeare.diy/din
OFFICIAL_BRANCH=main
UPSTREAM_REF=refs/heads/upstream
USER_NAME=din
TOP=/run/din-erase

die() {
  echo "$*" >&2
  exit 1
}

# Booted from a USB stick, as in din-install and din-update.
is_live() {
  local root disk
  root=$(findmnt -nvo SOURCE /)
  disk=$(lsblk -no PKNAME "$root" | head -n1)
  [[ -n $disk ]] || return 1
  [[ $(cat "/sys/block/$disk/removable" 2>/dev/null) == 1 ]] ||
    [[ $(lsblk -dno TRAN "/dev/$disk") == usb ]]
}

# Root's Btrfs with home in its `@home`, as the Installer makes it.
is_btrfs_install() {
  [[ $(findmnt -nvo FSTYPE /) == btrfs && $(findmnt -nvo FSROOT /home 2>/dev/null) == /@home ]]
}

# The partition under root's encryption, or nothing for a plain root.
luks_partition() {
  lsblk -nsrpo NAME,TYPE "$(findmnt -nvo SOURCE /)" | awk 'found { print $1; exit } $2 == "crypt" { found = 1 }'
}

has_password() {
  local hash
  hash=$(awk -F: -v user="$USER_NAME" '$1 == user { print $2 }' /etc/shadow)
  case $hash in
    "" | "!"* | "*"*) return 1 ;;
  esac
}

src_git() {
  git -C "$SRC" "$@"
}

# Whether the next boot's system is official (above), and one that knows
# how to finish erasing.
is_official() {
  local system revision
  system=$(readlink -f "$PROFILE")
  [[ -e $system/etc/systemd/system/din-erase-finish.service ]] || return 1
  revision=$(cat "$system/etc/din-revision" 2>/dev/null || true)
  [[ $revision =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ $(src_git remote get-url origin 2>/dev/null) == "$OFFICIAL_URL" ]] || return 1
  [[ $(src_git config dinos.branch 2>/dev/null || echo "$OFFICIAL_BRANCH") == "$OFFICIAL_BRANCH" ]] || return 1
  src_git merge-base --is-ancestor "$revision" "$UPSTREAM_REF" 2>/dev/null
}

status() {
  local available=true reason="" encrypted=false password=false official=false
  if is_live; then
    available=false reason=live
  elif ! is_btrfs_install; then
    available=false reason=layout
  fi
  [[ -n $(luks_partition) ]] && encrypted=true
  has_password && password=true
  $available && is_official && official=true
  jq -n --argjson available "$available" --arg reason "$reason" --argjson encrypted "$encrypted" \
    --argjson password "$password" --argjson official "$official" '
    {available: $available, reason: (if $reason == "" then null else $reason end),
     encrypted: $encrypted, password: $password, official: $official}'
}

mark_and_erase() {
  local password=$1 part
  part=$(luks_partition)
  if [[ -n $part ]]; then
    [[ -n $password ]] || die "The disk's password is needed to erase it."
    printf '%s' "$password" | add_setup_key "$part" ||
      die "The disk didn't take its setup key; nothing was erased."
  fi
  mkdir -p "$(dirname "$MARK")"
  echo erase >"$MARK"
  sync
  # Not waited for: it stops whatever ran this.
  systemctl isolate --no-block din-erase.target
}

mark() {
  local password=""
  IFS= read -r password || true
  mark_and_erase "$password"
}

start() {
  is_live && die "DinOS running from a USB stick isn't erased; it starts fresh without its files on another computer."
  is_btrfs_install || die "This DinOS was installed before your files were kept apart from the system. Reinstall it from a USB stick, erasing the disk, to start over."
  local password=""
  if has_password; then
    IFS= read -r password || true
    printf '%s\n' "$password" | din-password check || exit 1
  fi
  case $(systemctl is-active din-update.service || true) in
    active | activating | deactivating | reloading) die "An update is running. Try again when it finishes." ;;
  esac
  is_official || die "The system the computer starts next isn't official DinOS. Build official DinOS first."
  # Only the system being kept boots from here on: none built from what's
  # about to be erased.
  nix-env --profile "$PROFILE" --delete-generations old >/dev/null
  "$(readlink -f "$PROFILE")/bin/switch-to-configuration" boot </dev/null >&2 ||
    die "Couldn't set up the boot menu."
  mark_and_erase "$password"
}

# The keyslot key file $1 opens on partition $2.
slot_of() {
  { cryptsetup open --test-passphrase --verbose --key-file="$1" "$2" 2>&1 || true; } |
    sed -n 's/^Key slot \([0-9]*\) unlocked.*/\1/p' | head -n1
}

# A new SETUP_KEY on partition $1, added with the passphrase on stdin.
add_setup_key() {
  local part=$1 passphrase
  IFS= read -r -d '' passphrase || true
  mkdir -p "$(dirname "$SETUP_KEY")"
  head -c 64 /dev/urandom >"$SETUP_KEY.tmp"
  sync "$SETUP_KEY.tmp"
  mv -f "$SETUP_KEY.tmp" "$SETUP_KEY"
  if printf '%s' "$passphrase" | cryptsetup luksAddKey --batch-mode --key-file=- "$part" "$SETUP_KEY" 2>/dev/null; then
    sync
    return 0
  fi
  rm -f "$SETUP_KEY"
  return 1
}

# The disk's keys: only SETUP_KEY, which `mark` added, opens it once this
# is done.
forget_disk_password() {
  local part=$1 slot other token
  slot=$(slot_of "$SETUP_KEY" "$part")
  [[ -n $slot ]] || die "The setup key doesn't open the disk."
  for other in $(cryptsetup luksDump --dump-json-metadata "$part" | jq -r '.keyslots | keys[]'); do
    [[ $other == "$slot" ]] && continue
    cryptsetup luksKillSlot --batch-mode --key-file="$SETUP_KEY" "$part" "$other"
  done
  for token in $(cryptsetup luksDump --dump-json-metadata "$part" | jq -r '.tokens | keys[]'); do
    cryptsetup token remove --token-id "$token" "$part"
  done
}

# The system's own record of the user (os/din-pristine.sh's pristine_system).
wipe_system() {
  # The journal moves to /run until the restart, so none of it is kept.
  journalctl --relinquish-var 2>/dev/null || true
  pristine_system ""
}

# An empty home in place of the old one, which is deleted.
replace_home() {
  local root
  root=$(findmnt -nvo SOURCE /)
  mkdir -p "$TOP"
  mountpoint -q "$TOP" || mount -o subvolid=5 "$root" "$TOP"
  if [[ ! -d $TOP/@home.new ]]; then
    btrfs subvolume create "$TOP/@home.new" >/dev/null
    btrfs property set "$TOP/@home.new" compression zstd
  fi
  if [[ -d $TOP/@home ]]; then
    mv "$TOP/@home" "$TOP/@home.erased.$(date +%s%N)"
  fi
  mv "$TOP/@home.new" "$TOP/@home"
}

# The old homes replace_home or the initrd set aside. Btrfs frees their
# space in the background.
delete_old_homes() {
  local old
  mkdir -p "$TOP"
  mountpoint -q "$TOP" || mount -o subvolid=5 "$(findmnt -nvo SOURCE /)" "$TOP"
  for old in "$TOP"/@home.erased.*; do
    [[ -d $old ]] || continue
    btrfs subvolume delete -R "$old" >/dev/null ||
      die "Couldn't delete the old home; the next boot tries again."
  done
  umount "$TOP"
  rmdir "$TOP"
}

# All of erasing but home itself, the same at `run` and at a boot that
# finishes one.
erase_rest() {
  local part
  wipe_system
  part=$(luks_partition)
  if [[ -n $part ]]; then
    forget_disk_password "$part"
    mkdir -p "$(dirname "$SETUP_MARK")"
    touch "$SETUP_MARK"
  fi
  usermod -p '!' "$USER_NAME"
  pristine_boot "$(dirname "$SETUP_KEY")"
  delete_old_homes
  rm -f "$MARK"
  sync
}

# The boot screen, saying what's happening, where Din was.
show_erasing() {
  plymouth quit 2>/dev/null || true
  plymouthd --mode=shutdown --tty=tty1 --kernel-command-line="quiet splash plymouth.ignore-serial-consoles" || return 0
  plymouth show-splash || true
  plymouth display-message --text="din-status:Erasing…" || true
}

run() {
  [[ -e $MARK ]] || die "Nothing is marked to be erased."
  # Whatever the isolate left of the user's.
  pkill -KILL -u "$USER_NAME" 2>/dev/null || true
  show_erasing
  replace_home
  # The old home has to be unmounted to be deleted; if something still
  # holds it, the next boot deletes it.
  umount -R /home 2>/dev/null || umount -l /home || true
  erase_rest
}

finish() {
  erase_rest
}

case "${1:-}" in
  status) status ;;
  start) start ;;
  mark) mark ;;
  run) run ;;
  finish) finish ;;
  *) die "usage: din-erase status | start | mark | run | finish" ;;
esac

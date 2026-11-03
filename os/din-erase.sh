# din-erase: the privileged half of Settings → About's Erase All Data.
#
# Erasing puts the computer back as the Installer left it, running official
# DinOS: no files, accounts, apps, saved networks or settings, and on an
# encrypted disk no password, which the Setup screen asks for before the
# desktop starts (din-password setup). Nothing that runs from home can stay
# running while home goes, so it's done over a restart:
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
#       then does `mark`.
#   din-erase mark
#       Mark the disk to be erased (MARK) and restart. Root's alone, without
#       start's checks, for tests.
#   din-erase finish
#       din-erase-finish.service, at the boot after `mark`, once the initrd
#       has put an empty home in place of the old one and emptied the
#       system's own record of the user (dinos-erase, configuration.nix),
#       and before anything that reads what it emptied starts. On an
#       encrypted disk, the passphrase typed at the boot screen gives way to
#       a key on the boot partition (SETUP_KEY), which the initrd unlocks
#       the disk with until Setup sets the new password, and any other way
#       in (keyslots, tokens) goes. `din` loses its password, the boot
#       screen its wallpaper and layout, and the old home is deleted.
#
# A boot that stops partway leaves MARK, and the next one does it all again.

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

mark() {
  mkdir -p "$(dirname "$MARK")"
  echo erase >"$MARK"
  sync
  systemctl reboot
}

start() {
  is_live && die "DinOS running from a USB stick isn't erased; it starts fresh without its files on another computer."
  is_btrfs_install || die "This DinOS was installed before your files were kept apart from the system. Reinstall it from a USB stick, erasing the disk, to start over."
  if has_password; then
    din-password check || exit 1
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
  mark
}

# The keyslot key file $1 opens on partition $2.
slot_of() {
  { cryptsetup open --test-passphrase --verbose --key-file="$1" "$2" 2>&1 || true; } |
    sed -n 's/^Key slot \([0-9]*\) unlocked.*/\1/p' | head -n1
}

# The disk's keys: only SETUP_KEY opens it once this is done. The
# passphrase comes from the boot screen, which left it in root's keyring
# (as for nostrd-unlock); systemd may have left more than one, apart by NULs.
forget_disk_password() {
  local part=$1 id slot other token added=false
  mkdir -p "$(dirname "$SETUP_KEY")"
  if [[ ! -s $SETUP_KEY ]] || [[ -z $(slot_of "$SETUP_KEY" "$part") ]]; then
    id=$(keyctl search @u user cryptsetup 2>/dev/null) ||
      die "The disk's passphrase wasn't typed at this boot, so its keys can't be changed."
    head -c 64 /dev/urandom >"$SETUP_KEY.tmp"
    sync "$SETUP_KEY.tmp"
    mv -f "$SETUP_KEY.tmp" "$SETUP_KEY"
    local passphrase
    while IFS= read -r -d '' passphrase || [[ -n $passphrase ]]; do
      if printf '%s' "$passphrase" | cryptsetup luksAddKey --batch-mode --key-file=- "$part" "$SETUP_KEY" 2>/dev/null; then
        added=true
        break
      fi
    done < <(keyctl pipe "$id")
    $added || die "The passphrase typed at this boot doesn't open the disk."
  fi
  slot=$(slot_of "$SETUP_KEY" "$part")
  [[ -n $slot ]] || die "The setup key doesn't open the disk."
  for other in $(cryptsetup luksDump --dump-json-metadata "$part" | jq -r '.keyslots | keys[]'); do
    [[ $other == "$slot" ]] && continue
    cryptsetup luksKillSlot --batch-mode --key-file="$SETUP_KEY" "$part" "$other"
  done
  for token in $(cryptsetup luksDump --dump-json-metadata "$part" | jq -r '.tokens | keys[]'); do
    cryptsetup token remove --token-id "$token" "$part"
  done
  if id=$(keyctl search @u user cryptsetup 2>/dev/null); then
    keyctl unlink "$id" @u >/dev/null
  fi
  mkdir -p "$(dirname "$SETUP_MARK")"
  touch "$SETUP_MARK"
}

finish() {
  local part old
  part=$(luks_partition)
  if [[ -n $part ]]; then
    forget_disk_password "$part"
  fi
  usermod -p '!' "$USER_NAME"
  # What the boot screen showed of the user's, but for the setup key.
  if [[ -d $(dirname "$SETUP_KEY") ]]; then
    for old in "$(dirname "$SETUP_KEY")"/*; do
      [[ $old == "$SETUP_KEY" ]] || rm -rf "$old"
    done
  fi
  # The old homes the initrd set aside. Btrfs frees their space in the
  # background.
  mkdir -p "$TOP"
  mount -o subvolid=5 "$(findmnt -nvo SOURCE /)" "$TOP"
  for old in "$TOP"/@home.erased.*; do
    [[ -d $old ]] && btrfs subvolume delete -R "$old" >/dev/null
  done
  umount "$TOP"
  rmdir "$TOP"
  rm -f "$MARK"
  sync
}

case "${1:-}" in
  status) status ;;
  start) start ;;
  mark) mark ;;
  finish) finish ;;
  *) die "usage: din-erase status | start | mark | finish" ;;
esac

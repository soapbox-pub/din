# din-install: the privileged half of Din's Installer app.
#
# DinOS boots from a USB stick as a live system; this copies that running
# system onto a computer's own disk. Din runs it through sudo from
# electron/installer.mts.
#
#   din-install status
#       JSON: whether this is a live boot, the space an install needs, and
#       the disks it could go on.
#   din-install install <disk> wipe|free|keep|oem [encrypt]
#       Install onto <disk>: `wipe` erases it, `free` goes into its largest
#       stretch of unpartitioned space (next to Windows, say), and `keep`
#       replaces the DinOS already on it, leaving its home alone.
#       With `encrypt`, a passphrase is read from stdin: for a new install the
#       system partition is LUKS2 under it, asked for at every boot, and for
#       `keep` it unlocks the existing one. `oem` erases the disk and sets
#       it up for someone else: as if installed and then erased
#       (os/din-erase.sh), with nothing of the live session's, encrypted
#       under a new random key on the boot partition (SETUP_KEY) that opens
#       it without asking until Setup, at the first start, takes its owner's
#       password in its place (din-password setup). Reports on stdout as it goes -
#       `step <name>` and `progress <percent>` lines - and exits non-zero with
#       the reason on stderr if it can't.
#
# Every install has the same layout: an ESP, and a system partition holding
# (under the encryption, if any) a Btrfs filesystem with an `@` subvolume
# for the system, its default, and `@home` for home, sharing the disk's
# space between them. Both are compressed with zstd, set as a property that
# new files inherit, so it needs no mount options. A reinstall builds a new
# system in `@new` beside the old one and swaps it in once it's complete,
# leaving `@home` as it is: until then the old system still boots.
#
# Installs from before Btrfs have, in place of the filesystem, an LVM volume
# group `dinos` with an ext4 `root` volume for the system and an ext4 `home`
# volume taking the rest; a reinstall of one formats root and leaves home.
# The group has autoactivation off: DinOS's initrd brings it up only on the
# disk it booted from (see configuration.nix), and every LVM command here is
# confined with --devices, so a second DinOS disk in the same computer never
# gets confused for it.
#
# The installed system is a file-level copy of the live one: the same Nix
# store, the same boot entries, and the session (sign-in, saved WiFi) the user
# set up while trying it - or, for a reinstall, the session already on the
# disk. The system partition has the GPT root type, so it's found through
# auto-discovery (the root partition on the disk the boot loader came from),
# and boots the same whichever disk it's on, even with the stick still
# plugged in.

ROOT_TYPE=4f68bce3-e8cd-4db1-96e7-fbcaf984b709 # Linux root (x86-64)
# The system partition's LUKS mapping while installing. Not `root`: udev
# would take that for this system's own root (see configuration.nix).
CRYPT_NAME=dinos-install
FS_LABEL=DinOS
VG=dinos
ESP_TYPE=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
ESP_LABEL="DinOS boot"
MIB=$((1024 * 1024))
GIB=$((1024 * MIB))
ESP_BYTES=$((512 * MIB))
# The smallest disk (or free stretch) DinOS goes on: the system, the old ones
# kept for the boot menu (configuration.nix), and files worth having. Sold as
# "64 GB", a drive holds ~59 GiB.
MIN_INSTALL_BYTES=$((56 * GIB))
# Room for apps and system updates beyond the live system's own footprint.
HEADROOM_BYTES=$((8 * GIB))
# What a reinstall carries over from the old root, besides home: saved WiFi,
# Bluetooth pairings, the keyboard layout, the Nostr account keys (nostrd's
# store), the machine's identity, and NixOS's record of the ids it handed
# out (which files in home are owned by).
KEEP_PATHS=(
  etc/NetworkManager/system-connections
  var/lib/bluetooth
  var/lib/din/keyboard
  var/lib/nostrd
  var/lib/nixos
  etc/machine-id
)
# An `oem` install's key, as os/din-erase.sh leaves an erased disk's, and
# the mark that has Din show Setup until the computer has a password.
SETUP_KEY=din/setup.key
SETUP_MARK=var/lib/din/setup

die() {
  echo "$*" >&2
  exit 1
}

# The whole disk the running system's root lives on, e.g. /dev/sdb.
boot_disk() {
  local root
  root=$(findmnt -nvo SOURCE /)
  echo "/dev/$(lsblk -no PKNAME "$root" | head -n1)"
}

# Booted from a USB stick or other removable media - the only time installing
# is offered. An installed system never copies itself onto other disks.
is_live() {
  local name=${1#/dev/}
  [[ $(cat "/sys/block/$name/removable" 2>/dev/null) == 1 ]] ||
    [[ $(lsblk -dno TRAN "$1") == usb ]]
}

# The live system's ESP: the one the boot loader ran from, or failing that
# the first on the boot disk.
boot_esp() {
  if [[ -b /dev/disk/dinos-esp ]]; then
    readlink -f /dev/disk/dinos-esp
    return
  fi
  lsblk -lnpo NAME,PARTTYPE "$1" | awk -v t="$ESP_TYPE" 'tolower($2) == t { print $1; exit }'
}

used_bytes() {
  df -B1 --output=used / | tail -n1
}

required_bytes() {
  local need=$(($(used_bytes) + HEADROOM_BYTES + ESP_BYTES))
  echo $((need > MIN_INSTALL_BYTES ? need : MIN_INSTALL_BYTES))
}

# Disks an install could go on: writable, real, and not the one we booted from.
candidate_disks() {
  lsblk -dbnpo NAME,TYPE,RO,SIZE | while read -r name type ro size; do
    [[ $type == disk && $ro == 0 && $size -gt 0 ]] || continue
    [[ $name =~ ^/dev/(zram|loop|ram) ]] && continue
    [[ $name == "$1" ]] && continue
    echo "$name"
  done
}

# Unpartitioned stretches of a GPT disk, MiB-aligned, as "start sectors"
# lines (in the disk's logical sectors).
free_regions() {
  local disk=$1 ss align
  [[ $(lsblk -dno PTTYPE "$disk") == gpt ]] || return 0
  ss=$(blockdev --getss "$disk")
  align=$((MIB / ss))
  sfdisk -F "$disk" 2>/dev/null | awk -v a="$align" '
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
      s = int(($1 + a - 1) / a) * a
      n = int(($2 + 1 - s) / a) * a
      if (n > 0) print s, n
    }'
}

# The largest free region, "start sectors", or nothing.
largest_free_region() {
  free_regions "$1" | sort -k2,2n | tail -n1
}

largest_free_bytes() {
  local region ss
  region=$(largest_free_region "$1")
  [[ -n $region ]] || { echo 0; return; }
  ss=$(blockdev --getss "$1")
  echo $(( ${region#* } * ss ))
}

# The DinOS install on a disk that a reinstall can keep the files of, as
# "partition plain|encrypted", or nothing. That's the disk's first root
# partition (the one auto-discovery would boot) holding DinOS's Btrfs or the
# `dinos` group - which, encrypted, can only be told once it's unlocked. A
# DinOS installed before home had its own volume is ext4 straight on the
# partition, and doesn't count.
dinos_install() {
  local part fstype label
  read -r part fstype label < <(lsblk -Jpo NAME,PARTTYPE,FSTYPE,LABEL "$1" | jq -r --arg t "$ROOT_TYPE" '
    [.blockdevices[0].children // [] | .[] | select((.parttype // "" | ascii_downcase) == $t)]
    | first // empty | "\(.name) \(.fstype // "-") \(.label // "-")"') || true
  [[ -n ${part:-} ]] || return 0
  case $fstype in
    crypto_LUKS) echo "$part encrypted" ;;
    btrfs) [[ $label != "$FS_LABEL" ]] || echo "$part plain" ;;
    LVM2_member)
      if [[ $(lvm pvs --devices "$part" --noheadings -o vg_name 2>/dev/null | tr -d ' ') == "$VG" ]]; then
        echo "$part plain"
      fi
      ;;
  esac
}

# The ESP a DinOS install on this disk made for itself.
dinos_esp() {
  lsblk -Jpo NAME,PARTTYPE,PARTLABEL "$1" | jq -r --arg t "$ESP_TYPE" --arg l "$ESP_LABEL" '
    [.blockdevices[0].children // [] | .[] | select((.parttype // "" | ascii_downcase) == $t and .partlabel == $l)]
    | first // empty | .name'
}

disk_json() {
  local disk=$1 existing="null" found
  found=$(dinos_install "$disk")
  if [[ -n $found ]]; then
    existing=$(jq -n --argjson e "$([[ ${found#* } == encrypted ]] && echo true || echo false)" '{encrypted: $e}')
  fi
  lsblk -Jbpo NAME,SIZE,MODEL,VENDOR,TRAN,RM,PTTYPE,PARTTYPE,PARTLABEL,FSTYPE,LABEL,MOUNTPOINTS "$disk" |
    jq --argjson free "$(largest_free_bytes "$disk")" --arg root "$ROOT_TYPE" --argjson existing "$existing" '
      .blockdevices[0] as $d
      | ($d.children // []) as $parts
      | {
          path: $d.name,
          model: ([$d.vendor, $d.model] | map(select(. != null) | gsub("^\\s+|\\s+$"; "")) | map(select(. != "")) | join(" ")),
          sizeBytes: $d.size,
          transport: ($d.tran // ""),
          removable: ($d.rm == true or $d.rm == "1"),
          partitionTable: $d.pttype,
          largestFreeBytes: $free,
          inUse: any($d | .. | objects | .mountpoints? // [] | .[]; . != null and (startswith("/run/media/") | not)),
          hasLinuxRoot: any($parts[]; (.parttype // "" | ascii_downcase) == $root),
          existingInstall: $existing,
          partitions: [$parts[] | {
            path: .name,
            label: (.partlabel // .label // ""),
            fsType: (.fstype // ""),
            sizeBytes: .size
          }]
        }'
}

status() {
  local boot live=false disks=()
  boot=$(boot_disk)
  is_live "$boot" && live=true
  while read -r disk; do
    disks+=("$(disk_json "$disk")")
  done < <(candidate_disks "$boot")
  jq -n --argjson live "$live" --arg boot "$boot" --argjson required "$(required_bytes)" \
    '{live: $live, bootDisk: $boot, requiredBytes: $required, disks: $ARGS.positional}' \
    --jsonargs "${disks[@]}"
}

step() {
  echo "step $1"
}

# Partition device nodes of a disk ordered by position, "node start" lines.
partitions_by_start() {
  sfdisk -J "$1" 2>/dev/null | jq -r '.partitiontable.partitions // [] | sort_by(.start) | .[] | "\(.node) \(.start)"'
}

# Take down whatever is stacked on a disk's partitions - volumes first, then
# the encryption under them - so they can be repartitioned or reformatted.
release_disk() {
  local name type
  lsblk -lnpo NAME,TYPE "$1" | tac | while read -r name type; do
    if [[ $type == lvm || $type == crypt ]]; then
      dmsetup remove "$name" || die "$name on $1 is in use."
    fi
  done
}

target=""
top=""
source_esp=""
old_root=""
crypt_open=""
vg_devices=""
key_file=""
cleanup() {
  if [[ -n $key_file ]]; then
    rm -f "$key_file"
  fi
  if [[ -n $target ]]; then
    umount -R "$target" 2>/dev/null || true
    rmdir "$target" 2>/dev/null || true
  fi
  if [[ -n $old_root ]]; then
    umount "$old_root" 2>/dev/null || true
    rmdir "$old_root" 2>/dev/null || true
  fi
  if [[ -n $top ]]; then
    umount "$top" 2>/dev/null || true
    rmdir "$top" 2>/dev/null || true
  fi
  if [[ -n $vg_devices ]]; then
    lvm vgchange -q --activate n --devices "$vg_devices" "$VG" >/dev/null 2>&1 || true
  fi
  if [[ -n $crypt_open ]]; then
    cryptsetup close "$CRYPT_NAME" 2>/dev/null || true
  fi
  if [[ -n $source_esp ]]; then
    umount "$source_esp" 2>/dev/null || true
    rmdir "$source_esp" 2>/dev/null || true
  fi
}

# Open the system partition's encryption, when it has some, setting `dev` to
# the device the filesystem (or LVM) lives on: with `key_file` when there
# is one, else the passphrase.
open_system() {
  local part=$1 passphrase=$2
  dev=$part
  if [[ -n $key_file ]]; then
    cryptsetup open --key-file="$key_file" "$part" "$CRYPT_NAME" ||
      die "The disk's new key doesn't unlock it."
    crypt_open=1
    dev=/dev/mapper/$CRYPT_NAME
  elif [[ -n $passphrase ]]; then
    # printf is a builtin: the passphrase never shows up in a command line.
    printf '%s' "$passphrase" | cryptsetup open --key-file=- "$part" "$CRYPT_NAME" ||
      die "That passphrase doesn't unlock the disk."
    crypt_open=1
    dev=/dev/mapper/$CRYPT_NAME
  fi
}

# Mount the Btrfs filesystem's top level, where its subvolumes are, at `top`.
mount_top() {
  top=$(mktemp -d /run/din-install-top.XXXXXX)
  mount -o subvolid=5 "$1" "$top"
}

# Copy what a reinstall keeps from the old root into a stash under /run, once
# per install: a retry after the old root was already formatted reuses it.
# The old root is mounted from device $2 with options $3.
stash_old_root() {
  local stash=$1 path
  [[ -d $stash ]] && return
  rm -rf "$stash.partial"
  mkdir -p "$(dirname "$stash")"
  mkdir -m 700 "$stash.partial"
  old_root=$(mktemp -d /run/din-install-old.XXXXXX)
  if mount -o "ro${3:+,$3}" "$2" "$old_root" 2>/dev/null; then
    for path in "${KEEP_PATHS[@]}"; do
      [[ -e $old_root/$path ]] || continue
      mkdir -p "$stash.partial/$(dirname "$path")"
      cp -a "$old_root/$path" "$stash.partial/$path"
    done
    umount "$old_root"
  else
    echo "The old system couldn't be read; saved WiFi networks and Bluetooth devices won't carry over." >&2
  fi
  rmdir "$old_root"
  old_root=""
  mv "$stash.partial" "$stash"
}

# Make `din`'s password (for sudo) the disk's passphrase, in the new root.
set_din_password() {
  local root=$1 passphrase=$2 hash shadow
  shadow=$root/etc/shadow
  hash=$(printf '%s' "$passphrase" | openssl passwd -6 -stdin)
  awk -F: -v OFS=: -v hash="$hash" '$1 == "din" { $2 = hash } { print }' "$shadow" >"$shadow.din-install"
  chown --reference="$shadow" "$shadow.din-install"
  chmod --reference="$shadow" "$shadow.din-install"
  mv "$shadow.din-install" "$shadow"
}

# Put nostrd's store, with the account keys added while running live, under
# the disk's passphrase, so it unlocks with the disk at boot. A store kept
# from the old system already has it.
protect_nostrd() {
  local dir=$1/var/lib/nostrd passphrase=$2
  if [[ $(jq -r '.master.protection // empty' "$dir/store.json" 2>/dev/null) != password ]]; then
    printf '%s\n' "$passphrase" | nostrd set-password --state-dir "$dir" ||
      die "Couldn't protect the account keys with the passphrase."
  fi
  chown -R nostrd:nostrd "$dir"
}

# Leave the new root at $1, and its boot partition at $1/boot, as an erased
# computer's (os/din-erase.sh): nothing of the live session's, no password,
# Setup to come, and the disk's key where the initrd finds it.
make_pristine() {
  local root=$1 shadow=$1/etc/shadow
  pristine_system "$root"
  pristine_boot "$root/boot/$(dirname "$SETUP_KEY")"
  mkdir -p "$root/boot/$(dirname "$SETUP_KEY")"
  cp "$key_file" "$root/boot/$SETUP_KEY"
  awk -F: -v OFS=: '$1 == "din" { $2 = "!" } { print }' "$shadow" >"$shadow.din-install"
  chown --reference="$shadow" "$shadow.din-install"
  chmod --reference="$shadow" "$shadow.din-install"
  mv "$shadow.din-install" "$shadow"
  mkdir -p "$(dirname "$root/$SETUP_MARK")"
  touch "$root/$SETUP_MARK"
}

install() {
  local disk=$1 mode=$2 encrypt=$3 boot required ss json esp part before passphrase="" dev stash="" layout=btrfs oem=""
  boot=$(boot_disk)
  is_live "$boot" || die "DinOS can only be installed while running from a USB stick."
  grep -qxF -- "$disk" <<<"$(candidate_disks "$boot")" || die "$disk is not a disk DinOS can be installed on."
  [[ $mode == wipe || $mode == free || $mode == keep || $mode == oem ]] || die "Unknown install mode: $mode"
  if [[ $mode == oem ]]; then
    [[ $encrypt != encrypt ]] || die "Setting up for someone else makes its own key; it takes no passphrase."
    # Partitioned as `wipe`, then made pristine.
    oem=1
    mode=wipe
  elif [[ $encrypt == encrypt ]]; then
    passphrase=$(cat)
    [[ -n $passphrase ]] || die "Encrypting the disk needs a passphrase."
  fi

  json=$(disk_json "$disk")
  # Status lets a disk Din mounted on its own (under /run/media) through:
  # Din unmounts it before it starts this. Nothing may be mounted by now.
  [[ -z $(lsblk -nro MOUNTPOINTS "$disk" | tr -d '[:space:]') ]] || die "A partition on $disk is in use."
  required=$(required_bytes)
  ss=$(blockdev --getss "$disk")

  trap cleanup EXIT

  step partition
  udevadm settle
  release_disk "$disk"
  # An old install's volumes are about to be opened by name.
  [[ ! -e /dev/mapper/$VG-root && ! -e /dev/mapper/$VG-home ]] ||
    die "Another disk's DinOS is open. Restart and try again."
  if [[ $mode == keep ]]; then
    local found kind
    found=$(dinos_install "$disk")
    [[ -n $found ]] || die "There's no DinOS on $disk whose files can be kept."
    part=${found% *}
    kind=${found#* }
    if [[ $kind == encrypted && -z $passphrase ]]; then
      die "DinOS on $disk is encrypted; its passphrase is needed to reinstall it."
    fi
    [[ $kind == encrypted ]] || passphrase=""
    esp=$(dinos_esp "$disk")
    [[ -b $esp ]] || die "Couldn't find DinOS's boot partition on $disk."
    open_system "$part" "$passphrase"
    stash=/run/din-install-keep/$(lsblk -no PARTUUID "$part")
    case $(blkid -p -o value -s TYPE "$dev") in
      btrfs)
        mount_top "$dev"
        # An earlier attempt that stopped while swapping systems.
        [[ -d $top/@ || ! -d $top/@old ]] || mv "$top/@old" "$top/@"
        [[ -d $top/@ && -d $top/@home ]] || die "DinOS's subvolumes on $disk aren't all there."
        stash_old_root "$stash" "$dev" subvol=@
        ;;
      LVM2_member)
        [[ $(lvm pvs --devices "$dev" --noheadings -o vg_name 2>/dev/null | tr -d ' ') == "$VG" ]] ||
          die "DinOS's volumes on $disk aren't all there."
        layout=lvm
        lvm vgchange -q --activate y --devices "$dev" "$VG" >/dev/null
        vg_devices=$dev
        [[ -b /dev/mapper/$VG-root && -b /dev/mapper/$VG-home ]] ||
          die "DinOS's volumes on $disk aren't all there."
        stash_old_root "$stash" "/dev/mapper/$VG-root"
        ;;
      *) die "This DinOS was installed before your files were kept apart from the system, so they can't be kept. Erase the disk to reinstall." ;;
    esac
  elif [[ $mode == wipe ]]; then
    (( $(jq '.sizeBytes' <<<"$json") >= required )) || die "$disk is too small for DinOS."
    wipefs -aq "$disk"
    printf 'label: gpt\nsize=%s, type=%s, name="%s"\ntype=%s, name="DinOS"\n' \
      $((ESP_BYTES / ss)) "$ESP_TYPE" "$ESP_LABEL" "$ROOT_TYPE" |
      sfdisk -q --wipe always --wipe-partitions always "$disk"
  else
    [[ $(jq -r '.partitionTable' <<<"$json") == gpt ]] ||
      die "Installing alongside another system needs a GPT disk."
    # GPT auto-discovery takes the first root partition on the boot disk,
    # which could be the other system's.
    [[ $(jq '.hasLinuxRoot' <<<"$json") == false ]] ||
      die "$disk already has a Linux system on it. DinOS can't be installed alongside another Linux system yet."
    local region start sectors esp_sectors
    region=$(largest_free_region "$disk")
    [[ -n $region ]] || die "$disk has no unpartitioned space."
    start=${region% *}
    sectors=${region#* }
    (( sectors * ss >= required )) || die "$disk doesn't have enough unpartitioned space for DinOS."
    esp_sectors=$((ESP_BYTES / ss))
    before=$(partitions_by_start "$disk")
    printf 'start=%s, size=%s, type=%s, name="%s"\nstart=%s, size=%s, type=%s, name="DinOS"\n' \
      "$start" "$esp_sectors" "$ESP_TYPE" "$ESP_LABEL" \
      $((start + esp_sectors)) $((sectors - esp_sectors)) "$ROOT_TYPE" |
      sfdisk -q --append --wipe-partitions always "$disk"
  fi
  udevadm settle

  if [[ $mode != keep ]]; then
    # The two partitions just made are the ones that weren't there before;
    # the ESP comes first.
    local created
    created=$(comm -13 <(sort <<<"${before:-}") <(partitions_by_start "$disk" | sort) | sort -k2,2n | cut -d' ' -f1)
    esp=$(sed -n 1p <<<"$created")
    part=$(sed -n 2p <<<"$created")
    [[ -b $esp && -b $part ]] || die "The new partitions on $disk didn't appear."
  fi

  step format
  if [[ $layout == lvm ]]; then
    mkfs.ext4 -q -F -L nixos "/dev/mapper/$VG-root"
  else
    if [[ $mode != keep ]]; then
      if [[ -n $oem ]]; then
        key_file=$(mktemp /run/din-install-key.XXXXXX)
        head -c 64 /dev/urandom >"$key_file"
        cryptsetup luksFormat -q --type luks2 --label DinOS --key-file="$key_file" "$part"
      elif [[ -n $passphrase ]]; then
        printf '%s' "$passphrase" |
          cryptsetup luksFormat -q --type luks2 --label DinOS --key-file=- "$part"
      fi
      open_system "$part" "$passphrase"
      mkfs.btrfs -q -f -L "$FS_LABEL" "$dev"
      mount_top "$dev"
      btrfs subvolume create "$top/@home" >/dev/null
      btrfs property set "$top/@home" compression zstd
    fi
    # What's left of an earlier attempt.
    [[ ! -d $top/@new ]] || btrfs subvolume delete -R "$top/@new" >/dev/null
    btrfs subvolume create "$top/@new" >/dev/null
    btrfs property set "$top/@new" compression zstd
    # /tmp is a subvolume of its own inside the system's, so a snapshot of
    # the system leaves what's passing through it out.
    btrfs subvolume create "$top/@new/tmp" >/dev/null
    chmod 1777 "$top/@new/tmp"
  fi

  target=$(mktemp -d /run/din-install.XXXXXX)
  if [[ $layout == lvm ]]; then
    mount "/dev/mapper/$VG-root" "$target"
  else
    mount -o subvol=@new "$dev" "$target"
  fi
  mkdir "$target/boot" "$target/home"
  # A reinstall never mounts home: nothing below can touch it.
  if [[ $mode != keep ]]; then
    mount -o subvol=@home "$dev" "$target/home"
  fi

  step copy
  local excludes=(
    --exclude='/proc/*' --exclude='/sys/*' --exclude='/dev/*' --exclude='/run/*'
    --exclude='/tmp/*' --exclude='/boot' --exclude='/mnt/*' --exclude='/media/*'
    --exclude='/var/tmp/*' --exclude='/var/cache/*' --exclude='/var/log/journal/*'
    --exclude='/home/*/.cache/*' --exclude='/home/.nix-build/*' --exclude='/lost+found'
  )
  [[ $mode != keep && -z $oem ]] || excludes+=(--exclude='/home/*')
  # Btrfs's own properties, the compression above all, are the new
  # filesystem's: rsync leaves the ones files inherit in place.
  excludes+=(--filter='-x btrfs.*')
  # rsync's overall progress, as whole percents.
  set +e
  rsync -aHAX --numeric-ids --no-inc-recursive --info=progress2 "${excludes[@]}" / "$target/" |
    awk -v RS='[\r\n]+' '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { sub("%", "", $i); if ($i != last) { print "progress", $i; fflush(); last = $i } } }'
  local rc=${PIPESTATUS[0]}
  set -e
  # 24: files vanished mid-copy (caches, sockets) - expected from a live system.
  [[ $rc == 0 || $rc == 24 ]] || die "Copying the system failed (rsync exit $rc)."

  step boot
  # Only formatted now, so a reinstall that fails before this leaves the old
  # system as it was.
  mkfs.vfat -F 32 -n DINOS "$esp" >/dev/null
  mount -o umask=0077 "$esp" "$target/boot"
  # The live ESP is usually mounted at /boot already, which rules out a
  # second, read-only mount of it.
  local live_esp esp_dir
  live_esp=$(boot_esp "$boot")
  [[ -b $live_esp ]] || die "Couldn't find the USB stick's boot partition."
  esp_dir=$(findmnt -nfo TARGET --source "$live_esp" || true)
  if [[ -z $esp_dir ]]; then
    source_esp=$(mktemp -d /run/din-install-esp.XXXXXX)
    mount -o ro "$live_esp" "$source_esp"
    esp_dir=$source_esp
  fi
  cp -r "$esp_dir/." "$target/boot/"
  # systemd-boot's seed is per machine, like the ones below.
  rm -f "$target/boot/loader/random-seed"

  # Per-machine identity is made fresh on first boot, not cloned.
  if [[ -f $target/etc/machine-id && ! -L $target/etc/machine-id ]]; then
    : >"$target/etc/machine-id"
  fi
  rm -f "$target/var/lib/systemd/random-seed"

  # A reinstall is the same machine as before: its identity, networks, and
  # devices come back over what the live session had.
  if [[ -n $stash ]]; then
    local path
    for path in "${KEEP_PATHS[@]}"; do
      [[ -e $stash/$path ]] || continue
      mkdir -p "$target/$(dirname "$path")"
      if [[ -d $stash/$path ]]; then
        mkdir -p "$target/$path"
        cp -a "$stash/$path/." "$target/$path/"
      else
        cp -a "$stash/$path" "$target/$path"
      fi
    done
  fi

  # One password for the computer: on an encrypted disk, the passphrase that
  # unlocks it is also `din`'s and the account keys'.
  if [[ -n $passphrase ]]; then
    set_din_password "$target" "$passphrase"
    protect_nostrd "$target" "$passphrase"
  fi
  if [[ -n $oem ]]; then
    make_pristine "$target"
  fi

  # Put DinOS first in the firmware's boot order. Firmware also boots the
  # ESP's removable path on its own, so a refusal here isn't fatal.
  if [[ -d /sys/firmware/efi/efivars ]]; then
    efibootmgr 2>/dev/null | awk '$1 ~ /^Boot[0-9A-Fa-f]{4}\*?$/ && $2 == "DinOS" { print substr($1, 5, 4) }' |
      while read -r num; do efibootmgr -q -b "$num" -B || true; done
    efibootmgr -q -c -d "$disk" -p "$(lsblk -no PARTN "$esp")" -L DinOS \
      -l '\EFI\BOOT\BOOTX64.EFI' || echo "Couldn't add a firmware boot entry." >&2
  fi

  sync
  if [[ $layout == btrfs ]]; then
    umount -R "$target"
    # The new system replaces the old one, if any, and becomes the default:
    # what the initrd mounts as root.
    [[ ! -d $top/@ ]] || mv "$top/@" "$top/@old"
    mv "$top/@new" "$top/@"
    btrfs subvolume set-default "$top/@"
    [[ ! -d $top/@old ]] || btrfs subvolume delete -R "$top/@old" >/dev/null
    sync
  fi
  cleanup
  target=""
  top=""
  vg_devices=""
  crypt_open=""
  source_esp=""
  step finished
}

case "${1:-}" in
  status) status ;;
  install)
    [[ $# == 3 || ($# == 4 && $4 == encrypt) ]] || die "usage: din-install install <disk> wipe|free|keep|oem [encrypt]"
    install "$2" "$3" "${4:-}"
    ;;
  *) die "usage: din-install status | install <disk> wipe|free|keep|oem [encrypt]" ;;
esac

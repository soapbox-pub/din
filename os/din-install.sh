# din-install: the privileged half of Din's Installer app.
#
# DinOS boots from a USB stick as a live system; this copies that running
# system onto a computer's own disk. Din runs it through sudo from
# electron/installer.mts.
#
#   din-install status
#       JSON: whether this is a live boot, the space an install needs, and
#       the disks it could go on.
#   din-install install <disk> wipe|free|keep [encrypt]
#       Install onto <disk>: `wipe` erases it, `free` goes into its largest
#       stretch of unpartitioned space (next to Windows, say), and `keep`
#       replaces the DinOS already on it, leaving its home volume alone.
#       With `encrypt`, a passphrase is read from stdin: for a new install the
#       system partition is LUKS2 under it, asked for at every boot, and for
#       `keep` it unlocks the existing one. Reports on stdout as it goes -
#       `step <name>` and `progress <percent>` lines - and exits non-zero with
#       the reason on stderr if it can't.
#
# Every install has the same layout: an ESP, and a system partition holding
# (under the encryption, if any) an LVM volume group `dinos` with a `root`
# volume for the system and a `home` volume taking the rest. A reinstall
# formats root and leaves home as it is. The group has autoactivation off:
# DinOS's initrd brings it up only on the disk it booted from (see
# configuration.nix), and every LVM command here is confined with --devices,
# so a second DinOS disk in the same computer never gets confused for it.
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
VG=dinos
ESP_TYPE=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
ESP_LABEL="DinOS boot"
MIB=$((1024 * 1024))
GIB=$((1024 * MIB))
ESP_BYTES=$((512 * MIB))
# The smallest disk (or free stretch) DinOS goes on, enough for the smallest
# root plus a home worth having. Sold as "128 GB", a drive holds ~119 GiB.
MIN_INSTALL_BYTES=$((100 * GIB))
# Root gets a quarter of the space within these bounds; home gets the rest.
# With old systems collected (configuration.nix), 128 GiB is room to spare.
ROOT_MIN_BYTES=$((48 * GIB))
ROOT_MAX_BYTES=$((128 * GIB))
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
# partition (the one auto-discovery would boot) holding the `dinos` group -
# which, encrypted, can only be told once it's unlocked. A DinOS installed
# before home had its own volume is ext4 straight on the partition, and
# doesn't count.
dinos_install() {
  local part fstype
  read -r part fstype < <(lsblk -Jpo NAME,PARTTYPE,FSTYPE "$1" | jq -r --arg t "$ROOT_TYPE" '
    [.blockdevices[0].children // [] | .[] | select((.parttype // "" | ascii_downcase) == $t)]
    | first // empty | "\(.name) \(.fstype // "")"') || true
  [[ -n ${part:-} ]] || return 0
  case $fstype in
    crypto_LUKS) echo "$part encrypted" ;;
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
source_esp=""
old_root=""
crypt_open=""
vg_devices=""
cleanup() {
  if [[ -n $target ]]; then
    umount -R "$target" 2>/dev/null || true
    rmdir "$target" 2>/dev/null || true
  fi
  if [[ -n $old_root ]]; then
    umount "$old_root" 2>/dev/null || true
    rmdir "$old_root" 2>/dev/null || true
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

# Open the system partition's encryption, when it has some, setting `pv` to
# the device LVM lives on.
open_system() {
  local part=$1 passphrase=$2
  pv=$part
  if [[ -n $passphrase ]]; then
    # printf is a builtin: the passphrase never shows up in a command line.
    printf '%s' "$passphrase" | cryptsetup open --key-file=- "$part" "$CRYPT_NAME" ||
      die "That passphrase doesn't unlock the disk."
    crypt_open=1
    pv=/dev/mapper/$CRYPT_NAME
  fi
}

# Copy what a reinstall keeps from the old root into a stash under /run, once
# per install: a retry after the old root was already formatted reuses it.
stash_old_root() {
  local stash=$1 path
  [[ -d $stash ]] && return
  rm -rf "$stash.partial"
  mkdir -p "$(dirname "$stash")"
  mkdir -m 700 "$stash.partial"
  old_root=$(mktemp -d /run/din-install-old.XXXXXX)
  if mount -o ro /dev/mapper/$VG-root "$old_root" 2>/dev/null; then
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

install() {
  local disk=$1 mode=$2 encrypt=$3 boot required ss json esp part before passphrase="" pv stash=""
  boot=$(boot_disk)
  is_live "$boot" || die "DinOS can only be installed while running from a USB stick."
  grep -qxF -- "$disk" <<<"$(candidate_disks "$boot")" || die "$disk is not a disk DinOS can be installed on."
  [[ $mode == wipe || $mode == free || $mode == keep ]] || die "Unknown install mode: $mode"
  if [[ $encrypt == encrypt ]]; then
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
  # This group's volumes are about to be made or opened by name.
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
    [[ $(lvm pvs --devices "$pv" --noheadings -o vg_name 2>/dev/null | tr -d ' ') == "$VG" ]] ||
      die "This DinOS was installed before your files were kept apart from the system, so they can't be kept. Erase the disk to reinstall."
    lvm vgchange -q --activate y --devices "$pv" "$VG" >/dev/null
    vg_devices=$pv
    [[ -b /dev/mapper/$VG-root && -b /dev/mapper/$VG-home ]] ||
      die "DinOS's volumes on $disk aren't all there."
    stash=/run/din-install-keep/$(lsblk -no PARTUUID "$part")
    stash_old_root "$stash"
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
  mkfs.vfat -F 32 -n DINOS "$esp" >/dev/null
  if [[ $mode == keep ]]; then
    mkfs.ext4 -q -F -L nixos "/dev/mapper/$VG-root"
  else
    if [[ -n $passphrase ]]; then
      printf '%s' "$passphrase" |
        cryptsetup luksFormat -q --type luks2 --label DinOS --key-file=- "$part"
    fi
    open_system "$part" "$passphrase"
    lvm pvcreate -q -y --devices "$pv" "$pv" >/dev/null
    lvm vgcreate -q --devices "$pv" --setautoactivation n "$VG" "$pv" >/dev/null
    vg_devices=$pv
    local vg_bytes root_bytes
    vg_bytes=$(lvm vgs --devices "$pv" --noheadings --units b --nosuffix -o vg_size "$VG" | tr -d ' ')
    root_bytes=$((vg_bytes / 4))
    (( root_bytes >= ROOT_MIN_BYTES )) || root_bytes=$ROOT_MIN_BYTES
    (( root_bytes <= ROOT_MAX_BYTES )) || root_bytes=$ROOT_MAX_BYTES
    (( root_bytes >= $(used_bytes) + HEADROOM_BYTES )) || die "$disk is too small for DinOS."
    lvm lvcreate -q -y --devices "$pv" -n root -L "$((root_bytes / MIB))m" "$VG" >/dev/null
    lvm lvcreate -q -y --devices "$pv" -n home -l 100%FREE "$VG" >/dev/null
    mkfs.ext4 -q -F -L nixos "/dev/mapper/$VG-root"
    mkfs.ext4 -q -F -L home "/dev/mapper/$VG-home"
  fi

  target=$(mktemp -d /run/din-install.XXXXXX)
  mount "/dev/mapper/$VG-root" "$target"
  mkdir "$target/boot" "$target/home"
  mount -o umask=0077 "$esp" "$target/boot"
  # A reinstall never mounts home: nothing below can touch it.
  [[ $mode == keep ]] || mount "/dev/mapper/$VG-home" "$target/home"

  step copy
  local excludes=(
    --exclude='/proc/*' --exclude='/sys/*' --exclude='/dev/*' --exclude='/run/*'
    --exclude='/tmp/*' --exclude='/boot' --exclude='/mnt/*' --exclude='/media/*'
    --exclude='/var/tmp/*' --exclude='/var/cache/*' --exclude='/var/log/journal/*'
    --exclude='/home/*/.cache/*' --exclude='/home/.nix-build/*' --exclude='/lost+found'
  )
  [[ $mode != keep ]] || excludes+=(--exclude='/home/*')
  # rsync's overall progress, as whole percents.
  set +e
  rsync -aHAX --numeric-ids --no-inc-recursive --info=progress2 "${excludes[@]}" / "$target/" |
    awk -v RS='[\r\n]+' '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { sub("%", "", $i); if ($i != last) { print "progress", $i; fflush(); last = $i } } }'
  local rc=${PIPESTATUS[0]}
  set -e
  # 24: files vanished mid-copy (caches, sockets) - expected from a live system.
  [[ $rc == 0 || $rc == 24 ]] || die "Copying the system failed (rsync exit $rc)."

  step boot
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

  # Put DinOS first in the firmware's boot order. Firmware also boots the
  # ESP's removable path on its own, so a refusal here isn't fatal.
  if [[ -d /sys/firmware/efi/efivars ]]; then
    efibootmgr 2>/dev/null | awk '$1 ~ /^Boot[0-9A-Fa-f]{4}\*?$/ && $2 == "DinOS" { print substr($1, 5, 4) }' |
      while read -r num; do efibootmgr -q -b "$num" -B || true; done
    efibootmgr -q -c -d "$disk" -p "$(lsblk -no PARTN "$esp")" -L DinOS \
      -l '\EFI\BOOT\BOOTX64.EFI' || echo "Couldn't add a firmware boot entry." >&2
  fi

  sync
  cleanup
  target=""
  vg_devices=""
  crypt_open=""
  source_esp=""
  step finished
}

case "${1:-}" in
  status) status ;;
  install)
    [[ $# == 3 || ($# == 4 && $4 == encrypt) ]] || die "usage: din-install install <disk> wipe|free|keep [encrypt]"
    install "$2" "$3" "${4:-}"
    ;;
  *) die "usage: din-install status | install <disk> wipe|free|keep [encrypt]" ;;
esac

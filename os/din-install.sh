# din-install: the privileged half of Din's Installer app.
#
# Aladdin boots from a USB stick as a live system; this copies that running
# system onto a computer's own disk. Din runs it through sudo (a NOPASSWD rule
# for exactly this program, see configuration.nix) from electron/installer.mts.
#
#   din-install status
#       JSON: whether this is a live boot, the space an install needs, and
#       the disks it could go on.
#   din-install install <disk> wipe|free
#       Install onto <disk>, either erasing it or into its largest stretch of
#       unpartitioned space (next to Windows, say). Reports on stdout as it
#       goes - `step <name>` and `progress <percent>` lines - and exits
#       non-zero with the reason on stderr if it can't.
#
# The installed system is a file-level copy of the live one: the same Nix
# store, the same boot entries, and the session (sign-in, saved WiFi) the user
# set up while trying it. It finds its root through GPT auto-discovery (the
# root partition on the disk the boot loader came from), so it boots the same
# whichever disk it's on, even with the stick still plugged in.

ROOT_TYPE=4f68bce3-e8cd-4db1-96e7-fbcaf984b709 # Linux root (x86-64)
ESP_TYPE=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
MIB=$((1024 * 1024))
ESP_BYTES=$((512 * MIB))
# Room for the user's files, apps, and Wine prefixes beyond the live system's
# own footprint. Below this an install would fill up on first use.
HEADROOM_BYTES=$((8 * 1024 * MIB))

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
  if [[ -b /dev/disk/aladdin-esp ]]; then
    readlink -f /dev/disk/aladdin-esp
    return
  fi
  lsblk -lnpo NAME,PARTTYPE "$1" | awk -v t="$ESP_TYPE" 'tolower($2) == t { print $1; exit }'
}

required_bytes() {
  local used
  used=$(df -B1 --output=used / | tail -n1)
  echo $((used + HEADROOM_BYTES + ESP_BYTES))
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

disk_json() {
  local disk=$1
  lsblk -Jbpo NAME,SIZE,MODEL,VENDOR,TRAN,RM,PTTYPE,PARTTYPE,PARTLABEL,FSTYPE,LABEL,MOUNTPOINTS "$disk" |
    jq --argjson free "$(largest_free_bytes "$disk")" --arg root "$ROOT_TYPE" '
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
          inUse: any($parts[]; (.mountpoints // []) | map(select(. != null)) | length > 0),
          hasLinuxRoot: any($parts[]; (.parttype // "" | ascii_downcase) == $root),
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

target=""
source_esp=""
cleanup() {
  if [[ -n $target ]]; then
    umount -R "$target" 2>/dev/null || true
    rmdir "$target" 2>/dev/null || true
  fi
  if [[ -n $source_esp ]]; then
    umount "$source_esp" 2>/dev/null || true
    rmdir "$source_esp" 2>/dev/null || true
  fi
}

install() {
  local disk=$1 mode=$2 boot required ss json esp root before
  boot=$(boot_disk)
  is_live "$boot" || die "Aladdin can only be installed while running from a USB stick."
  grep -qxF -- "$disk" <<<"$(candidate_disks "$boot")" || die "$disk is not a disk Aladdin can be installed on."
  [[ $mode == wipe || $mode == free ]] || die "Unknown install mode: $mode"

  json=$(disk_json "$disk")
  [[ $(jq '.inUse' <<<"$json") == false ]] || die "A partition on $disk is in use."
  required=$(required_bytes)
  ss=$(blockdev --getss "$disk")

  trap cleanup EXIT

  step partition
  udevadm settle
  if [[ $mode == wipe ]]; then
    (( $(jq '.sizeBytes' <<<"$json") >= required )) || die "$disk is too small for Aladdin."
    wipefs -aq "$disk"
    printf 'label: gpt\nsize=%s, type=%s, name="Aladdin boot"\ntype=%s, name="Aladdin"\n' \
      $((ESP_BYTES / ss)) "$ESP_TYPE" "$ROOT_TYPE" |
      sfdisk -q --wipe always --wipe-partitions always "$disk"
  else
    [[ $(jq -r '.partitionTable' <<<"$json") == gpt ]] ||
      die "Installing alongside another system needs a GPT disk."
    # GPT auto-discovery takes the first root partition on the boot disk,
    # which could be the other system's.
    [[ $(jq '.hasLinuxRoot' <<<"$json") == false ]] ||
      die "$disk already has a Linux system on it. Aladdin can't be installed alongside another Linux system yet."
    local region start sectors esp_sectors
    region=$(largest_free_region "$disk")
    [[ -n $region ]] || die "$disk has no unpartitioned space."
    start=${region% *}
    sectors=${region#* }
    (( sectors * ss >= required )) || die "$disk doesn't have enough unpartitioned space for Aladdin."
    esp_sectors=$((ESP_BYTES / ss))
    before=$(partitions_by_start "$disk")
    printf 'start=%s, size=%s, type=%s, name="Aladdin boot"\nstart=%s, size=%s, type=%s, name="Aladdin"\n' \
      "$start" "$esp_sectors" "$ESP_TYPE" \
      $((start + esp_sectors)) $((sectors - esp_sectors)) "$ROOT_TYPE" |
      sfdisk -q --append --wipe-partitions always "$disk"
  fi
  udevadm settle

  # The two partitions just made are the ones that weren't there before; the
  # ESP comes first.
  local created
  created=$(comm -13 <(sort <<<"${before:-}") <(partitions_by_start "$disk" | sort) | sort -k2,2n | cut -d' ' -f1)
  esp=$(sed -n 1p <<<"$created")
  root=$(sed -n 2p <<<"$created")
  [[ -b $esp && -b $root ]] || die "The new partitions on $disk didn't appear."

  step format
  mkfs.vfat -F 32 -n ALADDIN "$esp" >/dev/null
  mkfs.ext4 -q -F -L nixos "$root"

  target=$(mktemp -d /run/din-install.XXXXXX)
  mount "$root" "$target"
  mkdir "$target/boot"
  mount -o umask=0077 "$esp" "$target/boot"

  step copy
  # rsync's overall progress, as whole percents.
  set +e
  rsync -aHAX --numeric-ids --no-inc-recursive --info=progress2 \
    --exclude='/proc/*' --exclude='/sys/*' --exclude='/dev/*' --exclude='/run/*' \
    --exclude='/tmp/*' --exclude='/boot' --exclude='/mnt/*' --exclude='/media/*' \
    --exclude='/var/tmp/*' --exclude='/var/cache/*' --exclude='/var/log/journal/*' \
    --exclude='/home/*/.cache/*' --exclude='/lost+found' \
    / "$target/" |
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

  # Put Aladdin first in the firmware's boot order. Firmware also boots the
  # ESP's removable path on its own, so a refusal here isn't fatal.
  if [[ -d /sys/firmware/efi/efivars ]]; then
    efibootmgr 2>/dev/null | awk '$1 ~ /^Boot[0-9A-Fa-f]{4}\*?$/ && $2 == "Aladdin" { print substr($1, 5, 4) }' |
      while read -r num; do efibootmgr -q -b "$num" -B || true; done
    efibootmgr -q -c -d "$disk" -p "$(lsblk -no PARTN "$esp")" -L Aladdin \
      -l '\EFI\BOOT\BOOTX64.EFI' || echo "Couldn't add a firmware boot entry." >&2
  fi

  sync
  cleanup
  target=""
  source_esp=""
  step finished
}

case "${1:-}" in
  status) status ;;
  install)
    [[ $# == 3 ]] || die "usage: din-install install <disk> wipe|free"
    install "$2" "$3"
    ;;
  *) die "usage: din-install status | install <disk> wipe|free" ;;
esac

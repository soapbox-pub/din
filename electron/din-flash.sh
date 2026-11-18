#!/usr/bin/env bash
# din-flash: the privileged half of USB Flasher (electron/usb-flasher.mts).
#
#   din-flash write <disk>
#       Write the image on stdin to <disk> (a whole disk, e.g. /dev/sdb),
#       from its first byte, then read back as many bytes as were written and
#       check they're the same. Reports on stdout as it goes: `step write`,
#       `step verify <bytes>` (how many were written, to read back),
#       `verified <bytes>` lines while reading back, and
#       `done <bytes> <sha256>` at the end. Exits non-zero with the reason on
#       stderr if it can't.
#
# It runs as root: through sudo without a password on DinOS (DIN_FLASHER,
# configuration.nix), where Din names it; elsewhere Din runs this copy with
# `sudo -A`, which asks for the password in Din. So it decides for itself
# what may be written, whatever Din asks: only a whole disk that's removable
# or on USB or an SD card slot, writable, with nothing on it mounted (Din
# unmounts what it mounted first), used as swap, or held by device mapper,
# RAID or LVM, and never the disk the running system started from. It never
# opens a file by name: the image comes in on stdin, read by Din as the
# user, so nothing the user can't read can be written out.

set -euo pipefail

die() {
  echo "$*" >&2
  exit 1
}

BLOCK=$((4 * 1024 * 1024))

# The whole disk the running system's root lives on, e.g. /dev/sda.
boot_disk() {
  local root parent
  root=$(findmnt -nvo SOURCE / 2>/dev/null || true)
  [[ -b $root ]] || return 0
  parent=$(lsblk -nso NAME,TYPE "$root" 2>/dev/null | awk '$2 == "disk" { print $1 }' | tail -n1)
  [[ -n $parent ]] && echo "/dev/${parent##*[^[:alnum:]]}"
  return 0
}

check_disk() {
  local disk=$1 name type ro removable tran
  [[ $disk =~ ^/dev/[a-z][a-z0-9]*$ ]] || die "Not a disk: $disk"
  [[ -b $disk ]] || die "There's no disk at $disk. Was it unplugged?"
  name=${disk#/dev/}
  [[ -d /sys/block/$name ]] || die "$disk isn't a whole disk."
  type=$(lsblk -dno TYPE "$disk")
  [[ $type == disk ]] || die "$disk isn't a disk."
  ro=$(cat "/sys/block/$name/ro")
  [[ $ro == 0 ]] || die "That drive is write-protected. Check for a lock switch on its side."
  removable=$(cat "/sys/block/$name/removable" 2>/dev/null || echo 0)
  tran=$(lsblk -dno TRAN "$disk" | tr -d '[:space:]')
  if [[ $removable != 1 && $tran != usb && $tran != mmc && $name != mmcblk* ]]; then
    die "Only USB drives and memory cards can be written to, and $disk is neither."
  fi
  [[ $disk != "$(boot_disk)" ]] || die "That's the disk this computer is running from."
  if lsblk -nlo MOUNTPOINTS "$disk" | grep -q '[^[:space:]]'; then
    die "Something on that drive is still in use. Eject it in Files, plug it in again, and try again."
  fi
  local dev
  while read -r dev; do
    if awk 'NR > 1 { print $1 }' /proc/swaps | grep -qxF "/dev/$dev"; then
      die "Part of that drive is being used as swap."
    fi
    if [[ -n $(ls -A "/sys/class/block/$dev/holders" 2>/dev/null) ]]; then
      die "Part of that drive is in use (unlocked, or part of a volume group)."
    fi
  done < <(lsblk -nlo NAME "$disk")
}

write() {
  local disk=$1 tmp size sum check
  check_disk "$disk"

  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # $tmp is fixed now.
  trap "rm -rf '$tmp'" EXIT
  mkfifo "$tmp/sum" "$tmp/count"

  echo "step write"
  # Old partition tables go first: a GPT's copy at the end of the drive
  # would otherwise outlive a smaller image, and confuse what reads it.
  wipefs --all --force --quiet "$disk" >/dev/null 2>&1 || true
  # What goes in is hashed and counted on the way, to check against what
  # comes back. Direct I/O, so the drive's pace is the writing's, not the
  # page cache's.
  sha256sum <"$tmp/sum" | cut -d' ' -f1 >"$tmp/sum.out" &
  local hasher=$!
  wc -c <"$tmp/count" >"$tmp/count.out" &
  local counter=$!
  if ! tee "$tmp/sum" "$tmp/count" | dd of="$disk" bs=$BLOCK iflag=fullblock oflag=direct status=none 2>"$tmp/dd.err"; then
    wait "$hasher" "$counter" || true
    if grep -qi 'no space left' "$tmp/dd.err"; then
      die "The image is bigger than the drive."
    fi
    die "Writing stopped: $(tail -n1 "$tmp/dd.err")"
  fi
  wait "$hasher" "$counter"
  sync
  blockdev --flushbufs "$disk" 2>/dev/null || true
  size=$(tr -d '[:space:]' <"$tmp/count.out")
  sum=$(cat "$tmp/sum.out")
  [[ $size -gt 0 ]] || die "The image was empty."

  echo "step verify $size"
  # Straight from the drive (direct I/O again), never the page cache's copy.
  # dd's progress goes out on fd 3, stdout, past the hash being captured.
  exec 3>&1
  check=$(
    dd if="$disk" bs=$BLOCK iflag=direct,count_bytes count="$size" status=progress 2> >(
      tr '\r' '\n' | sed -un 's/^\([0-9][0-9]*\) bytes.*/verified \1/p' >&3
    ) | sha256sum | cut -d' ' -f1
  )
  [[ $check == "$sum" ]] || die "The drive didn't read back what was written to it. It may be failing; try another one."

  # The new partitions, for udisks and the kernel. A drive in use somewhere
  # refuses; udev rereads it on its own once it's closed anyway.
  blockdev --rereadpt "$disk" 2>/dev/null || true
  echo "done $size $sum"
}

case ${1:-} in
  write)
    [[ $# -eq 2 ]] || die "usage: din-flash write <disk>"
    write "$2"
    ;;
  *)
    die "usage: din-flash write <disk>"
    ;;
esac

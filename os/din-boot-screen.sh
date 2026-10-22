# din-boot-screen: the privileged half of DinOS's boot screen.
#
# The boot screen (os/boot-screen/din.script) asks for the disk's password
# before anything on the disk can be read, so what it shows that's the
# user's own lives on the boot partition, which isn't encrypted: the
# wallpaper, the keyboard layout to type the password with, the time zone
# and whether the clock is 12- or 24-hour. The initrd copies them from
# ESP_DIR before Plymouth starts (os/configuration.nix).
#
#   din-boot-screen sync
#       Copy the keyboard layout (/var/lib/din/keyboard) and the time zone
#       over. Run at boot, and by din-keyboard when the layout changes. The
#       layout also goes to VCONSOLE_FILE, for the lock screen's Plymouth
#       (os/din-lock.py), which reads it in place of /etc/vconsole.conf.
#   din-boot-screen wallpaper 12|24
#       Make the PNG on stdin the wallpaper (none on stdin removes it), and
#       set the clock's format. Din runs this through sudo
#       (electron/boot-screen.mts).

ESP_DIR=/boot/din
LAYOUT_FILE=/var/lib/din/keyboard
VCONSOLE_FILE=/var/lib/din/vconsole.conf
MAX_WALLPAPER_BYTES=$((16 * 1024 * 1024))

die() {
  echo "$*" >&2
  exit 1
}

# /boot is the ESP the boot loader ran from, unless it failed to mount.
require_esp() {
  [[ $(findmnt -no FSTYPE /boot 2>/dev/null) == vfat ]] || die "The boot partition isn't mounted."
  mkdir -p "$ESP_DIR"
}

# Replace an ESP file with a temporary one (FAT has no atomic replace, but a
# rename is as close as it gets).
put() {
  local tmp=$1 name=$2
  sync "$tmp"
  mv -f "$tmp" "$ESP_DIR/$name"
}

# The layout as vconsole.conf's XKB* lines, which is how Plymouth takes it.
write_vconsole() {
  local key value
  {
    while IFS='=' read -r key value; do
      [[ $value =~ ^[A-Za-z0-9_.,:+-]+$ ]] || continue
      case $key in
        XKB_DEFAULT_LAYOUT | XKB_DEFAULT_MODEL | XKB_DEFAULT_VARIANT | XKB_DEFAULT_OPTIONS)
          echo "XKB${key#XKB_DEFAULT_}=$value"
          ;;
      esac
    done <"$LAYOUT_FILE"
  } >"$VCONSOLE_FILE.tmp"
  chmod 644 "$VCONSOLE_FILE.tmp"
  mv "$VCONSOLE_FILE.tmp" "$VCONSOLE_FILE"
}

sync_settings() {
  if [[ -f $LAYOUT_FILE ]]; then
    write_vconsole
  else
    rm -f "$VCONSOLE_FILE"
  fi
  require_esp
  if [[ -f $LAYOUT_FILE ]]; then
    cp "$LAYOUT_FILE" "$ESP_DIR/keyboard.tmp"
    put "$ESP_DIR/keyboard.tmp" keyboard
  else
    rm -f "$ESP_DIR/keyboard"
  fi
  if [[ -e /etc/localtime ]]; then
    cp -L /etc/localtime "$ESP_DIR/localtime.tmp"
    put "$ESP_DIR/localtime.tmp" localtime
  else
    rm -f "$ESP_DIR/localtime"
  fi
}

set_wallpaper() {
  local format=$1 tmp=$ESP_DIR/wallpaper.tmp size
  [[ $format == 12 || $format == 24 ]] || die "The clock is 12 or 24 hours."
  require_esp
  head -c $((MAX_WALLPAPER_BYTES + 1)) >"$tmp"
  size=$(stat -c %s "$tmp")
  if [[ $size == 0 ]]; then
    rm -f "$tmp" "$ESP_DIR/wallpaper.png"
  else
    ((size <= MAX_WALLPAPER_BYTES)) || { rm -f "$tmp"; die "The wallpaper is too big."; }
    [[ $(head -c 8 "$tmp" | od -An -tx1 | tr -d ' \n') == 89504e470d0a1a0a ]] ||
      { rm -f "$tmp"; die "The wallpaper isn't a PNG."; }
    put "$tmp" wallpaper.png
  fi
  echo "$format" >"$ESP_DIR/clock.tmp"
  put "$ESP_DIR/clock.tmp" clock
}

case "${1:-}" in
  sync)
    [[ $# == 1 ]] || die "usage: din-boot-screen sync"
    sync_settings
    ;;
  wallpaper)
    [[ $# == 2 ]] || die "usage: din-boot-screen wallpaper 12|24"
    set_wallpaper "$2"
    ;;
  *) die "usage: din-boot-screen sync | wallpaper 12|24" ;;
esac

# din-keyboard: the privileged half of DinOS's keyboard layout setting.
#
# DinOS's layout lives in one file, LAYOUT_FILE, as XKB_DEFAULT_* lines. The
# cage unit reads it as its EnvironmentFile (configuration.nix): cage applies
# it to everything on screen, and Din inherits it, so native apps get the
# same one (electron/keyboard.mts). cage only reads it when it starts. A copy
# goes on the boot partition, for the password prompt (din-boot-screen).
#
# Din runs this through sudo from electron/keyboard.mts.
#
#   din-keyboard set <layout> [variant]
#       Make <layout>, or its <variant>, the system layout. Any other
#       XKB_DEFAULT_* lines (model, options) are kept.
#   din-keyboard restart
#       Restart Din's session, so cage picks the layout up.
#   din-keyboard remap
#       Where the layout makes Caps Lock a Backspace (Colemak), make the key
#       one, for every keyboard (REMAP_FILE, which a udev rule in
#       configuration.nix applies). Chromium only repeats keys held down by
#       which physical key they are, and never Caps Lock, so in Din it
#       wouldn't repeat like Backspace. Run at boot and by `set`.

LAYOUT_FILE=/var/lib/din/keyboard
REMAP_FILE=/var/lib/din/keyboard-remap
SESSION_UNIT=cage-tty1.service

die() {
  echo "$*" >&2
  exit 1
}

# A single XKB layout or variant name, e.g. `us` or `colemak_dh`.
valid_name() {
  [[ $1 =~ ^[A-Za-z0-9_][A-Za-z0-9_.+-]*$ ]]
}

set_layout() {
  local layout=$1 variant=${2:-}
  valid_name "$layout" || die "Not a keyboard layout: $layout"
  [[ -z $variant ]] || valid_name "$variant" || die "Not a keyboard variant: $variant"

  mkdir -p "$(dirname "$LAYOUT_FILE")"
  local tmp
  tmp=$(mktemp "$LAYOUT_FILE.XXXXXX")
  {
    if [[ -f $LAYOUT_FILE ]]; then
      grep -E '^XKB_DEFAULT_(RULES|MODEL|OPTIONS)=' "$LAYOUT_FILE" || true
    fi
    echo "XKB_DEFAULT_LAYOUT=$layout"
    [[ -z $variant ]] || echo "XKB_DEFAULT_VARIANT=$variant"
  } >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$LAYOUT_FILE"
  remap || echo "Couldn't remap Caps Lock for the layout." >&2
  # The boot screen types the disk's password with it too.
  din-boot-screen sync || echo "Couldn't give the boot screen the layout." >&2
}

# Caps Lock's scancodes: on built-in (AT) keyboards, and USB/Bluetooth ones.
CAPS_SCANCODES=(3a 70039)

# Write REMAP_FILE's KEYBOARD_KEY_* lines mapping Caps Lock to KEY_$1.
write_remap() {
  local tmp code
  tmp=$(mktemp "$REMAP_FILE.XXXXXX")
  for code in "${CAPS_SCANCODES[@]}"; do
    echo "KEYBOARD_KEY_$code=$1"
  done >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$REMAP_FILE"
}

apply_remap() {
  udevadm trigger --action=change --subsystem-match=input --property-match=ID_INPUT_KEYBOARD=1
  udevadm settle --timeout=10 || true
}

remap() {
  local args=() key value
  if [[ -f $LAYOUT_FILE ]]; then
    while IFS='=' read -r key value; do
      case $key in
        XKB_DEFAULT_RULES) args+=(--rules "$value") ;;
        XKB_DEFAULT_MODEL) args+=(--model "$value") ;;
        XKB_DEFAULT_LAYOUT) args+=(--layout "$value") ;;
        XKB_DEFAULT_VARIANT) args+=(--variant "$value") ;;
        XKB_DEFAULT_OPTIONS) args+=(--options "$value") ;;
      esac
    done <"$LAYOUT_FILE"
  fi
  # Caps Lock's first symbol, from `key <CAPS> { [ BackSpace ] };` or the
  # longer form with `symbols[1]= [ BackSpace ]`.
  local keymap
  keymap=$(xkbcli compile-keymap "${args[@]}" | tr -d '\n')
  if grep -qE 'key <CAPS>\s*\{[^}]*\[\s*BackSpace\s*[],]' <<<"$keymap"; then
    write_remap backspace
    apply_remap
  elif [[ -f $REMAP_FILE ]]; then
    # Put the keys back, then leave them to the kernel's own mapping.
    write_remap capslock
    apply_remap
    rm -f "$REMAP_FILE"
  fi
}

case "${1:-}" in
  set)
    [[ $# == 2 || $# == 3 ]] || die "usage: din-keyboard set <layout> [variant]"
    set_layout "$2" "${3:-}"
    ;;
  restart) systemctl restart --no-block "$SESSION_UNIT" ;;
  remap)
    [[ $# == 1 ]] || die "usage: din-keyboard remap"
    remap
    ;;
  *) die "usage: din-keyboard set <layout> [variant] | restart | remap" ;;
esac

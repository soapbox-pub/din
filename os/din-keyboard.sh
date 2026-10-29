# din-keyboard: the privileged half of DinOS's keyboard layout setting.
#
# DinOS's layout lives in one file, LAYOUT_FILE, as XKB_DEFAULT_* lines. The
# din-shell unit reads it as its EnvironmentFile (configuration.nix): its
# compositor applies it to everything on screen, and Din inherits it, so
# native apps get the same one (electron/keyboard.mts). The compositor only
# reads it when it starts. A copy
# goes on the boot partition, for the password prompt (din-boot-screen).
#
# Din runs this through sudo from electron/keyboard.mts.
#
#   din-keyboard set <layout> [variant]
#       Make <layout>, or its <variant>, the system layout. Any other
#       XKB_DEFAULT_* lines (model, options) are kept.
#   din-keyboard restart
#       Restart Din's session, so its compositor picks the layout up.
#   din-keyboard remap
#       Where the layout makes Caps Lock a Backspace (Colemak), make the key
#       one, for every keyboard (REMAP_FILE, which a udev rule in
#       configuration.nix applies). Chromium only repeats keys held down by
#       which physical key they are, and never Caps Lock, so in Din it
#       wouldn't repeat like Backspace. Run at boot and by `set`.
#   din-keyboard console
#       Give the text consoles (Ctrl+Alt+F2) the layout too, as a console
#       keymap (CONSOLE_MAP) that /etc/vconsole.conf, a link to
#       CONSOLE_CONF, names. Run at boot and by `set`.

LAYOUT_FILE=/var/lib/din/keyboard
REMAP_FILE=/var/lib/din/keyboard-remap
CONSOLE_CONF=/var/lib/din/console.conf
CONSOLE_MAP=/var/lib/din/console.map
SESSION_UNIT=din-shell.service

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
  console || echo "Couldn't give the text consoles the layout." >&2
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

# LAYOUT_FILE's fields as flags, into the array named $2: `$1rules`,
# `$1model`, `$1layout`, `$1variant`, and `$1$3` for the options, whose flag
# xkbcli and ckbcomp spell differently.
layout_flags() {
  local -n flags=$2
  local key value
  flags=()
  [[ -f $LAYOUT_FILE ]] || return 0
  while IFS='=' read -r key value; do
    case $key in
      XKB_DEFAULT_RULES) flags+=("$1rules" "$value") ;;
      XKB_DEFAULT_MODEL) flags+=("$1model" "$value") ;;
      XKB_DEFAULT_LAYOUT) flags+=("$1layout" "$value") ;;
      XKB_DEFAULT_VARIANT) flags+=("$1variant" "$value") ;;
      XKB_DEFAULT_OPTIONS) flags+=("$1$3" "$value") ;;
    esac
  done <"$LAYOUT_FILE"
}

remap() {
  local args
  layout_flags -- args options
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

console() {
  if [[ -f $LAYOUT_FILE ]]; then
    local args tmp
    layout_flags - args option
    tmp=$(mktemp "$CONSOLE_MAP.XXXXXX")
    ckbcomp "${args[@]}" >"$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$CONSOLE_MAP"
    tmp=$(mktemp "$CONSOLE_CONF.XXXXXX")
    echo "KEYMAP=$CONSOLE_MAP" >"$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$CONSOLE_CONF"
  else
    rm -f "$CONSOLE_CONF" "$CONSOLE_MAP"
  fi
  systemctl restart systemd-vconsole-setup.service
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
  console)
    [[ $# == 1 ]] || die "usage: din-keyboard console"
    console
    ;;
  *) die "usage: din-keyboard set <layout> [variant] | restart | remap | console" ;;
esac

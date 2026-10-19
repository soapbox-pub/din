# din-keyboard: the privileged half of DinOS's keyboard layout setting.
#
# DinOS's layout lives in one file, LAYOUT_FILE, as XKB_DEFAULT_* lines. The
# cage unit reads it as its EnvironmentFile (configuration.nix): cage applies
# it to everything on screen, and Din inherits it, so native apps get the
# same one (electron/keyboard.mts). cage only reads it when it starts.
#
# Din runs this through sudo from electron/keyboard.mts.
#
#   din-keyboard set <layout> [variant]
#       Make <layout>, or its <variant>, the system layout. Any other
#       XKB_DEFAULT_* lines (model, options) are kept.
#   din-keyboard restart
#       Restart Din's session, so cage picks the layout up.

LAYOUT_FILE=/var/lib/din/keyboard
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
}

case "${1:-}" in
  set)
    [[ $# == 2 || $# == 3 ]] || die "usage: din-keyboard set <layout> [variant]"
    set_layout "$2" "${3:-}"
    ;;
  restart) systemctl restart --no-block "$SESSION_UNIT" ;;
  *) die "usage: din-keyboard set <layout> [variant] | restart" ;;
esac

# din-firewall: the privileged half of Settings → Firewall.
#
# DinOS's firewall (NixOS's, in configuration.nix) lets in only what Din's
# own features need. The user's other ports, for an app like a game server
# or a file-sharing program Din doesn't know about, are kept in RULES_FILE
# and put in a chain of their own, din-fw, which the firewall's nixos-fw
# chain jumps to before refusing everything else. The firewall runs
# `din-firewall apply` each time it starts or reloads (extraCommands), so the
# rules come back with it. Din runs this through sudo from
# electron/firewall.mts.
#
#   din-firewall allow tcp|udp|both PORT[-PORT] [NAME...]
#       Let other devices connect to a port, or a range of them, named for
#       what it's for. Allowing the same ports again renames them.
#   din-firewall remove tcp|udp|both PORT[-PORT]
#       Stop letting them in.
#   din-firewall apply
#       Put the saved rules in the firewall (the firewall's own start).
#
# RULES_FILE has a line per rule: protocol, ports, then the name, which is
# the rest of the line.

RULES_FILE=/var/lib/din/firewall
CHAIN=din-fw

die() {
  echo "$*" >&2
  exit 1
}

usage() {
  die "usage: din-firewall allow|remove tcp|udp|both PORT[-PORT] [NAME...] | apply"
}

check_protocol() {
  case $1 in
    tcp | udp | both) ;;
    *) die "The protocol is tcp, udp or both, not $1" ;;
  esac
}

# A port, 1-65535, or a range of them, low-high.
check_ports() {
  local from to
  [[ $1 =~ ^([0-9]{1,5})(-([0-9]{1,5}))?$ ]] || die "Ports are a number, or two with a dash between them, not $1"
  from=$((10#${BASH_REMATCH[1]}))
  to=$((10#${BASH_REMATCH[3]:-${BASH_REMATCH[1]}}))
  ((from >= 1 && to <= 65535)) || die "Ports go from 1 to 65535"
  ((from <= to)) || die "The range starts at its lower port"
}

check_name() {
  ((${#1} <= 64)) || die "The name is at most 64 characters"
  [[ $1 != *[[:cntrl:]]* ]] || die "The name can't have control characters"
}

# Every saved rule but the one for these protocol and ports.
others() {
  [[ -f $RULES_FILE ]] || return 0
  local protocol ports name
  while read -r protocol ports name; do
    [[ $protocol == "$1" && $ports == "$2" ]] && continue
    printf '%s %s %s\n' "$protocol" "$ports" "$name"
  done <"$RULES_FILE"
}

save() {
  mkdir -p "$(dirname "$RULES_FILE")"
  local tmp
  tmp=$(mktemp "$RULES_FILE.XXXXXX")
  cat >"$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$RULES_FILE"
}

both_tables() {
  iptables -w "$@"
  ip6tables -w "$@"
}

apply() {
  # The firewall makes the chain when it starts; with it off, there's
  # nothing to put the rules in, and they wait for it.
  iptables -w -n -L "$CHAIN" >/dev/null 2>&1 || return 0
  both_tables -F "$CHAIN"
  [[ -f $RULES_FILE ]] || return 0
  local protocol ports _name p
  while read -r protocol ports _name; do
    # A line Din didn't write is skipped, not trusted.
    (check_protocol "$protocol" && check_ports "$ports") 2>/dev/null || continue
    for p in tcp udp; do
      [[ $protocol == both || $protocol == "$p" ]] || continue
      both_tables -A "$CHAIN" -p "$p" --dport "${ports/-/:}" -j nixos-fw-accept
    done
  done <"$RULES_FILE"
}

case ${1:-} in
  allow)
    (($# >= 3)) || usage
    check_protocol "$2"
    check_ports "$3"
    name="${*:4}"
    check_name "$name"
    { others "$2" "$3"; printf '%s %s %s\n' "$2" "$3" "$name"; } | save
    apply
    ;;
  remove)
    (($# == 3)) || usage
    check_protocol "$2"
    check_ports "$3"
    others "$2" "$3" | save
    apply
    ;;
  apply)
    (($# == 1)) || usage
    apply
    ;;
  *) usage ;;
esac

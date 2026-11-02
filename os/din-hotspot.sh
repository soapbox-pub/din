# din-hotspot: the privileged half of Quick Share's Wi-Fi hotspot.
#
# A phone sharing over Bluetooth moves to a Wi-Fi network this computer
# hosts, which lets it share at Wi-Fi speed when it isn't on the same network
# (Android phones leave theirs while Quick Share's share sheet is open). The
# Wi-Fi card hosts it alongside its own connection, on a second interface
# that only root can add; NetworkManager runs the network on it, as Din's
# user (electron/quickshare-hotspot.mts). Din runs this through sudo.
#
#   din-hotspot up
#       Add the hotspot's interface (dinqs0) to the Wi-Fi card, if it isn't
#       there already.
#   din-hotspot down
#       Remove it.

die() {
  echo "$*" >&2
  exit 1
}

IFACE=dinqs0

[[ $# == 1 ]] || die "usage: din-hotspot up|down"

case $1 in
  up)
    [[ -e /sys/class/net/$IFACE ]] && exit 0
    phy=""
    for wireless in /sys/class/net/*/phy80211; do
      [[ -e $wireless ]] || continue
      phy=$(basename "$(readlink -f "$wireless")")
      break
    done
    [[ -n $phy ]] || die "No Wi-Fi adapter was found"
    iw phy "$phy" interface add "$IFACE" type __ap || die "The Wi-Fi adapter can't host a network"
    ;;
  down)
    [[ -e /sys/class/net/$IFACE ]] || exit 0
    iw dev "$IFACE" del
    ;;
  *)
    die "usage: din-hotspot up|down"
    ;;
esac

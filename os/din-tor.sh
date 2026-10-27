# din-tor: the privileged half of Settings → Wi-Fi → Tor.
#
# Tor is a system service, and starting and stopping one takes root. So Din
# runs this through sudo from electron/tor.mts.
#
#   din-tor on|off
#       Start Tor and have it start at boot, or stop it and keep it stopped.

# NixOS's read-only /etc can't disable a unit, so Tor is off while this file
# is there: its unit has a condition on it (configuration.nix).
OFF_FILE=/var/lib/din/tor-off
TOR=tor.service

die() {
  echo "$*" >&2
  exit 1
}

[[ $# == 1 ]] || die "usage: din-tor on|off"
case $1 in
  on)
    rm -f "$OFF_FILE"
    systemctl start "$TOR"
    ;;
  off)
    mkdir -p "$(dirname "$OFF_FILE")"
    touch "$OFF_FILE"
    systemctl stop "$TOR"
    ;;
  *) die "usage: din-tor on|off" ;;
esac

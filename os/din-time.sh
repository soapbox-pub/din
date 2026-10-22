# din-time: the privileged half of Settings → Date & Time.
#
# The time zone and clock are systemd-timedated's, which asks polkit for
# an administrator before changing them, and Din has no polkit agent to
# ask with. So Din runs this through sudo from electron/datetime.mts, and it
# runs timedatectl as root. Reading them needs no privileges.
#
#   din-time zone <Area/City>
#       Make <Area/City> the time zone, here and on the boot screen
#       (din-boot-screen).
#   din-time automatic on|off
#       Set the clock from the network (systemd-timesyncd), or don't.
#   din-time set <YYYY-MM-DD HH:MM:SS>
#       Set the clock, in the time zone's local time. Only while it isn't
#       set from the network.

# timedated turns timesyncd off by disabling its unit, which NixOS's
# read-only /etc refuses. So it's off while this file is there: timesyncd's
# unit has a condition on it (configuration.nix).
MANUAL_FILE=/var/lib/din/manual-time
TIMESYNCD=systemd-timesyncd.service

die() {
  echo "$*" >&2
  exit 1
}

set_zone() {
  local zone=$1
  [[ $zone =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] || die "Not a time zone: $zone"
  timedatectl list-timezones | grep -qxF -- "$zone" || die "Not a time zone: $zone"
  timedatectl set-timezone "$zone"
  # The boot screen shows the time too.
  din-boot-screen sync || echo "Couldn't give the boot screen the time zone." >&2
}

set_automatic() {
  case $1 in
    on)
      rm -f "$MANUAL_FILE"
      systemctl start "$TIMESYNCD"
      ;;
    off)
      mkdir -p "$(dirname "$MANUAL_FILE")"
      touch "$MANUAL_FILE"
      systemctl stop "$TIMESYNCD"
      ;;
    *) die "Automatic is on or off." ;;
  esac
}

set_time() {
  local time=$1
  [[ $time =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || die "Not a time: $time"
  [[ -e $MANUAL_FILE ]] || die "The clock is set automatically."
  timedatectl set-time "$time"
}

case "${1:-}" in
  zone)
    [[ $# == 2 ]] || die "usage: din-time zone <Area/City>"
    set_zone "$2"
    ;;
  automatic)
    [[ $# == 2 ]] || die "usage: din-time automatic on|off"
    set_automatic "$2"
    ;;
  set)
    [[ $# == 2 ]] || die "usage: din-time set <YYYY-MM-DD HH:MM:SS>"
    set_time "$2"
    ;;
  *) die "usage: din-time zone <Area/City> | automatic on|off | set <YYYY-MM-DD HH:MM:SS>" ;;
esac

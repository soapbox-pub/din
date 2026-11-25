# din-charge-limit: the privileged half of Settings → Battery's charge limit.
#
# UPower turns the limit on and off (EnableChargeThreshold, which the active
# session may call itself), but stops charging only where the battery's
# CHARGE_LIMIT udev property says (its hwdb's, 75,80 for most machines),
# which it reads once, when it finds the battery: it has no way to choose
# another level. So the level Settings chooses goes in LIMIT_FILE, which a
# udev rule in configuration.nix imports as CHARGE_LIMIT, and this has udev
# read it again and restarts UPower, which applies it if the limit is on.
#
# Din runs this through sudo from electron/main.mts.
#
#   din-charge-limit set <percent>
#       Stop charging at <percent> (50 to 100) while the limit is on, and
#       start again 5% below it.

LIMIT_FILE=/var/lib/din/charge-limit
POWER_SUPPLY=/sys/class/power_supply

die() {
  echo "$*" >&2
  exit 1
}

# The computer's own batteries with a charge threshold, as sysfs directories.
batteries() {
  local dir
  for dir in "$POWER_SUPPLY"/*; do
    [[ $(cat "$dir/type" 2>/dev/null) == Battery ]] || continue
    [[ $(cat "$dir/scope" 2>/dev/null) != Device ]] || continue
    [[ -w $dir/charge_control_end_threshold ]] || continue
    echo "$dir"
  done
}

# Write the thresholds of a battery whose limit is on now, in the order the
# kernel takes them: drivers refuse a start above the end.
apply() {
  local dir=$1 start=$2 end=$3 current
  current=$(cat "$dir/charge_control_end_threshold")
  ((current < 100)) || return 0
  if ((end > current)); then
    echo "$end" >"$dir/charge_control_end_threshold"
    [[ ! -w $dir/charge_control_start_threshold ]] || echo "$start" >"$dir/charge_control_start_threshold"
  else
    [[ ! -w $dir/charge_control_start_threshold ]] || echo "$start" >"$dir/charge_control_start_threshold"
    echo "$end" >"$dir/charge_control_end_threshold"
  fi
}

set_limit() {
  [[ $# == 1 && $1 =~ ^[0-9]{2,3}$ ]] || die "usage: din-charge-limit set <percent>"
  local end=$((10#$1))
  ((end >= 50 && end <= 100)) || die "The limit is from 50% to 100%, not $end%"
  local start=$((end - 5))

  local found='' dir
  while read -r dir; do
    found=1
    apply "$dir" "$start" "$end" || echo "Couldn't set $(basename "$dir")'s limit now." >&2
  done < <(batteries)
  [[ -n $found ]] || die "This computer's battery has no charge limit"

  mkdir -p "$(dirname "$LIMIT_FILE")"
  local tmp
  tmp=$(mktemp "$LIMIT_FILE.XXXXXX")
  echo "CHARGE_LIMIT=$start,$end" >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$LIMIT_FILE"

  udevadm trigger --action=change --subsystem-match=power_supply --attr-match=type=Battery
  udevadm settle --timeout=10 || true
  systemctl try-restart upower.service
}

case "${1:-}" in
  set)
    shift
    set_limit "$@"
    ;;
  *) die "usage: din-charge-limit set <percent>" ;;
esac

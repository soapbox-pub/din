# din-wifi: the privileged half of Settings → Wi-Fi's reset.
#
# WiFi drivers can stop working without saying so: after a wake from sleep
# a card can stop finishing scans, and at boot a driver can fail to attach
# at all. Turning the radio off and on in NetworkManager doesn't help, since
# that never touches the card. A reboot does, because it starts the card
# over, so this does the same without one: it detaches every WiFi card from
# its driver, resets it, and attaches it again, which loads its firmware
# afresh. It goes through the kernel's generic device controls, so it works
# whatever the chip, driver or bus. Din runs it through sudo from
# electron/network.mts.
#
#   din-wifi reset
#       Reset every WiFi card, and wait for them to come back.

die() {
  echo "$*" >&2
  exit 1
}

[[ $# == 1 && $1 == reset ]] || die "usage: din-wifi reset"

# The devices behind WiFi interfaces (not virtual ones, which have none),
# and PCI cards of the wireless class that have no driver - one that failed
# to attach.
devices=()
for wireless in /sys/class/net/*/wireless; do
  [[ -e $wireless ]] || continue
  dev=$(dirname "$wireless")/device
  [[ -e $dev ]] && devices+=("$(readlink -f "$dev")")
done
for dev in /sys/bus/pci/devices/*; do
  [[ $(cat "$dev/class") == 0x0280* && ! -e $dev/driver ]] && devices+=("$(readlink -f "$dev")")
done
mapfile -t devices < <(printf '%s\n' "${devices[@]}" | sort -u | sed '/^$/d')
[[ ${#devices[@]} -gt 0 ]] || die "No Wi-Fi adapter was found"

reset_device() {
  local dev=$1 name driver=""
  name=$(basename "$dev")
  [[ -e $dev/driver ]] && driver=$(readlink -f "$dev/driver")
  echo "Resetting $name${driver:+ ($(basename "$driver"))}"

  case $(basename "$(readlink -f "$dev/subsystem")") in
    usb)
      # A USB interface: unplugging and replugging its device, as far as the
      # kernel is concerned, starts it over.
      local usb
      usb=$(dirname "$dev")
      echo 0 >"$usb/authorized"
      sleep 1
      echo 1 >"$usb/authorized"
      ;;
    pci)
      [[ -n $driver ]] && echo "$name" >"$driver/unbind"
      # A function-level reset where the card has one; the driver's probe
      # resets it its own way too.
      [[ -e $dev/reset ]] && { echo 1 >"$dev/reset" || true; }
      # Its driver may never have been loaded (a failed boot).
      modprobe -q "$(cat "$dev/modalias")" || true
      echo "$name" >/sys/bus/pci/drivers_probe
      ;;
    *)
      [[ -n $driver ]] || return 0
      echo "$name" >"$driver/unbind"
      sleep 1
      echo "$name" >"$driver/bind"
      ;;
  esac
}

failed=0
for dev in "${devices[@]}"; do
  reset_device "$dev" || failed=1
done

# The cards are back once each has a WiFi interface again.
for _ in $(seq 40); do
  back=1
  for dev in "${devices[@]}"; do
    compgen -G "$dev/net/*/wireless" >/dev/null ||
      compgen -G "$dev/*/net/*/wireless" >/dev/null ||
      back=0
  done
  ((back)) && break
  sleep 0.5
done

((back)) || die "The Wi-Fi adapter didn't come back after a reset"
((failed == 0)) || die "The Wi-Fi adapter couldn't be reset"

# What a computer no one has used yet has none of: shared by din-erase,
# which takes it off a computer, and din-install's `oem`, which leaves it off
# a new install, so a computer set up for someone else is the same as one
# installed and then erased. configuration.nix puts this ahead of both.

gone() {
  rm -rf "$1" || echo "Couldn't erase $1" >&2
}

# Everything in directory $1, hidden files too.
empty() {
  local f
  for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [[ -e $f || -L $f ]]; then gone "$f"; fi
  done
}

# The system's own record of the user, in the root at $1 ("" for the running
# one): everything in /var/lib but NixOS's ids, the hibernation swap file and
# the updater's checkout; logs, caches, root's home, saved networks, sudo
# rules of the user's, and the machine's identity (made fresh at the next
# boot, as for a new install, with SSH's host keys). The time zone stays,
# and the system with it.
pristine_system() {
  local root=$1 f
  for f in "$root"/var/lib/*; do
    case ${f##*/} in
      nixos | swap | dinos) ;;
      *) gone "$f" ;;
    esac
  done
  for f in "$root"/var/lib/dinos/*; do
    case ${f##*/} in
      src | result | erase) ;;
      *) gone "$f" ;;
    esac
  done
  for f in "$root"/var/log/*; do
    if [[ $f == "$root/var/log/journal" ]]; then empty "$f"; else gone "$f"; fi
  done
  empty "$root/var/cache"
  empty "$root/var/tmp"
  empty "$root/tmp"
  empty "$root/root"
  empty "$root/etc/NetworkManager/system-connections"
  empty "$root/etc/sudoers.d"
  for f in "$root"/etc/ssh/ssh_host_*; do
    if [[ -e $f ]]; then gone "$f"; fi
  done
  if [[ -f $root/etc/machine-id && ! -L $root/etc/machine-id ]]; then
    : >"$root/etc/machine-id"
  fi
}

# What the boot screen showed of the user's, in its directory on the boot
# partition $1: everything but the disk's setup key, which opens it until
# Setup gives it a password.
pristine_boot() {
  local old
  [[ -d $1 ]] || return 0
  for old in "$1"/*; do
    [[ $old == "$1/setup.key" ]] || rm -rf "$old"
  done
}

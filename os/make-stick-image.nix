# DinOS's disk image, the live USB stick: an ESP, and a root partition of the
# GPT root type (how the initrd finds it, see fileSystems in
# configuration.nix) holding Btrfs laid out as the Installer lays out a
# computer's disk (os/din-install.sh): the system in `@`, the default
# subvolume, home in `@home`, and /tmp a subvolume of its own inside the
# system's.
#
# Everything on it is compressed with zstd at its strongest level: a stick
# reads slowly, so the fewer bytes there are to read, the sooner programs
# start and the sooner the Installer has copied the system, and zstd
# unpacks as fast whatever level packed it. The compression is also set as
# a property that new files inherit, as on an installed disk; what a live
# session writes is packed at the default level.
#
# The size is fixed, so nothing grows the filesystem at boot, which on a
# slow stick took seconds of writes while the desktop was starting. The
# build fails when the system leaves less than `minFreeBytes` free, the room
# a live session gets: raise `diskSize` then. The release compresses the
# empty space away (scripts/dinos-release.sh).
#
# nixpkgs' make-disk-image.nix only makes ext4 for a partitioned image, so
# this does what it does - install the system, then its boot loader with
# switch-to-configuration - in a VM, onto Btrfs.
{
  pkgs,
  lib,
  config,
  # MiB.
  diskSize,
  minFreeBytes ? 1024 * 1024 * 1024,
  # As make-disk-image.nix's: { source, target, mode?, user?, group? }.
  contents ? [ ],
}:

let
  closureInfo = pkgs.closureInfo { rootPaths = [ config.system.build.toplevel ]; };

  # The ESP where make-disk-image.nix put it (8 MiB in, ending at 257 MiB).
  espStartMiB = 8;
  espSizeMiB = 249;
  rootType = "4f68bce3-e8cd-4db1-96e7-fbcaf984b709";

  binPath = lib.makeBinPath (
    with pkgs;
    [
      btrfs-progs
      dosfstools
      util-linux
      rsync
      nix
      config.system.build.nixos-install
      nixos-enter
      systemdMinimal
    ]
    ++ stdenv.initialPath
  );

  copyContents = lib.concatMapStrings (c: ''
    mkdir -p "$(dirname /mnt${c.target})"
    rsync -a --no-o --no-g ${lib.optionalString (c ? mode) "--chmod=${c.mode}"} ${c.source}/ /mnt${c.target}
    ${lib.optionalString (c ? user || c ? group) ''
      nixos-enter --root /mnt -- chown -R "${c.user or ""}:${c.group or ""}" ${c.target}
    ''}
  '') contents;

  vmTools = pkgs.vmTools.override {
    rootModules = [
      "virtio_pci" "virtio_mmio" "virtio_blk" "virtio_balloon" "virtio_rng"
      "ext4" "virtiofs" "crc32c" "btrfs" "vfat" "nls_cp437" "nls_iso8859_1"
    ];
  };
in
vmTools.runInLinuxVM (
  pkgs.runCommand "dinos-image"
    {
      preVM = ''
        mkdir $out
        diskImage=nixos.img
        truncate -s ${toString diskSize}M $diskImage
        ${pkgs.util-linux}/bin/sfdisk -q $diskImage <<EOF
        label: gpt
        start=${toString espStartMiB}MiB, size=${toString espSizeMiB}MiB, type=uefi, name=ESP
        type=${rootType}, name=DinOS
        EOF
      '';
      postVM = ''
        mv $diskImage $out/nixos.img
        mkdir -p $out/nix-support
        echo "file raw-image $out/nixos.img" >> $out/nix-support/hydra-build-products
      '';
      memSize = 4096;
    }
    ''
      export PATH=${binPath}:$PATH
      export HOME=$TMPDIR

      mkfs.vfat -n ESP /dev/vda1
      mkfs.btrfs -q -L nixos /dev/vda2

      mkdir -p /top
      mount /dev/vda2 /top
      btrfs subvolume create /top/@
      btrfs subvolume create /top/@home
      btrfs property set /top/@ compression zstd
      btrfs property set /top/@home compression zstd
      btrfs subvolume create /top/@/tmp
      chmod 1777 /top/@/tmp
      btrfs subvolume set-default /top/@
      umount /top

      opts=compress=zstd:15,noatime
      mkdir -p /mnt
      mount -o $opts,subvol=@ /dev/vda2 /mnt
      mkdir -p /mnt/home /mnt/boot
      mount -o $opts,subvol=@home /dev/vda2 /mnt/home
      mount /dev/vda1 /mnt/boot

      # nixos-install copies the system out of the host's store, which the VM
      # shares, once a database says what's in it.
      export NIX_STATE_DIR=$TMPDIR/state
      nix-store --load-db < ${closureInfo}/registration
      nixos-install --root /mnt --no-bootloader --no-root-passwd --no-channel-copy \
        --system ${config.system.build.toplevel} --substituters ""

      # systemd-boot finds the ESP through its device number, without udev.
      mkdir -p /dev/block
      ln -s /dev/vda1 /dev/block/$(cat /sys/class/block/vda1/dev)
      NIXOS_INSTALL_BOOTLOADER=1 nixos-enter --root /mnt -- /nix/var/nix/profiles/system/bin/switch-to-configuration boot

      ${copyContents}

      sync
      btrfs filesystem usage -b /mnt
      free=$(btrfs filesystem usage -b /mnt | awk '/Free \(estimated\)/ { print $3 }')
      echo "free: $free bytes"
      umount -R /mnt
      if [ "$free" -lt ${toString minFreeBytes} ]; then
        echo "The image has only $free bytes free, under ${toString minFreeBytes}: raise diskSize (os/flake.nix)." >&2
        exit 1
      fi
    ''
)

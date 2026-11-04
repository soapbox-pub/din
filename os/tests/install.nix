{ pkgs, modules, din, deckmon, ngit, makeImage }:

let
  inherit (pkgs) lib;

  # A disk as the Installer made it before Btrfs (os/din-install.sh's
  # history): LVM under the root partition, encrypted under a passphrase if
  # one is given, and ext4 `root` and `home` volumes.
  legacyInstall = pkgs.writeShellScript "legacy-install" ''
    set -euo pipefail
    export PATH=${lib.makeBinPath (with pkgs; [ coreutils util-linux rsync dosfstools e2fsprogs lvm2 systemd cryptsetup ])}
    disk=$1 esp=''${1}1 part=''${1}2
    wipefs -aq "$disk"
    printf 'label: gpt\nsize=512MiB, type=c12a7328-f81f-11d2-ba4b-00a0c93ec93b, name="DinOS boot"\ntype=4f68bce3-e8cd-4db1-96e7-fbcaf984b709, name="DinOS"\n' |
      sfdisk -q --wipe always --wipe-partitions always "$disk"
    udevadm settle
    if [ -n "''${2:-}" ]; then
      printf '%s' "$2" | cryptsetup luksFormat -q --type luks2 --label DinOS --pbkdf pbkdf2 --pbkdf-force-iterations 1000 --key-file=- "$part"
      printf '%s' "$2" | cryptsetup open --key-file=- "$part" dinos-install
      part=/dev/mapper/dinos-install
    fi
    lvm pvcreate -q -y --devices "$part" "$part"
    lvm vgcreate -q --devices "$part" --setautoactivation n dinos "$part"
    lvm lvcreate -q -y --devices "$part" -n root -L 48g dinos
    lvm lvcreate -q -y --devices "$part" -n home -l 100%FREE dinos
    mkfs.vfat -F 32 -n DINOS "$esp" >/dev/null
    mkfs.ext4 -q -F -L nixos /dev/mapper/dinos-root
    mkfs.ext4 -q -F -L home /dev/mapper/dinos-home
    t=$(mktemp -d)
    mount /dev/mapper/dinos-root "$t"
    mkdir "$t/boot" "$t/home"
    mount "$esp" "$t/boot"
    mount /dev/mapper/dinos-home "$t/home"
    # The Btrfs stick's own properties don't go on ext4, and nor does
    # ~/.var, which din-nocow makes on Btrfs: the ext4 sticks of the time
    # had none.
    rsync -aHAX --numeric-ids \
      --exclude='/proc/*' --exclude='/sys/*' --exclude='/dev/*' --exclude='/run/*' \
      --exclude='/tmp/*' --exclude='/boot' --exclude='/var/cache/*' --exclude='/var/log/journal/*' \
      --exclude='/lost+found' --exclude='/home/*/.var' --filter='-x btrfs.*' / "$t/" || [ $? = 24 ]
    cp -r /boot/. "$t/boot/"
    rm -f "$t/boot/loader/random-seed"
    : >"$t/etc/machine-id"
    echo legacy >"$t/home/din/legacy"
    umount -R "$t"
    lvm vgchange -q --activate n --devices "$part" dinos
    if [ -n "''${2:-}" ]; then cryptsetup close dinos-install; fi
  '';
in

# The Installer's disk work, from a live USB stick onto a computer's disk,
# each install then booted from that disk: a new install is Btrfs, a
# reinstall keeps home and the machine's own settings, and a disk installed
# before Btrfs still boots with today's initrd and can still be reinstalled,
# and one set up for someone else starts as an erased computer does.
# The live system is the test machine's own image, plugged in over USB.
# `nix build ./os#checks.x86_64-linux.install`
pkgs.testers.runNixOSTest {
  name = "dinos-install";
  node.specialArgs = { inherit din deckmon ngit; };
  nodes.machine = { config, pkgs, ... }: {
    imports = modules;
    systemd.services.din-shell.enable = lib.mkForce false;
    virtualisation = {
      memorySize = 4096;
      cores = 4;
      # Booted by its firmware from the drives the test plugs in, each with
      # the image's own filesystems rather than the test's.
      directBoot.enable = false;
      mountHostNixStore = false;
      useEFIBoot = true;
      useDefaultFilesystems = false;
      fileSystems = lib.mkForce { };
      diskImage = null;
      qemu.options = [ "-device qemu-xhci,id=xhci $DINOS_DRIVES" ];
    };
    # envfs overrides fileSystems in a VM, so DinOS's own (configuration.nix)
    # are said again at its priority.
    fileSystems = lib.mkVMOverride {
      "/" = {
        device = "/dev/gpt-auto-root";
        fsType = "auto";
        options = [ "x-systemd.device-timeout=0" ];
      };
      "/boot" = {
        device = "/dev/disk/dinos-esp";
        fsType = "vfat";
        options = [ "umask=0077" "nofail" ];
      };
    };
    system.build.stick = makeImage { inherit config pkgs; };
    # In the system, so it's on the image the machine boots.
    environment.etc."test-legacy-install".source = legacyInstall;
    # Which the image needs to install its boot loader; tests leave it out.
    system.switch.enable = true;
  };

  testScript = { nodes, ... }: ''
    import os, subprocess, tempfile

    qemu_img = "${nodes.machine.virtualisation.qemu.package}/bin/qemu-img"
    work = tempfile.mkdtemp()
    stick = os.path.join(work, "stick.qcow2")
    disk = os.path.join(work, "disk.qcow2")
    subprocess.run([qemu_img, "create", "-f", "qcow2", "-F", "raw", "-b", "${nodes.machine.system.build.stick}/nixos.img", stick], check=True)
    subprocess.run([qemu_img, "create", "-f", "qcow2", disk, "80G"], check=True)

    disk_drive = f"-drive if=none,id=disk,format=qcow2,file={disk} -device virtio-blk-pci,drive=disk,bootindex=2"

    def boot(live, passphrase=None):
        if machine.booted:
            machine.shutdown()
        stick_drive = f"-drive if=none,id=stick,format=qcow2,file={stick} -device usb-storage,bus=xhci.0,drive=stick,removable=on,bootindex=1 "
        os.environ["DINOS_DRIVES"] = (stick_drive if live else "") + disk_drive
        machine.start()
        if passphrase:
            # Typed at the boot screen, as on a real computer.
            machine.wait_for_console_text("assphrase")
            machine.send_console(passphrase + "\n")
        machine.wait_for_unit("multi-user.target")

    def install(mode):
        installer = machine.succeed("grep -o '/nix/store/[^ ,]*/bin/din-install' /etc/sudoers | head -1").strip()
        status = machine.succeed(f"{installer} status")
        print(status)
        out = machine.succeed(f"{installer} install /dev/vda {mode} | grep -v '^progress'")
        print(out)
        assert out.strip().endswith("step finished"), out

    def fs(path):
        return machine.succeed(f"findmnt -no FSTYPE,SOURCE {path}").strip()

    with subtest("the stick boots live"):
        boot(live=True)
        assert machine.succeed("lsblk -dno TRAN /dev/sda").strip() == "usb"
        # Laid out as an installed disk is (os/make-stick-image.nix).
        assert fs("/").startswith("btrfs /dev/sda2"), fs("/")
        assert "path @" in machine.succeed("btrfs subvolume get-default /")
        assert "subvol=/@home" in machine.succeed("findmnt -no OPTIONS /home"), fs("/home")
        machine.succeed("btrfs subvolume show /tmp")
        assert "zstd" in machine.succeed("btrfs property get /etc compression")
        assert machine.succeed("stat -c %U /home/din/.opencode/bin/opencode").strip() == "din"
        machine.wait_for_unit("dinos-live.service")
        assert machine.succeed("nix config show min-free").strip() == "0"
        machine.succeed("echo live > /home/din/from-live")

    with subtest("an encrypted disk installed before Btrfs still boots"):
        machine.succeed("/etc/test-legacy-install /dev/vda hunter22")
        boot(live=False, passphrase="hunter22")
        assert fs("/") == "ext4 /dev/mapper/dinos-root", fs("/")
        assert fs("/home") == "ext4 /dev/mapper/dinos-home", fs("/home")
        assert machine.succeed("cat /home/din/legacy").strip() == "legacy"
        boot(live=True)

    with subtest("a new install is Btrfs"):
        install("wipe")
        assert machine.succeed("blkid -o value -s TYPE /dev/vda2").strip() == "btrfs"
        assert machine.succeed("blkid -o value -s LABEL /dev/vda2").strip() == "DinOS"
        # Sent from snapshots of the stick's, which are gone from both.
        machine.succeed("mkdir -p /mnt/top /mnt/stick", "mount -o subvolid=5 /dev/vda2 /mnt/top", "mount -o subvolid=5 /dev/sda2 /mnt/stick")
        subvols = sorted(machine.succeed("btrfs subvolume list /mnt/top | awk '{ print $NF }'").split())
        assert subvols == ["@", "@/tmp", "@home"], subvols
        machine.fail("ls -d /mnt/stick/.din-install-*")
        machine.succeed("umount /mnt/top /mnt/stick")

    with subtest("it boots, with home in its own subvolume, compressed"):
        boot(live=False)
        assert fs("/").startswith("btrfs"), fs("/")
        assert "subvol=/@home" in machine.succeed("findmnt -no OPTIONS /home"), fs("/home")
        assert "path @" in machine.succeed("btrfs subvolume get-default /")
        assert machine.succeed("cat /home/din/from-live").strip() == "live"
        assert "zstd" in machine.succeed("btrfs property get /home/din/from-live compression")
        assert "zstd" in machine.succeed("btrfs property get /etc compression")
        machine.succeed("btrfs subvolume show /tmp")
        assert machine.succeed("stat -c %a /tmp").strip() == "1777"
        steam = "/home/din/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps"
        machine.wait_for_unit("din-nocow.service")
        assert "C" in machine.succeed(f"lsattr -d {steam}").split()[0], machine.succeed(f"lsattr -d {steam}")
        assert machine.succeed(f"stat -c %U {steam}").strip() == "din"
        machine.succeed(f"su din -c 'touch {steam}/game'")
        assert "C" in machine.succeed(f"lsattr {steam}/game").split()[0]
        # The hibernation swap file's way, in a subvolume that inherits zstd.
        machine.succeed("btrfs subvolume create /var/lib/swaptest", "btrfs filesystem mkswapfile --size 64m /var/lib/swaptest/f", "btrfs subvolume delete -R /var/lib/swaptest")
        machine.succeed("echo mine > /home/din/kept", "mkdir -p /var/lib/bluetooth && echo paired > /var/lib/bluetooth/kept")

    with subtest("a reinstall replaces the system and keeps home"):
        boot(live=True)
        machine.succeed("echo live-again > /home/din/from-live")
        install("keep")
        machine.succeed("mkdir -p /mnt/top && mount -o subvolid=5 /dev/vda2 /mnt/top")
        subvols = machine.succeed("btrfs subvolume list -o /mnt/top | awk '{ print $NF }' | sort").split()
        assert subvols == ["@", "@home"], subvols
        machine.succeed("umount /mnt/top")

    with subtest("the reinstalled system boots with the old one's files and settings"):
        boot(live=False)
        assert fs("/").startswith("btrfs"), fs("/")
        assert machine.succeed("cat /home/din/kept").strip() == "mine"
        assert machine.succeed("cat /home/din/from-live").strip() == "live"
        assert machine.succeed("cat /var/lib/bluetooth/kept").strip() == "paired"

    with subtest("a disk installed before Btrfs still boots"):
        boot(live=True)
        machine.succeed("/etc/test-legacy-install /dev/vda")
        boot(live=False)
        assert fs("/") == "ext4 /dev/mapper/dinos-root", fs("/")
        assert fs("/home") == "ext4 /dev/mapper/dinos-home", fs("/home")
        assert machine.succeed("cat /home/din/legacy").strip() == "legacy"
        machine.wait_for_unit("din-nocow.service")
        machine.fail("test -e /home/din/.var/app/com.valvesoftware.Steam")
        machine.succeed("mkdir -p /var/lib/bluetooth && echo paired > /var/lib/bluetooth/kept")

    with subtest("and can still be reinstalled, keeping home"):
        boot(live=True)
        install("keep")
        boot(live=False)
        assert fs("/") == "ext4 /dev/mapper/dinos-root", fs("/")
        assert machine.succeed("cat /home/din/legacy").strip() == "legacy"
        assert machine.succeed("cat /var/lib/bluetooth/kept").strip() == "paired"

    with subtest("setting up for someone else leaves nothing of the live session's"):
        boot(live=True)
        machine.succeed(
            "echo live > /home/din/from-live",
            "mkdir -p /var/lib/bluetooth && echo paired > /var/lib/bluetooth/live",
            "mkdir -p /etc/NetworkManager/system-connections && echo cafe > /etc/NetworkManager/system-connections/cafe.nmconnection",
            "mkdir -p /boot/din && echo png > /boot/din/wallpaper.png",
        )
        install("oem")
        assert machine.succeed("blkid -o value -s TYPE /dev/vda2").strip() == "crypto_LUKS"

    with subtest("it starts without asking, into Setup, until Setup sets its password"):
        boot(live=False)
        assert fs("/").startswith("btrfs /dev/mapper/root"), fs("/")
        for path in [
            "/home/din/from-live", "/var/lib/bluetooth/live",
            "/etc/NetworkManager/system-connections/cafe.nmconnection",
            "/boot/din/wallpaper.png",
        ]:
            machine.fail(f"test -e {path}")
        machine.succeed("test -d /home/din", "test -e /var/lib/din/setup", "test -s /boot/din/setup.key")
        assert machine.succeed("awk -F: '$1 == \"din\" { print $2 }' /etc/shadow").strip() == "!"
        setup = machine.succeed("grep -o '/nix/store/[^ ,]*/bin/din-password' /etc/sudoers | head -1").strip()
        machine.succeed(f"printf 'battery-staple\\n' | {setup} setup")
        machine.fail("test -e /var/lib/din/setup", "test -e /boot/din/setup.key")
        machine.succeed("printf battery-staple | cryptsetup open --test-passphrase --key-file=- /dev/vda2")
        boot(live=False, passphrase="battery-staple")
  '';
}

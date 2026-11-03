{ pkgs, modules, din, deckmon, ngit, makeImage }:

let
  inherit (pkgs) lib;
in

# Erasing an encrypted install (os/din-erase.sh): the boot after it's marked
# empties home and the system's record of the user and leaves the disk
# opening with a setup key, so the next boot doesn't ask; Setup's password
# (din-password setup) then replaces that key. Installed by the Installer
# from the test machine's own image, plugged in as a USB stick, as in
# tests/install.nix.
# `nix build ./os#checks.x86_64-linux.erase`
pkgs.testers.runNixOSTest {
  name = "dinos-erase";
  node.specialArgs = { inherit din deckmon ngit; };
  nodes.machine = { config, pkgs, ... }: {
    imports = modules;
    systemd.services.din-shell.enable = lib.mkForce false;
    virtualisation = {
      memorySize = 4096;
      cores = 4;
      directBoot.enable = false;
      mountHostNixStore = false;
      useEFIBoot = true;
      useDefaultFilesystems = false;
      fileSystems = lib.mkForce { };
      diskImage = null;
      qemu.options = [ "-device qemu-xhci,id=xhci $DINOS_DRIVES" ];
    };
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
    system.switch.enable = true;
  };

  testScript = { nodes, ... }: ''
    import json, os, subprocess, tempfile

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
            machine.wait_for_console_text("assphrase")
            machine.send_console(passphrase + "\n")
        machine.wait_for_unit("multi-user.target")

    def helper(name):
        return machine.succeed(f"grep -o '/nix/store/[^ ,]*/bin/{name}' /etc/sudoers | head -1").strip()

    def shadow():
        return machine.succeed("awk -F: '$1 == \"din\" { print $2 }' /etc/shadow").strip()

    def keyslots():
        return list(json.loads(machine.succeed("cryptsetup luksDump --dump-json-metadata /dev/vda2"))["keyslots"])

    with subtest("an encrypted install, with the user's things on it"):
        boot(live=True)
        out = machine.succeed(f"printf hunter22 | {helper('din-install')} install /dev/vda wipe encrypt | grep -v '^progress'")
        assert out.strip().endswith("step finished"), out
        boot(live=False, passphrase="hunter22")
        machine.succeed(
            "echo mine > /home/din/mine",
            "mkdir -p /var/lib/bluetooth && echo paired > /var/lib/bluetooth/paired",
            "mkdir -p /etc/NetworkManager/system-connections && echo home > /etc/NetworkManager/system-connections/home.nmconnection",
            "mkdir -p /boot/din && echo png > /boot/din/wallpaper.png",
            "echo mine > /root/mine",
        )
        assert shadow().startswith("$"), shadow()
        status = json.loads(machine.succeed(f"{helper('din-erase')} status"))
        print(status)
        assert status["available"] and status["encrypted"] and status["password"], status
        # Not the updater's build, so not official.
        assert not status["official"], status
        machine.fail(f"printf 'wrong-one\\n' | {helper('din-erase')} start")
        machine.succeed("test -e /home/din/mine")

    with subtest("the next boot erases it"):
        # What `din-erase mark` does, without start's checks or its restart.
        machine.succeed("echo erase > /var/lib/dinos/erase")
        machine_id = machine.succeed("cat /etc/machine-id").strip()
        boot(live=False, passphrase="hunter22")
        machine.wait_for_unit("din-erase-finish.service")
        for path in [
            "/home/din/mine", "/var/lib/bluetooth/paired", "/root/mine",
            "/etc/NetworkManager/system-connections/home.nmconnection",
            "/boot/din/wallpaper.png", "/var/lib/dinos/erase",
        ]:
            machine.fail(f"test -e {path}")
        machine.succeed("test -d /home/din", "test -e /var/lib/din/setup", "test -s /boot/din/setup.key")
        assert machine.succeed("cat /etc/machine-id").strip() != machine_id
        assert shadow() == "!", shadow()
        assert len(keyslots()) == 1, keyslots()
        machine.fail("printf hunter22 | cryptsetup open --test-passphrase --key-file=- /dev/vda2")
        machine.succeed("cryptsetup open --test-passphrase --key-file=/boot/din/setup.key /dev/vda2")
        machine.succeed("mkdir -p /mnt/top && mount -o subvolid=5 /dev/mapper/root /mnt/top")
        subvols = machine.succeed("btrfs subvolume list -o /mnt/top | awk '{ print $NF }' | sort").split()
        assert subvols == ["@", "@home"], subvols
        machine.succeed("umount /mnt/top")

    with subtest("it starts without asking, until Setup sets its password"):
        boot(live=False)
        machine.fail("test -e /var/lib/dinos/erase")
        machine.succeed(f"printf 'battery-staple\\n' | {helper('din-password')} setup")
        machine.fail("test -e /var/lib/din/setup", "test -e /boot/din/setup.key")
        assert shadow().startswith("$"), shadow()
        assert len(keyslots()) == 1, keyslots()
        machine.succeed("printf battery-staple | cryptsetup open --test-passphrase --key-file=- /dev/vda2")
        machine.fail(f"printf 'again-1234\\n' | {helper('din-password')} setup")
        machine.succeed(f"printf 'battery-staple\\n' | {helper('din-password')} check")
        boot(live=False, passphrase="battery-staple")
  '';
}

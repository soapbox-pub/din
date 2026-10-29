{ pkgs, modules, din, deckmon }:

# Firmware updates: `din` lists fwupd's devices and installs signed firmware
# without an admin password, the way Settings does (electron/firmware.mts),
# and still can't change fwupd's settings. fwupd's virtual test devices
# and its test remote stand in for real hardware and LVFS.
# `nix build ./os#checks.x86_64-linux.firmware`.
pkgs.testers.runNixOSTest {
  name = "dinos-firmware";
  node.specialArgs = { inherit din deckmon; };
  nodes.machine = {
    imports = modules;
    systemd.services.din-shell.enable = pkgs.lib.mkForce false;
    virtualisation.memorySize = 2048;
    services.fwupd.daemonSettings.TestDevices = true;
  };

  testScript = ''
    import json
    import shlex

    machine.wait_for_unit("multi-user.target")
    # There's no network to reach LVFS with.
    machine.succeed("fwupdmgr disable-remote lvfs")

    fwupdmgr = "fwupdmgr"
    flags = "--json --no-unreported-check --no-metadata-check --no-remote-check --no-reboot-check"

    def as_din(command):
        return machine.succeed("su - din -c " + shlex.quote(command))

    with subtest("din refreshes the remotes and lists devices"):
        as_din(f"{fwupdmgr} refresh --force {flags}")
        devices = json.loads(as_din(f"{fwupdmgr} get-devices {flags}"))
        print(json.dumps(devices, indent=2))
        assert len(devices["Devices"]) > 0, devices

    with subtest("din sees the updates"):
        updates = json.loads(as_din(f"{fwupdmgr} get-updates {flags}"))
        print(json.dumps(updates, indent=2))
        assert len(updates["Devices"]) > 0, updates

    with subtest("din installs signed firmware without a password"):
        device = updates["Devices"][0]
        before = device["Version"]
        print(as_din(f"{fwupdmgr} update {device['DeviceId']} {flags}"))
        after = json.loads(as_din(f"{fwupdmgr} get-devices {flags}"))
        print(json.dumps(after, indent=2))
        now = next(d for d in after["Devices"] if d["DeviceId"] == device["DeviceId"])
        assert now["Version"] != before, now
        left = json.loads(as_din(f"{fwupdmgr} get-updates {device['DeviceId']} {flags}"))
        assert left["Devices"] == [], left

    with subtest("but doesn't change fwupd's settings"):
        machine.fail("su - din -c " + shlex.quote(f"{fwupdmgr} modify-config fwupd DisabledPlugins test {flags}"))
  '';
}

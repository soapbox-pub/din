{ pkgs, modules, din }:

# The lock screen: it takes over the screen on its own terminal, nothing can
# switch away from it, only the computer's password gets past it, waking
# from hibernation lets the user straight in, and a computer without a
# password doesn't lock. `nix build ./os#checks.x86_64-linux.lock`; the
# result has screenshots.
pkgs.testers.runNixOSTest {
  name = "dinos-lock";
  node.specialArgs = { inherit din; };
  nodes.machine = {
    imports = modules;
    services.cage.enable = pkgs.lib.mkForce false;
    fonts.packages = [ pkgs.inter ];
    virtualisation.memorySize = 2048;
    virtualisation.resolution = { x = 1280; y = 800; };
  };

  testScript = ''
    import shlex

    machine.wait_for_unit("multi-user.target")
    machine.wait_until_succeeds("test -e /dev/dri/card0")
    machine.succeed("udevadm settle")
    # The boot screen leaves tty1 in graphics mode for Din, which isn't
    # running here to take it over; nothing could switch away from it.
    machine.succeed("${pkgs.python3}/bin/python3 -c 'import fcntl, os; fcntl.ioctl(os.open(\"/dev/tty1\", os.O_RDWR), 0x4B3A, 0)'")

    def as_din(command):
        return machine.succeed("su - din -c " + shlex.quote(command))

    # Din reaches it by its store path, as sudoers names it.
    lock = machine.succeed("grep -o '/nix/store/[^ ,]*-din-lock/bin/din-lock' /etc/sudoers | head -1").strip()

    def active_vt():
        return machine.succeed("cat /sys/class/tty/tty0/active").strip()

    with subtest("without a password there's nothing to lock with"):
        assert as_din(f"sudo -n {lock} status").strip() == "unavailable"
        machine.succeed("systemctl start din-lock")
        assert active_vt() == "tty1", active_vt()

    with subtest("the plain disk doesn't hibernate"):
        machine.succeed("systemctl is-active dinos-hibernation")
        machine.fail("test -e /var/lib/swap/hibernate")
        machine.fail("test -e /run/systemd/logind.conf.d/50-dinos-hibernate.conf")

    machine.succeed("echo 'din:hunter22' | chpasswd")

    with subtest("locking takes the screen, and keeps it"):
        assert as_din(f"sudo -n {lock} status").strip() == "available"
        as_din(f"sudo -n {lock} start")
        machine.wait_until_succeeds("systemctl is-active din-lock")
        assert active_vt() == "tty8", active_vt()
        # chvt waits for a switch that never comes.
        machine.fail("timeout 5 chvt 1")
        assert active_vt() == "tty8", active_vt()
        machine.sleep(3)
        machine.screenshot("locked")

    with subtest("a wrong password doesn't unlock"):
        machine.send_chars("wrong\n")
        machine.sleep(5)
        machine.screenshot("wrong")
        machine.succeed("systemctl is-active din-lock")
        assert active_vt() == "tty8", active_vt()

    with subtest("the right password does"):
        machine.send_chars("hunter22\n")
        machine.wait_until_fails("systemctl is-active din-lock")
        assert active_vt() == "tty1", active_vt()
        machine.succeed("timeout 5 chvt 2 && timeout 5 chvt 1")

    with subtest("waking from hibernation unlocks"):
        machine.succeed("systemctl start din-lock")
        assert active_vt() == "tty8", active_vt()
        machine.succeed("SYSTEMD_SLEEP_ACTION=suspend /etc/systemd/system-sleep/din-lock post suspend-then-hibernate")
        machine.sleep(2)
        machine.succeed("systemctl is-active din-lock")
        machine.succeed("SYSTEMD_SLEEP_ACTION=hibernate /etc/systemd/system-sleep/din-lock post suspend-then-hibernate")
        machine.wait_until_fails("systemctl is-active din-lock")
        assert active_vt() == "tty1", active_vt()
  '';
}

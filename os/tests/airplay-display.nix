{ pkgs, modules, din, deckmon, ngit }:

# Extending the desktop onto an AirPlay receiver: deckmon asks din-shell for a
# display with no screen, which is on the layout like a monitor plugged in,
# streams it to a receiver (UxPlay, here on the same machine), switches the
# session to mirroring and back without reconnecting, and the display goes
# when deckmon does, even when it's killed.
# `nix build ./os#checks.x86_64-linux.airplay-display`; the result has
# screenshots of the display.
pkgs.testers.runNixOSTest {
  name = "dinos-airplay-display";
  node.specialArgs = { inherit din deckmon ngit; };
  nodes.machine = {
    imports = modules;
    environment.systemPackages = [ pkgs.uxplay pkgs.grim pkgs.wlr-randr ];
    virtualisation.memorySize = 4096;
    virtualisation.cores = 4;
    virtualisation.resolution = { x = 1280; y = 800; };
  };

  testScript = ''
    import shlex

    machine.wait_for_unit("multi-user.target")
    machine.wait_until_succeeds("test -e /dev/dri/card0")
    machine.succeed("udevadm settle")

    machine.wait_for_file("/run/user/1000/din-shell")
    machine.wait_until_succeeds("journalctl -b | grep -q \"Din's window is up\"", timeout=180)
    machine.sleep(10)

    def as_din(command):
        env = "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=din-shell; "
        return machine.succeed("su din -c " + shlex.quote(env + command))

    def outputs():
        return as_din("wlr-randr")

    # The user service would be deckmon too; this one logs what it sends.
    # x264, as OpenH264 sends nothing here.
    machine.succeed("systemctl --user -M din@ stop deckmon || true")
    as_din("uxplay -n receiver -nh -p 7200 -vs fakesink -as 0 -reset 0 </dev/null >/tmp/uxplay.log 2>&1 &")
    as_din("deckmon daemon --debug >/tmp/deckmon.log 2>&1 &")
    machine.wait_until_succeeds("grep -q 'listening on' /tmp/deckmon.log")
    machine.wait_until_succeeds("ss -ltn | grep -q ':7201 '")

    try:
        with subtest("mirroring the screen streams"):
            print(as_din("deckmon connect 127.0.0.1 --port 7201 --no-display --output Virtual-1 --no-speaker --no-audio --detach --hwaccel none"))
            machine.wait_until_succeeds("grep -q 'video: captured' /tmp/deckmon.log", timeout=15)
            print(as_din("deckmon disconnect"))

        with subtest("connecting adds a display with no screen"):
            print(as_din("deckmon connect 127.0.0.1 --port 7201 --extend --no-speaker --no-audio --detach --hwaccel none"))
            listed = outputs()
            print(listed)
            assert "HEADLESS-1" in listed, listed
            assert "AirPlay receiver" in listed, listed
            print(as_din("deckmon status"))
            # Din spreads its desktop onto it, as onto a monitor plugged in.
            machine.sleep(10)
            as_din("grim -o HEADLESS-1 /tmp/headless.png")
            machine.copy_from_vm("/tmp/headless.png", "")
            machine.screenshot("screen")
            assert "streaming" in as_din("deckmon status")
            print(machine.succeed("grep -E 'video:|sent [0-9]+ frames' /tmp/deckmon.log | tail -6"))

        with subtest("it can be arranged and resized like any display"):
            as_din("wlr-randr --output HEADLESS-1 --mode 1280x720 --pos 0,800")
            listed = outputs()
            assert "1280x720 px" in listed and "Position: 0,800" in listed, listed
            assert "streaming" in as_din("deckmon status")

        with subtest("switching to mirroring takes it away, and back adds it again"):
            print(as_din("deckmon switch 127.0.0.1 --output Virtual-1"))
            assert "HEADLESS-1" not in outputs()
            print(as_din("deckmon switch 127.0.0.1 --extend"))
            assert "HEADLESS-1" in outputs()
            assert "streaming" in as_din("deckmon status")

        with subtest("it goes with deckmon, however deckmon goes"):
            machine.succeed("pkill -KILL -f 'deckmon daemon'")
            machine.wait_until_succeeds("! su din -c 'XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=din-shell wlr-randr' | grep -q HEADLESS", timeout=10)
    finally:
        print(machine.execute("grep -v trace /tmp/deckmon.log | tail -60")[1])
        print(machine.execute("tail -30 /tmp/uxplay.log")[1])
        print(machine.execute("journalctl -b --no-pager | grep din_compositor | tail -30")[1])
    machine.fail("journalctl -b | grep -i 'din_compositor.*panicked'")
  '';
}

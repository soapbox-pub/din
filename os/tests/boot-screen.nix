{ pkgs, modules, din, deckmon }:

# The boot screen: Plymouth draws Din's theme with the wallpaper and clock
# the initrd hands it, and a password typed at it goes through the keyboard
# layout in vconsole.conf. Run against a Plymouth started by hand after
# boot, so the screenshots in the result show exactly the unlock screen.
# `nix build ./os#checks.x86_64-linux.boot-screen`, then look at result/*.png.
let
  wallpaper = pkgs.runCommand "wallpaper.png" { nativeBuildInputs = [ pkgs.imagemagick ]; } ''
    magick ${din + "/public/wallpaper.jpg"} -resize 1920x1080 $out
  '';
in
pkgs.testers.runNixOSTest {
  name = "dinos-boot-screen";
  node.specialArgs = { inherit din deckmon; };
  nodes.machine = {
    imports = modules;
    systemd.services.din-shell.enable = pkgs.lib.mkForce false;
    # The initrd has its own copy of the font; this is for Plymouth here.
    fonts.packages = [ pkgs.inter ];
    virtualisation.memorySize = 2048;
    virtualisation.resolution = { x = 1280; y = 800; };
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.wait_until_succeeds("test -e /dev/dri/card0")
    machine.succeed("udevadm settle")

    machine.succeed(
        "plymouth quit || true",
        "mkdir -p /run/din-boot",
        "cp /etc/plymouth/themes/din/*.png /run/din-boot/",
        "cp ${wallpaper} /run/din-boot/wallpaper.png",
        # A French keyboard: the physical keys for "azerty" type "qwerty".
        "rm -f /etc/vconsole.conf && echo XKBLAYOUT=fr > /etc/vconsole.conf",
        "chvt 1",
        # The test VM's console is serial, which Plymouth would draw text on.
        "systemd-run --unit=splash plymouthd --no-daemon --mode=boot --tty=/dev/tty1"
        " --kernel-command-line='quiet splash plymouth.ignore-serial-consoles plymouth.debug=stream:/tmp/plymouth.log'",
    )
    machine.wait_until_succeeds("plymouth --ping")
    machine.succeed(
        "plymouth show-splash",
        "plymouth display-message --text='din-clock:09:41|Monday, October 19'",
    )
    machine.sleep(2)
    machine.screenshot("booting")

    machine.succeed("(plymouth ask-for-password --prompt=unlock > /tmp/typed; echo done > /tmp/asked) >/dev/null 2>&1 &")
    machine.sleep(3)
    machine.screenshot("asking")
    machine.send_chars("azer")
    machine.sleep(1)
    machine.screenshot("typing")
    machine.send_chars("ty\n")
    machine.wait_for_file("/tmp/asked")
    print(machine.succeed("grep -vE 'ply_key_file|ply_event_loop|ply_boot_server|ply-buffer' /tmp/plymouth.log | tail -n 120 | cut -c 14-220"))
    typed = machine.succeed("cat /tmp/typed").strip()
    assert typed == "qwerty", f"typed {typed!r}"

    # Once root is mounted the lock screen goes and the logo and progress
    # bar stay, as Din's boot veil takes them over.
    machine.succeed("plymouth update-root-fs --new-root-dir=/")
    machine.sleep(3)
    machine.screenshot("unlocked")
  '';
}

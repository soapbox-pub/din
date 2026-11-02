{ pkgs, ... }:

# Remote access for debugging DinOS on real hardware: `nix build ./os#debug-image`.
# Never part of the shipped image. sshd takes keys only, and none are baked
# in - the authorized key (and any WiFi profile) is added to the written
# stick, so nothing secret lands in the store or the repo. The machine
# announces itself as dinos.local. grim screenshots the screen; wtype and
# wlrctl type and click into it (all with WAYLAND_DISPLAY=din-shell, Din's
# compositor's socket).
{
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  services.avahi = {
    enable = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      addresses = true;
    };
  };

  environment.systemPackages = with pkgs; [ grim wtype wlrctl ];

  # The compositor offers wtype and wlrctl a virtual keyboard and pointer only
  # here: anywhere else, any process of din's could drive Din with them.
  systemd.services.din-shell.environment.DIN_COMPOSITOR_VIRTUAL_INPUT = "1";
}

{ pkgs, ... }:

# Remote access for debugging DinOS on real hardware: `nix build ./os#debug-image`.
# Never part of the shipped image. sshd takes keys only, and none are baked
# in - the authorized key (and any WiFi profile) is added to the written
# stick, so nothing secret lands in the store or the repo. The machine
# announces itself as dinos.local. grim screenshots cage's output; wtype and
# wlrctl type and click into it.
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
}
